import { assertIhpcState } from "./protocol.js"; // Phase B canonical export: Ajv-validate STATE, throw if invalid
import { nodeStatusToRunStatus } from "./status.js"; // CP-4: shared status map (also used by D's adopt.ts)
import type { ComputeProfile, RunRecord } from "../../../core/types.js";

// CP-2: the canonical reconcile seam signature, shared verbatim with Phase D's consumer (D Task 5).
// Param names are pinned here so D only WIRES, never reshapes: profileId + node + relaunchProgressor +
// progressorAlive (uniform with D), plus auditDir + an injectable adopt hook (adoptLiveJob) so the
// dead-progressor-but-live-jobs branch can synthesize lineage-proven RunRecords (spec 5c) — D supplies
// the real adopt hook; C's own test supplies a stub.
export interface ReconcileInput {
  campaignId: string;
  profileId: string;
  profile: ComputeProfile;
  node: string;
  // started_at_node (optional): the node-clock launch label the brain recorded the FIRST time it saw
  // this run live (from the STATE job, persisted onto supervisor.started_at). It is the anti-pid-reuse
  // pairing evidence (spec 2.5): on a later reconcile the brain requires the node's freshly-reported
  // started_at_node to MATCH it before re-asserting `running` — a node reboot can recycle the OS pid onto
  // a foreign process, so a bare "STATE says running" is not proof the SAME job still runs.
  runRecords: Array<Partial<RunRecord> & { run_id: string; status: RunRecord["status"]; started_at_node?: string }>;
}

// One STATE job entry as the node writes it (spec 2.3). wrapper_pid is the slot-supervisor-of-record
// pid (CP-3); pid is the inner job pid.
export interface NodeStateJob {
  seq: number; run_id: string; status: string; pid: number | null; wrapper_pid?: number;
  gpu_index: number; exit_code?: number; started_at_node: string; finished_at_node?: string; log: string;
}

export interface ReconcileDeps {
  now: Date;
  // ONE read of state.json, whole-file, atomic-rename-safe; NEVER tail (spec 2.3).
  readState: (host: string, node: string, campaignId: string) => Promise<unknown>;
  persistRunRecord: (rec: Partial<RunRecord> & { run_id: string }) => void;
  // dead-progressor-but-live-jobs (spec 5c): relaunch the progressor with the same plan.
  relaunchProgressor: (host: string, node: string, campaignId: string) => Promise<{ pid: number }>;
  // optional liveness probe for progressor.pid (kill -0 on the node); if absent, trust STATE heartbeat.
  progressorAlive?: (host: string, node: string, pid: number) => Promise<boolean>;
  // CP-3/D-3: optional adopt hook. When the dead-progressor branch fires, each live STATE job is
  // adopted as a lineage-proven RunRecord (D supplies an ihpcStateJobToRunRecord-backed hook + auditDir;
  // C's branch then persists it). Absent => relaunch-only (C's standalone behavior). The ctx carries the
  // STATE top-level lineage anchors (queueId + leaseOwner) so the hook can PROVE lineage (STATE queue_id
  // + lease_owner == a RunRecord we hold) before adopting (spec §5a); a non-lineage-proven job returns
  // null and is left to the history-only path (§5b). The job's wrapper_pid (CP-3) is the supervisor of
  // record — the hook uses it, never the dead progressor pid.
  adoptLiveJob?: (
    job: NodeStateJob,
    ctx: { campaignId: string; profileId: string; node: string; now: Date; queueId: string; leaseOwner: { client: string; device_id: string } }
  ) => (Partial<RunRecord> & { run_id: string }) | null;
  auditDir?: string;
}

export interface ReconcileResult {
  observed_at: string;
  campaign_id: string;
  transitions: Array<{ run_id: string; status: RunRecord["status"] }>;
  needs_reconciliation: Array<{ run_id: string; message: string }>;
  progressor_restarted: boolean;
}

export async function reconcileIhpcCampaign(input: ReconcileInput, deps: ReconcileDeps): Promise<ReconcileResult> {
  const host = input.profile.login.host_alias;
  const raw = await deps.readState(host, input.node, input.campaignId);
  assertIhpcState(raw); // throws on a malformed STATE (spec 3.4)
  const state = raw as {
    queue_id: string;
    lease_owner: { client: string; device_id: string };
    progressor: { pid: number; heartbeat_node: string };
    jobs: Record<string, NodeStateJob>;
  };

  const transitions: ReconcileResult["transitions"] = [];
  const needs: ReconcileResult["needs_reconciliation"] = [];
  const byRunId = new Map(Object.values(state.jobs).map((j) => [j.run_id, j]));

  for (const record of input.runRecords) {
    const observed = byRunId.get(record.run_id);
    if (!observed) {
      needs.push({ run_id: record.run_id, message: "run not present in node STATE" });
      continue;
    }
    const mapped = nodeStatusToRunStatus(observed.status); // CP-4: shared mapper
    if (observed.status === "placement_conflict") {
      needs.push({ run_id: record.run_id, message: "placement_conflict — brain must re-place" });
    }
    // ANTI-PID-REUSE agreement (spec 2.5): before re-asserting a node-reported LIVE pid as `running`,
    // require the started_at_node pairing to agree. A node reboot can recycle the OS pid onto a foreign
    // process, so "STATE says running" is NOT proof the SAME job runs. Two fail-closed downgrades:
    //   (a) the node reports `running`/`launching` but OMITS started_at_node entirely -> we cannot prove
    //       continuity -> needs_reconciliation (never assert running on absent pairing evidence);
    //   (b) we recorded the run's started_at_node on a PRIOR observation and the node now reports a
    //       DIFFERENT one -> a recycled pid -> needs_reconciliation (do not believe the reused pid).
    // The matching case (and the first-ever observation, where we have no prior evidence) persists the
    // mapped status verbatim AND records started_at_node so a future pass can verify continuity.
    const asserts_live = mapped === "running";
    const prior = record.started_at_node; // the started_at_node the adapter threaded from supervisor.started_at
    const observedStart = observed.started_at_node;
    // `started_at_node` is the wire pairing label, NOT a RunRecord field — it must never be written
    // verbatim onto the record (it would fail schema validation). We only READ it here to verify
    // continuity; the DURABLE home for this evidence is supervisor.started_at, written by the adopt
    // primitive (ihpcStateJobToRunRecord). So we strip it from the merge payload on every branch.
    const { started_at_node: _drop, ...recordNoStart } = record;
    if (asserts_live && !observedStart) {
      needs.push({ run_id: record.run_id, message: "running but no started_at_node — cannot verify pid continuity (anti-pid-reuse)" });
      deps.persistRunRecord({ ...recordNoStart, status: "unknown", updated_at: deps.now.toISOString() });
      transitions.push({ run_id: record.run_id, status: "unknown" });
      continue;
    }
    if (asserts_live && prior && observedStart && prior !== observedStart) {
      needs.push({ run_id: record.run_id, message: "started_at_node changed — recycled pid, not the same process (anti-pid-reuse)" });
      deps.persistRunRecord({ ...recordNoStart, status: "unknown", updated_at: deps.now.toISOString() });
      transitions.push({ run_id: record.run_id, status: "unknown" });
      continue;
    }
    // Clock-offset rule (spec 2.3): we treat *_at_node timestamps as opaque labels; we do NOT
    // compute laptop-now minus a node timestamp. We persist node-stamped fields verbatim.
    deps.persistRunRecord({ ...recordNoStart, status: mapped, updated_at: deps.now.toISOString() });
    transitions.push({ run_id: record.run_id, status: mapped });
  }

  // dead-progressor-but-live-jobs (spec 2.6 / 5c): if the progressor pid is dead but jobs are still
  // running, relaunch the SAME progressor to resume refill (markers + lease prove lineage). If an
  // adopt hook is supplied (D Task 5), each live STATE job is ALSO adopted as a lineage-proven
  // RunRecord before relaunch (CP-3/D-3) — this is the branch D wires, not reshapes.
  let restarted = false;
  const liveJobs = Object.values(state.jobs).some((j) => j.status === "running" || j.status === "launching");
  if (liveJobs && deps.progressorAlive) {
    const alive = await deps.progressorAlive(host, input.node, state.progressor.pid);
    if (!alive) {
      if (deps.adoptLiveJob) {
        for (const job of Object.values(state.jobs)) {
          if (job.status === "running" || job.status === "launching") {
            // The hook proves lineage (STATE queue_id + lease_owner == a held RunRecord) and builds a
            // lineage-proven record via ihpcStateJobToRunRecord with the slot wrapper_pid (CP-3). A null
            // return means lineage was NOT proven (foreign / unproven) — leave it to the §5b path.
            const adopted = deps.adoptLiveJob(job, {
              campaignId: input.campaignId,
              profileId: input.profileId,
              node: input.node,
              now: deps.now,
              queueId: state.queue_id,
              leaseOwner: state.lease_owner
            });
            if (adopted) deps.persistRunRecord(adopted);
          }
        }
      }
      await deps.relaunchProgressor(host, input.node, input.campaignId);
      restarted = true;
    }
  }

  return {
    observed_at: deps.now.toISOString(),
    campaign_id: input.campaignId,
    transitions,
    needs_reconciliation: needs,
    progressor_restarted: restarted
  };
}
