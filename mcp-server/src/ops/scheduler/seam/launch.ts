import { PROGRESSOR_PY } from "../node/progressor-source.js";
import { assertIhpcPlan } from "./protocol.js"; // Phase B canonical export: Ajv-validate the PLAN, throw if invalid
import type { ComputeProfile, IhpcPlan, NodeSchedulerConfig, RunRecord } from "../../../core/types.js";

// PLAN/STATE live under the profile-root scheduler dir, NEVER /tmp (spec 2.2). The remote home is
// resolved by the node ($HOME); we ship the relative tail and let the node expand it.
function planRemotePath(campaignId: string): string {
  return `~/.uts-computing/scheduler/state/${campaignId}/plan.json`;
}

// CP-5: the canonical PLAN type (Phase B core/types.ts `IhpcPlan`) carries campaign_id: string | null.
// The campaign launch path requires a NON-null campaign_id (assertIhpcPlan would reject otherwise), and
// the single-run fast path is keyed on the ABSENCE of a campaign. So we model the launch input as a
// discriminated union: a campaign PLAN that IS the canonical IhpcPlan with a string campaign_id, OR a
// SingleRunSpec that pins campaign_id to null and is never fed to assertIhpcPlan. This keeps the
// campaign path type-checked against the real PLAN type and prevents field drift at compile time.
export type PlanObject = IhpcPlan | SingleRunSpec;

// SingleRunSpec mirrors IhpcPlan's shape but pins campaign_id to null (the fast-path discriminant).
export interface SingleRunSpec extends Omit<IhpcPlan, "campaign_id"> {
  campaign_id: null;
}

export interface LaunchDeps {
  now: Date;
  sshWriteAtomicJson: (host: string, node: string, remotePath: string, obj: unknown) => Promise<void>;
  startProgressor: (host: string, node: string, stdin: string) => Promise<{ pid: number }>;
  startSingleSupervisor?: (host: string, node: string, job: PlanObject["jobs"][number]) => Promise<{ pid: number; node_id: string }>;
  persistRunRecord: (rec: RunRecord) => void;
  auditDir?: string;
}

export interface LaunchInput {
  plan: PlanObject;
  // NOTE: `node_scheduler.runner` is plumbed here but currently UNUSED — the default path daemonizes the
  // progressor on the node (python-side fork/setsid) regardless of runner; wiring runner variants
  // (console/uv/cron_reboot) is deferred to a later task.
  profile: ComputeProfile & { node_scheduler?: NodeSchedulerConfig };
}

export interface LaunchResult {
  mode: "campaign" | "single";
  campaign_id: string | null;
  progressor: { pid: number | null };
}

// spec 6 D1: keep the single-run FAST PATH. jobs==1 AND no campaign -> direct SUPERVISOR_PY, no PLAN,
// no resident progressor. This keeps the most-common path off the whole new mechanism. The discriminant
// is `campaign_id === null` (the SingleRunSpec branch of the union); this also type-narrows `plan`.
function isSingleRunFastPath(plan: PlanObject): plan is SingleRunSpec {
  return plan.campaign_id === null && plan.jobs.length === 1;
}

export async function launchIhpcCampaign(input: LaunchInput, deps: LaunchDeps): Promise<LaunchResult> {
  const { plan, profile } = input;
  const host = profile.login.host_alias;
  const node = plan.node_id;

  if (isSingleRunFastPath(plan) && deps.startSingleSupervisor) {
    const started = await deps.startSingleSupervisor(host, node, plan.jobs[0]);
    const job = plan.jobs[0];
    deps.persistRunRecord(buildRunRecord(plan, job, started.pid, started.node_id, deps.now, 0));
    return { mode: "single", campaign_id: null, progressor: { pid: null } };
  }

  // Campaign path: campaign_id is non-null here (the fast path consumed the null case). Validate the
  // canonical PLAN (spec 2.2) — assertIhpcPlan is the Phase B Ajv gate and would REJECT a campaign_id:null
  // plan, which is why the fast path is split off ABOVE this line. Then atomically write the immutable
  // PLAN, start the progressor once for the node (spec 3.3), persist placement/supervisor/lease per run.
  if (plan.campaign_id === null) {
    // a null-campaign PLAN with !=1 jobs is a programming error: a campaign MUST have a campaign_id.
    throw new Error("launchIhpcCampaign: multi-job launch requires a non-null campaign_id");
  }
  const campaignPlan: IhpcPlan = plan; // narrowed: campaign_id is string
  assertIhpcPlan(campaignPlan);
  // P1 (crash-safety — mirror the single-run "submitting" bracket): persist each selected run's RunRecord
  // at the durable pre-launch marker BEFORE any non-idempotent SSH side effect (the PLAN write AND the
  // progressor start). The marker carries the recoverable campaign_id + the target node (placement), so a
  // crash anywhere in the launch window — PLAN written / progressor maybe started, but the final "running"
  // persist never lands — leaves a RECONCILABLE record (jobs.track's campaign path reads node STATE by
  // campaign_id and advances it), never an invisible orphan that was never written or a falsely-"running"
  // record over a queue that never started. This is the exact analogue of submit.ts / ihpc-start.ts
  // persisting status "submitting" before qsub / the supervisor start. The supervisor pid is unknown here
  // (the progressor forks it later), so the marker omits supervisor and pins the node onto placement.
  campaignPlan.jobs.forEach((job) => {
    deps.persistRunRecord(buildPreLaunchMarker(campaignPlan, job, node, deps.now));
  });
  await deps.sshWriteAtomicJson(host, node, planRemotePath(campaignPlan.campaign_id as string), campaignPlan);
  const started = await deps.startProgressor(host, node, PROGRESSOR_PY);
  // P0: the progressor DAEMONIZES on the node (python-side fork/setsid) and its foreground parent prints
  // the daemon child's real pid before exiting, so the SSH channel closes under the timeout while the loop
  // survives. A real, non-zero pid is therefore the proof the daemon launched. A pid <= 0 means the parent
  // never reported a daemon (e.g. a foreground-killed start at the SSH timeout): we must NOT persist
  // RunRecords claiming "running" with supervisor pid=0 over a queue that has actually stalled — surface
  // it as a launch failure instead. (start.ts's startProgressor binding also guards this on the real SSH
  // path; this seam-level check additionally protects every caller / mock that bypasses that binding.)
  if (!Number.isInteger(started.pid) || started.pid <= 0) {
    throw new Error(
      `campaign progressor did not report a daemon pid (got ${String(started.pid)}); the node-side ` +
      `fork/setsid daemonization must print a real pid before the SSH channel closes — refusing to ` +
      `record a stalled launch with supervisor pid=0`
    );
  }
  campaignPlan.jobs.forEach((job, idx) => {
    deps.persistRunRecord(buildRunRecord(campaignPlan, job, started.pid, node, deps.now, idx));
  });
  return { mode: "campaign", campaign_id: campaignPlan.campaign_id as string, progressor: { pid: started.pid } };
}

// C-6: campaign-job supervisor paths are PATH-BASED (the slot dir), not empty strings. requireIhpcSupervisor
// + the run-record schema expect populated metadata/stdout/stderr; for a campaign run the "supervisor of
// record" is the slot directory under the campaign state dir (the per-slot wrapper, NOT the dead-able
// progressor pid — see CP-3). This LAUNCH-side derivation builds the paths from the campaign_id + the
// job's seq (the slot is known before the node has reported anything). The ADOPT side (adopt.ts
// `slotPathsFromLog`) derives the SAME paths by a DIFFERENT mechanism — from the STATE-reported job.log
// directory — because at adopt time the node has already chosen the slot. The two are intentionally NOT a
// shared function (different inputs/signatures); they must only stay convention-compatible about where a
// campaign run's logs live.
export function resolveSlotSupervisorPaths(campaignId: string, seq: number): {
  metadata_path: string; stdout_path: string;
} {
  const slotDir = `~/.uts-computing/scheduler/state/${campaignId}/slot_${seq}`;
  return { metadata_path: `${slotDir}/result.json`, stdout_path: `${slotDir}/stdout.log` };
}

// P1: the DURABLE pre-launch marker (status "submitting"), written for each campaign job BEFORE the SSH
// side effects. It mirrors the single-run paths' "submitting" record: enough recoverable evidence for
// jobs.track to reconcile it against node STATE — the campaign_id (the STATE key) and the target node
// (placement, since the per-pid supervisor is not yet known) — but no supervisor/remote_job_id, because
// the progressor pid does not exist until startProgressor returns. The success path then OVERWRITES this
// same run_id with the full "running" record (buildRunRecord) once the daemon pid is in hand.
function buildPreLaunchMarker(plan: IhpcPlan, job: IhpcPlan["jobs"][number], nodeId: string, now: Date): RunRecord {
  return {
    run_id: job.run_id,
    profile_id: plan.profile_id,
    platform: "uts-ihpc",
    campaign_id: plan.campaign_id as string,
    status: "submitting",
    queue_position: job.seq,
    lease_owner: plan.lease_owner,
    // The node is the only launch-target field knowable before the progressor forks the slot wrapper;
    // placement only requires hostname, so this validates while staying supervisor-free (pid unknown).
    placement: { hostname: nodeId, node_id: nodeId, gpu_index: job.gpu_index, gpu_slot: job.gpu_index, slots_per_gpu: plan.limits.max_slots_per_gpu, started_at: now.toISOString() },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    events: [{ at: now.toISOString(), kind: "ihpc-progressor-launch-attempt", summary: `Submitting run ${job.run_id} (seq ${job.seq}) under campaign ${plan.campaign_id} — durable pre-launch marker before PLAN write / progressor start` }]
  } as RunRecord;
}

function buildRunRecord(
  plan: PlanObject, job: PlanObject["jobs"][number], progressorPid: number,
  nodeId: string, now: Date, queuePosition: number
): RunRecord {
  // CP-3: gpu_slot is the brain's pre-accounting slot; thread it onto placement.gpu_slot (Phase B added
  // the field) so it is not dead. The per-slot wrapper pid is NOT known at launch (the progressor forks it
  // later and records it in STATE jobs[<seq>].wrapper_pid); the supervisor block here references the slot
  // dir path-based, and reconcile/adopt resolve the live wrapper_pid from STATE when needed.
  const slotPaths = plan.campaign_id
    ? resolveSlotSupervisorPaths(plan.campaign_id, job.seq)
    : { metadata_path: "", stdout_path: "" }; // single-run fast path keeps SUPERVISOR_PY's own paths (set by startSingleSupervisor's caller)
  // stderr_path below is intentionally aliased to stdout_path: the node merges both streams into stdout.log.
  return {
    run_id: job.run_id,
    profile_id: plan.profile_id,
    platform: "uts-ihpc",
    remote_job_id: `ihpc-${job.run_id}-${progressorPid}`,
    campaign_id: plan.campaign_id ?? undefined,
    status: "running",
    queue_position: queuePosition,
    lease_owner: plan.lease_owner,
    supervisor: { pid: progressorPid, node_id: nodeId, metadata_path: slotPaths.metadata_path, stdout_path: slotPaths.stdout_path, stderr_path: slotPaths.stdout_path, started_at: now.toISOString() },
    placement: { hostname: nodeId, node_id: nodeId, gpu_index: job.gpu_index, gpu_slot: job.gpu_index, slots_per_gpu: plan.limits.max_slots_per_gpu, started_at: now.toISOString() },
    created_at: now.toISOString(),
    updated_at: now.toISOString(),
    events: [{ at: now.toISOString(), kind: "ihpc-progressor-launch", summary: `Queued run ${job.run_id} (seq ${job.seq}) under campaign ${plan.campaign_id}` }]
  } as RunRecord;
}
