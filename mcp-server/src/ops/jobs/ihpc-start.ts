import { assertSafeApprovalId, assertSafeRunId, isSafeRemoteToken } from "../../core/ids.js";
import { sshSupervisorArgs } from "../../lib/ssh.js";
import path from "node:path";
import { runProcess } from "../../lib/process.js";
import { pyImports, PY_FAIL_FIXED, PY_DECODE_SPEC } from "../../lib/remote-python.js";
import { assertSafeRemotePathTemplate, assertSafeSshTarget, encodeSpec, isInsideRemoteRoot, normalizeTimeout, sshTimeoutSeconds } from "../../lib/shared.js";
import { readRunRecord, updateRunRecord } from "../../core/audit.js";
import { maskHostAlias, summarizeRemoteFailure } from "../../lib/redact.js";
import { approvalStatus, consumeApproval, readFreshQuotaSnapshot } from "../approvals/approvals.js";
import { parseCommandArgv } from "../plans/command-argv.js";
import { getProfile, maskUserRootPath, userRootPrefixes, buildSubmissionContext } from "../../core/config.js";
import { readVerifiedPlan } from "../plans/plan-store.js";
import { assertApprovalUsableForPlan, expectedApprovalOperationForPlan } from "../approvals/submission-approval.js";
import { inferNodeFamily } from "../quotas/quota-limits.js";
import { checkIhpcNodePoolConformance } from "../quotas/conformance.js";
import { PLATFORM } from "../../core/types.js";
import type { ApprovalRecord, ComputeProfile, PlannedJob, QuotaSnapshot, SubmitResult } from "../../core/types.js";

export interface IhpcStartOptions {
  timeoutMs?: number;
  executor?: IhpcStartExecutor;
  planDir?: string;
  auditDir?: string;
  approvalDir?: string;
  configPath?: string;
  now?: Date;
}

export type IhpcStartExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin: string
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

interface SupervisorSpec {
  run_id: string;
  workdir: string;
  log_dir: string;
  stdout_path: string;
  stderr_path: string;
  pid_path: string;
  metadata_path: string;
  command_argv: string[];
  allowed_roots: string[];
}

interface SupervisorStart {
  pid: number;
  metadata_path: string;
  stdout_path: string;
  stderr_path: string;
  started_at?: string;
}

// Timeout policy (per-module, deliberate): standard 10s default / 30s cap shared by the middle
// modules. Named consts so the policy stays explicit, not folded into a shared bound.
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;

export async function startIhpcRun(
  input: { runId: string; approvalId?: string; quotaSnapshotId?: string },
  options: IhpcStartOptions = {}
): Promise<{ submission: SubmitResult }> {
  assertSafeRunId(input.runId);
  if (input.approvalId !== undefined) {
    assertSafeApprovalId(input.approvalId);
  }
  const now = options.now ?? new Date();
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultIhpcStartExecutor;

  const plan = readVerifiedPlan(input.runId, options.planDir);
  if (plan.platform !== PLATFORM.IHPC) {
    throw new Error(`iHPC supervised start requires an uts-ihpc plan, got ${plan.platform}`);
  }
  assertIhpcSingleProcessResources(plan);
  const runRecord = readRunRecord(plan.run_id, options.auditDir);
  const expectedOperation = expectedApprovalOperationForPlan(plan, runRecord);
  const profile = getProfile(plan.profile_id, options.configPath);
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`Profile ${profile.profile_id} is for ${profile.platform}, but iHPC start requires uts-ihpc`);
  }
  const userPrefixes = userRootPrefixes(profile);

  // iHPC supervised start is autonomous: conformance is that a fresh snapshot exposes an active
  // compute node for the planned node_family (selectActiveComputeNode below). A token is optional.
  //
  // BAN-CRITICAL EVIDENCE (P0): the node-pool gate below MUST evaluate against CONSUME-TIME-FRESH
  // held-node evidence, never an approval's bound snapshot. An approval now lives up to 24h (its
  // lifetime was decoupled from the snapshot's 15-min TTL), so its bound snapshot's `active_nodes`
  // can be up to 24h stale — an approval minted at 0 held, consumed when the account is already AT
  // the pool cap, would pass the gate against stale evidence and push the real pool over its limit
  // (account BAN). So even on the approval path we require a FRESH quotaSnapshotId and read ITS held
  // nodes for the gate, EXACTLY as campaign.submit does. The approval's identity binding to its
  // ORIGINAL snapshot (plan_hash + quota_snapshot_id, consumed below) is UNCHANGED — only the held-
  // node EVIDENCE the ban gate sees is taken from the fresh snapshot. Fail closed: a present approval
  // with NO fresh quotaSnapshotId is REFUSED, never silently falling back to the stale approval
  // snapshot. readFreshQuotaSnapshot throws if the snapshot is >15 min old (the existing window),
  // forcing genuinely fresh evidence.
  let approval: ApprovalRecord | undefined;
  let quotaSnapshotId: string;
  if (input.approvalId) {
    approval = approvalStatus({ approvalId: input.approvalId }, { approvalDir: options.approvalDir, now }).approval;
    assertApprovalUsableForPlan(approval, plan.run_id, plan.profile_id, plan.platform, plan.plan_hash, expectedOperation);
    if (!input.quotaSnapshotId) {
      throw new Error(
        "iHPC supervised start with an approval still requires a fresh quotaSnapshotId for the ban-critical node-pool gate: the approval's bound snapshot may be up to 24h stale and cannot be trusted for held-node evidence"
      );
    }
    quotaSnapshotId = input.quotaSnapshotId;
  } else {
    if (!input.quotaSnapshotId) {
      throw new Error("iHPC supervised start requires either an approvalId or a fresh quotaSnapshotId for autonomous conformance");
    }
    quotaSnapshotId = input.quotaSnapshotId;
  }
  // Always read the GATE snapshot FRESH (throws if stale), whether or not an approval supplied
  // authorization — the held-node evidence (active compute node selection + node-pool occupancy) is
  // consume-time evidence, not approval-bound. The non-approval path is unchanged (it already read
  // fresh here).
  const quotaSnapshot = readFreshQuotaSnapshot(quotaSnapshotId, plan.profile_id, plan.platform, now);
  const computeNode = selectActiveComputeNode(quotaSnapshot, plan, quotaSnapshotId);

  // HARD per-account iHPC node-pool gate (the iHPC analogue of submit.ts's PBS gate, and the real
  // ban-prevention): refuse if using this account's target node would push its OWN node-pool over
  // the cap configured in the profile's defaults.node_limits. This checks ONE profile against its
  // own held nodes and NEVER sums across accounts. With no node_limits configured there is no
  // enforceable cap — the operator must set it from the portal "My Node Limits" (not SSH-queryable).
  const poolConformance = checkIhpcNodePoolConformance({
    targetNode: computeNode,
    nodeLimits: profile.defaults.node_limits,
    activeNodes: snapshotActiveNodes(quotaSnapshot)
  });
  if (!poolConformance.conforms) {
    const detail = poolConformance.violations.map((v) => v.message).join("; ");
    throw new Error(`iHPC node-pool conformance failed for ${plan.profile_id}: ${detail}`);
  }

  if (runRecord.status !== "planned") {
    throw new Error(`Run ${plan.run_id} is ${runRecord.status}; only planned iHPC runs can be started`);
  }

  // Persist a durable "submitting" marker BEFORE starting the remote supervisor (mirrors submit.ts):
  // a crash between a successful start and the final write leaves "submitting" evidence for
  // reconciliation, never a silently-orphaned supervised process.
  runRecord.status = "submitting";
  runRecord.plan_hash = plan.plan_hash;
  runRecord.quota_snapshot_id = quotaSnapshotId;
  runRecord.updated_at = now.toISOString();
  runRecord.events.push({
    at: now.toISOString(),
    kind: "ihpc-live-start-attempt",
    summary: `Starting supervised UTS iHPC run (node ${computeNode})`,
    redacted_command: "ssh <profile-host> ssh <ihpc-compute-node> python3 - <supervisor-spec>"
  });
  updateRunRecord(runRecord, options.auditDir);

  const supervisorSpec = buildSupervisorSpec(plan, profile);
  const encodedSpec = encodeSpec(supervisorSpec);
  const args = sshSupervisorArgs(profile.login.host_alias, computeNode, timeoutMs, encodedSpec);
  const result = await executor("ssh", args, timeoutMs, SUPERVISOR_PY);
  if (result.exitCode !== 0) {
    throw new Error(summarizeStartFailure(result));
  }
  const supervisor = parseSupervisorStart(result.stdout);
  const remoteJobId = `ihpc-${plan.run_id}-${supervisor.pid}`;

  // Persist the remote job id immediately, before consuming the approval.
  runRecord.remote_job_id = remoteJobId;
  runRecord.updated_at = now.toISOString();
  updateRunRecord(runRecord, options.auditDir);

  if (approval) {
    consumeApproval(
      {
        approvalId: approval.approval_id,
        runId: plan.run_id,
        profileId: plan.profile_id,
        platform: plan.platform,
        operation: expectedOperation,
        planHash: plan.plan_hash,
        quotaSnapshotId: approval.quota_snapshot_id,
        consumedBy: `${expectedOperation}:${remoteJobId}`
      },
      { approvalDir: options.approvalDir, now }
    );
  }

  runRecord.status = "running";
  runRecord.remote_job_id = remoteJobId;
  runRecord.updated_at = now.toISOString();
  runRecord.plan_hash = plan.plan_hash;
  runRecord.quota_snapshot_id = quotaSnapshotId;
  runRecord.approval = approval
    ? {
        state: "approved",
        approved_at: approval.decided_at,
        approved_by: approval.decided_by,
        bound_plan_hash: plan.plan_hash,
        bound_quota_snapshot_id: approval.quota_snapshot_id
      }
    : {
        state: "not_required",
        reason: `autonomous conformance vs ${quotaSnapshotId} (node ${computeNode})`,
        bound_plan_hash: plan.plan_hash,
        bound_quota_snapshot_id: quotaSnapshotId
      };
  runRecord.supervisor = {
    pid: supervisor.pid,
    node_id: computeNode,
    metadata_path: supervisorSpec.metadata_path,
    stdout_path: supervisorSpec.stdout_path,
    stderr_path: supervisorSpec.stderr_path,
    started_at: supervisor.started_at ?? now.toISOString()
  };
  runRecord.submission = buildSubmissionContext(
    profile,
    plan.normalized_job_spec.resources,
    runRecord.supervisor.started_at ?? now.toISOString(),
    computeNode
  );
  runRecord.events.push({
    at: now.toISOString(),
    kind: expectedOperation === "jobs.retry" ? "ihpc-live-retry-start" : "ihpc-live-start",
    summary:
      expectedOperation === "jobs.retry"
        ? `Started retry supervised UTS iHPC run ${remoteJobId}`
        : `Started supervised UTS iHPC run ${remoteJobId}`,
    redacted_command: "ssh <profile-host> ssh <ihpc-compute-node> python3 - <supervisor-spec>"
  });
  const runRecordPath = updateRunRecord(runRecord, options.auditDir);

  return {
    submission: {
      mode: "live",
      run_id: plan.run_id,
      profile_id: plan.profile_id,
      platform: plan.platform,
      status: "running",
      remote_job_id: remoteJobId,
      ...(approval ? { approval_id: approval.approval_id } : {}),
      plan_hash: plan.plan_hash,
      quota_snapshot_id: quotaSnapshotId,
      submitted_at: now.toISOString(),
      command: {
        program: "ssh",
        args: redactSshArgs(args, profile.login.host_alias, computeNode, encodedSpec),
        remote_argv: ["ssh", "<ihpc-compute-node>", "python3", "-", "<supervisor-spec>"]
      },
      supervisor: {
        pid: supervisor.pid,
        node_id: computeNode,
        metadata_path: maskUserRootPath(supervisor.metadata_path, userPrefixes),
        stdout_path: maskUserRootPath(supervisor.stdout_path, userPrefixes),
        stderr_path: maskUserRootPath(supervisor.stderr_path, userPrefixes)
      },
      run_record_path: runRecordPath
    }
  };
}

// H6/H7: ihpc-start runs ONE process on ONE node. Multi-GPU / array / fan-out belongs to the
// on-node scheduler, not here — silently running a multi-GPU command once would waste the campaign.
function assertIhpcSingleProcessResources(plan: PlannedJob): void {
  const r = plan.normalized_job_spec.resources ?? {};
  if (r.array) {
    throw new Error(
      "ihpc-start runs a single process on one node and does not support array/sweep jobs. " +
        "For multi-GPU or fan-out workloads, plan the runs under one shared campaignId (jobs.plan), then launch them as a campaign via campaign.submit (the internalized scheduler progresses them on the node)."
    );
  }
  if (typeof r.ngpus === "number" && r.ngpus > 1) {
    throw new Error(
      "ihpc-start is single-GPU (one process, one node); ngpus>1 would not fan out. " +
        "Use the internalized scheduler: plan the runs under one campaignId (jobs.plan), then campaign.submit."
    );
  }
}

function buildSupervisorSpec(plan: PlannedJob, profile: ComputeProfile): SupervisorSpec {
  const jobSpec = plan.normalized_job_spec;
  const workdir = jobSpec.workdir;
  if (!workdir) {
    throw new Error("iHPC plan requires a workdir before live start");
  }
  assertSafeRemotePathTemplate(workdir, "workdir");
  const roots = [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project].filter((value): value is string =>
    Boolean(value)
  );
  if (!roots.length || !roots.some((root) => isInsideRemoteRoot(workdir, root))) {
    throw new Error("iHPC workdir must be inside profile workspace, scratch, or project roots");
  }
  for (const root of roots) {
    assertSafeRemotePathTemplate(root, "profile root");
  }

  const commandArgv = parseCommandArgv(jobSpec.command);
  if (!plan.command_argv?.length) {
    throw new Error("iHPC live start requires a saved command_argv from jobs.plan");
  }
  if (JSON.stringify(plan.command_argv) !== JSON.stringify(commandArgv)) {
    throw new Error("Saved iHPC command_argv does not match the normalized command");
  }
  const logDir = `${workdir.replace(/\/$/, "")}/logs`;
  const runId = plan.run_id;
  return {
    run_id: runId,
    workdir,
    log_dir: logDir,
    stdout_path: `${logDir}/${runId}.out`,
    stderr_path: `${logDir}/${runId}.err`,
    pid_path: `${logDir}/${runId}.pid`,
    metadata_path: `${logDir}/${runId}.supervisor.json`,
    command_argv: plan.command_argv,
    allowed_roots: roots
  };
}

function selectActiveComputeNode(snapshot: QuotaSnapshot, plan: PlannedJob, quotaSnapshotId: string): string {
  if (snapshot.snapshot_id !== quotaSnapshotId) {
    throw new Error("Quota snapshot does not match the planned iHPC run");
  }
  if (snapshot.profile_id !== plan.profile_id || snapshot.platform !== PLATFORM.IHPC) {
    throw new Error("Quota snapshot does not match the planned iHPC profile");
  }
  const sessions = snapshot.summary.sessions as { observed?: unknown; active_session_count?: unknown; active_nodes?: unknown } | undefined;
  if (sessions?.observed !== true || typeof sessions.active_session_count !== "number" || sessions.active_session_count < 1) {
    throw new Error("iHPC live start requires a fresh quota snapshot with an active cnode session");
  }
  const activeNodes = parseActiveNodes(sessions);
  if (!activeNodes.length) {
    throw new Error("iHPC live start requires cnode mynodes evidence with an active compute node id");
  }
  const requestedFamily = plan.normalized_job_spec.resources.node_family;
  const nodeFamilies = snapshot.summary.node_families as
    | { observed?: unknown; available_families?: unknown; all_families?: unknown }
    | undefined;
  const availableFamilies = Array.isArray(nodeFamilies?.available_families) ? nodeFamilies.available_families : [];
  const allFamilies = Array.isArray(nodeFamilies?.all_families) ? nodeFamilies.all_families : [];
  if (
    requestedFamily &&
    nodeFamilies?.observed === true &&
    (availableFamilies.length || allFamilies.length) &&
    ![...availableFamilies, ...allFamilies].includes(requestedFamily)
  ) {
    throw new Error(`iHPC node family ${requestedFamily} was not observed in the fresh quota snapshot`);
  }
  const selected =
    requestedFamily && activeNodes.some((node) => node.family === requestedFamily || node.node.startsWith(requestedFamily))
      ? activeNodes.find((node) => node.family === requestedFamily || node.node.startsWith(requestedFamily))
      : activeNodes[0];
  if (!selected || !isSafeRemoteToken(selected.node)) {
    throw new Error("iHPC active compute node id is unsafe or missing");
  }
  return selected.node;
}

// The nodes THIS account currently holds, for the per-account node-pool gate. Reuses the same
// sessions.active_nodes evidence selectActiveComputeNode trusts; returns [] when none is observed
// (no held nodes => no pool pressure). Strictly this profile's own snapshot — never another's.
function snapshotActiveNodes(snapshot: QuotaSnapshot): Array<{ node: string; family?: string }> {
  const sessions = snapshot.summary.sessions as { active_nodes?: unknown } | undefined;
  return sessions ? parseActiveNodes(sessions) : [];
}

function parseSupervisorStart(stdout: string): SupervisorStart {
  const lines = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  const raw = lines.at(-1);
  if (!raw) {
    throw new Error("iHPC supervisor did not return start metadata");
  }
  const parsed = JSON.parse(raw) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("iHPC supervisor returned invalid metadata");
  }
  const metadata = parsed as Partial<SupervisorStart>;
  const pid = metadata.pid;
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
    throw new Error("iHPC supervisor returned invalid pid");
  }
  const metadataPath = metadata.metadata_path;
  const stdoutPath = metadata.stdout_path;
  const stderrPath = metadata.stderr_path;
  if (!metadataPath || !stdoutPath || !stderrPath) {
    throw new Error("iHPC supervisor metadata missing log paths");
  }
  return {
    pid,
    metadata_path: metadataPath,
    stdout_path: stdoutPath,
    stderr_path: stderrPath,
    ...(metadata.started_at ? { started_at: metadata.started_at } : {})
  };
}

function summarizeStartFailure(result: { exitCode: number | null; stderr: string; timedOut?: boolean }): string {
  return summarizeRemoteFailure(result, {
    timedOut: "iHPC supervised start timed out",
    failed: (stderr) => `iHPC supervised start failed: ${stderr}`,
    exited: (exitCode) => `iHPC supervised start exited with ${String(exitCode)}`
  });
}

function redactSshArgs(args: string[], hostAlias: string, computeNode: string, encodedSpec: string): string[] {
  return maskHostAlias(args, hostAlias, [
    { match: computeNode, replace: "<ihpc-compute-node>" },
    { match: encodedSpec, replace: "<supervisor-spec>" }
  ]);
}

function parseActiveNodes(sessions: { active_nodes?: unknown }): Array<{ node: string; family?: string }> {
  if (!Array.isArray(sessions.active_nodes)) {
    return [];
  }
  return sessions.active_nodes
    .map((entry) => {
      if (typeof entry === "string") {
        return { node: entry, family: inferNodeFamily(entry) };
      }
      if (entry && typeof entry === "object" && !Array.isArray(entry)) {
        const record = entry as { node?: unknown; family?: unknown };
        return {
          node: typeof record.node === "string" ? record.node : "",
          ...(typeof record.family === "string" ? { family: record.family } : {})
        };
      }
      return { node: "" };
    })
    .filter((entry) => isSafeRemoteToken(entry.node));
}

const defaultIhpcStartExecutor: IhpcStartExecutor = runProcess;

export const SUPERVISOR_PY = String.raw`${pyImports(["base64", "json", "os", "subprocess", "sys", "time"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("supervisor")}
def expand_path(value):
    if not isinstance(value, str) or not value.startswith("/"):
        fail("all paths must be absolute strings")
    return os.path.expandvars(value)

allowed_roots = [os.path.realpath(expand_path(root)) for root in spec.get("allowed_roots", [])]
if not allowed_roots:
    fail("no allowed roots provided")

def checked_path(key):
    real = os.path.realpath(expand_path(spec[key]))
    if not any(real == root or real.startswith(root + os.sep) for root in allowed_roots):
        fail(f"{key} is outside allowed roots")
    return expand_path(spec[key])

run_id = spec.get("run_id")
command_argv = spec.get("command_argv")
if not isinstance(run_id, str) or not run_id:
    fail("missing run_id")
if not isinstance(command_argv, list) or not command_argv or not all(isinstance(item, str) and item for item in command_argv):
    fail("command_argv must be a non-empty string list")

workdir = checked_path("workdir")
log_dir = checked_path("log_dir")
stdout_path = checked_path("stdout_path")
stderr_path = checked_path("stderr_path")
pid_path = checked_path("pid_path")
metadata_path = checked_path("metadata_path")

os.makedirs(workdir, exist_ok=True)
os.makedirs(log_dir, exist_ok=True)

stdout_file = open(stdout_path, "ab", buffering=0)
stderr_file = open(stderr_path, "ab", buffering=0)
try:
    process = subprocess.Popen(
        command_argv,
        cwd=workdir,
        stdin=subprocess.DEVNULL,
        stdout=stdout_file,
        stderr=stderr_file,
        close_fds=True,
        start_new_session=True,
    )
except Exception as exc:
    fail(f"failed to start command: {exc}")

started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
metadata = {
    "run_id": run_id,
    "pid": process.pid,
    "started_at": started_at,
    "metadata_path": metadata_path,
    "stdout_path": stdout_path,
    "stderr_path": stderr_path,
}

with open(pid_path, "w", encoding="utf-8") as handle:
    handle.write(str(process.pid) + "\n")
with open(metadata_path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, sort_keys=True)
    handle.write("\n")

print(json.dumps(metadata, sort_keys=True))
`;
