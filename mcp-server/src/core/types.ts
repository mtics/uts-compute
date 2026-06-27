// Canonical home for the two platform string literals. Comparison sites across the server (~40 of
// them, 14 files) used the bare "uts-hpc"/"uts-ihpc" literals; routing them through PLATFORM.HPC /
// PLATFORM.IHPC keeps the values from drifting per call site. `Platform` is derived from the const
// values so the union and the const can never disagree (the string values are byte-identical to the
// prior hand-written union). schemas.ts PLATFORM_ENUM keeps its own z.enum tuple (zod needs literal
// tuples) but uses the same two strings.
export const PLATFORM = { HPC: "uts-hpc", IHPC: "uts-ihpc" } as const;
export type Platform = (typeof PLATFORM)[keyof typeof PLATFORM];
export type SchemaVersion = "0.1.0";

// An arbitrary JSON object body. Declared independently in resources.ts and migrations.ts; hoisted
// here so the two modules share one definition.
export type JsonObject = Record<string, unknown>;

export interface GitState {
  sha: string;
  branch: string;
  dirty: boolean;
}

export interface EnvironmentState {
  python_version: string | null;
  packages_sha256: string | null;
}

export interface Reproducibility {
  captured_at: string;
  command: string;
  git: GitState | { available: false };
  // Best-effort interpreter + package snapshot (a `pip freeze` digest), captured only when an env
  // probe is enabled (the jobs.plan tool). Optional so older run records remain valid.
  environment?: EnvironmentState | { available: false };
}

export interface ProfileConfig {
  version: number;
  profiles: ComputeProfile[];
}

// Persistent marker that a profile completed first-run onboarding: a real connection to the account
// that confirmed live access and captured its resource-allocation limits. Gate for live submission.
export interface OnboardingRecord {
  profile_id: string;
  platform: Platform;
  onboarded_at: string;
  snapshot_id: string;
  cluster: string;
}

// UTS iHPC only: how the daemonized progressor should be invoked on the node. The single shared shape
// for the profile field AND the launch/campaign seams (which previously re-declared an inline
// intersection). `runner` is a deliberate extension point; the node-path sub-options that no code read
// (uv_bin/dir) were dropped post-internalization.
export interface NodeSchedulerConfig {
  runner: "console" | "uv" | "cron_reboot";
}

export interface ComputeProfile {
  profile_id: string;
  platform: Platform;
  account_label: string;
  login: {
    host_alias: string;
    username_ref: string;
    ssh_agent?: boolean;
    identity_file_ref?: string;
    keychain_ref?: string;
    requires_vpn: boolean;
  };
  defaults: {
    queue?: string;
    node_family?: string;
    // UTS iHPC simultaneous node-occupation caps (portal "My Node Limits"; not SSH-queryable). Each
    // entry is an independent pool: a group of node families sharing one cap (e.g. the Research
    // general pool mars/venus/mercury = 2, separate from a TURINGGROUP turing pool = 2).
    node_limits?: Array<{ families: string[]; limit: number }>;
    // Attribution labels for the campaign ledger (DISCLOSURE, not credentials): which collaborator
    // owns this account and which allocation it draws on. Non-secret — never carries a real account
    // id, treated like account_label (surfaced by redactProfile, never redacted as a secret).
    owner?: string;
    allocation?: string;
    workspace?: string;
    scratch?: string;
    project?: string;
    // UTS iHPC only: the number of GPUs physically present on a node of this profile's node_family. The
    // brain's campaign placement fabricates gpu_indices [0..N-1]; without a real per-node count, a large
    // maxConcurrent would plan jobs onto NON-EXISTENT GPU indices (I2). When unset, campaign.submit falls
    // back to a conservative documented default (DEFAULT_NODE_GPU_COUNT) and clamps maxConcurrent to it.
    node_gpu_count?: number;
    // UTS iHPC only: how the daemonized progressor should be invoked on the node. Optional; absent
    // means console (a clean argv). `runner` is a DELIBERATE extension point — the on-node progressor
    // will eventually honor console/uv/cron_reboot — and is disclosed as node_scheduler_runner by
    // redactProfile. Reduced to just `runner`: the old uv_bin/dir node-path sub-options were never
    // consumed post-internalization and were dropped.
    node_scheduler?: NodeSchedulerConfig;
  };
  quota_snapshot?: Record<string, unknown> | null;
}

export interface JobSpec {
  run_id: string;
  profile_id: string;
  platform: Platform;
  experiment: {
    name: string;
    description?: string;
    job_type?: string;
    tags?: string[];
  };
  resources: {
    queue?: string;
    node_family?: string;
    ncpus?: number;
    memory_gb?: number;
    walltime?: string;
    ngpus?: number;
    array?: {
      start: number;
      end: number;
      max_concurrent?: number;
    };
  };
  command: string;
  workdir?: string;
  inputs?: string[];
  outputs?: string[];
  // Declared checkpoint resume contract (F6): a fixed checkpoint path and a single allowlisted flag
  // token. On a timeout retry, jobs.retry.plan appends "<resume_flag> <checkpoint_path>" to the
  // command. Both are declared + validated — never a glob or remote-dir scan.
  resumable?: {
    checkpoint_path: string;
    resume_flag: string;
  };
  approval?: {
    required?: boolean;
    reasons?: string[];
  };
}

export interface RetryLineage {
  source_run_id: string;
  source_status: "failed" | "cancelled";
  source_plan_hash: string;
  planned_at: string;
  reason?: string;
}

// M10 lineage for a sweep.retry.plan: re-plans ONLY the failed array members of a finished sweep into
// a new, smaller array job. Unlike RetryLineage it records which original indices failed and how they
// were compacted into the new [0..n-1] array (index_map), so the retry is attributable back to the
// source sweep AND the lineage is hash-bound (committed by planHashForPlan), keeping the re-planned
// sweep an independent, tamper-evident plan.
export interface SweepRetryLineage {
  source_run_id: string;
  source_status: "finished";
  source_plan_hash: string;
  // original array indices that failed (as supplied by the operator), in ascending order
  failed_indices: number[];
  // original index -> new compacted index in the re-planned [0..n-1] array
  index_map: Record<string, number>;
  planned_at: string;
  reason?: string;
}

export interface SpecChange {
  field: string;
  from: unknown;
  to: unknown;
}

export interface PlannedJob {
  schema_version?: SchemaVersion;
  mode: "dry-run";
  run_id: string;
  profile_id: string;
  platform: Platform;
  plan_hash: string;
  quota_snapshot_id?: string;
  template: string;
  script: string;
  command_argv?: string[];
  normalized_job_spec: JobSpec;
  approval: {
    required: boolean;
    reasons: string[];
    // ADR 0004: risk reasons are advisory display-only metadata; they no longer gate
    // submission (conformance does). Present on the plan output, not the hashed spec.
    policy?: "advisory";
  };
  approval_operation?: "jobs.submit" | "jobs.retry";
  retry_of?: RetryLineage;
  sweep_retry_of?: SweepRetryLineage;
  warnings: string[];
  spec_diff?: { against_run_id: string; changes: SpecChange[] };
  audit_path?: string;
  plan_path?: string;
}

// Observed hardware usage for a run, persisted into the run record when jobs.status/jobs.track parse
// resources_used from qstat — so the right-size advisor can compare requested vs actual offline.
export interface RunUsage {
  walltime_seconds: number;
  mem_gb?: number;
  ncpus?: number;
  ngpus?: number;
  core_hours: number;
  gpu_hours: number;
  cpu_efficiency_percent: number | null;
}

// Frozen "who / where / what" of a live submission, captured at submit time so a run record is
// self-describing for audit without re-reading the profile config. Secret-free: account_label and
// the cluster login host only (never a raw username/credential). `node` is filled progressively —
// at start for iHPC (the cnode), at status time for PBS (parsed exec_host).
export interface SubmissionContext {
  account_label: string;
  cluster: string;
  queue?: string;
  node?: string;
  requested: {
    ncpus?: number;
    memory_gb?: number;
    walltime?: string;
    ngpus?: number;
  };
  submitted_at: string;
}

export interface RunRecord {
  schema_version?: SchemaVersion;
  run_id: string;
  profile_id: string;
  platform: Platform;
  remote_job_id: string | null;
  // Optimistic-concurrency revision, bumped on every updateRunRecord; a write whose base rev no
  // longer matches the on-disk record is refused so concurrent writers can't silently clobber.
  rev?: number;
  project?: string;
  project_hash?: string;
  // Optional campaign attribution (DISCLOSURE, not a credential or a cap input). Organizational
  // metadata that lives ONLY on the run record — like `project`, it is NEVER hashed into plan_hash and
  // NEVER carried on JobSpec. The campaign ledger groups runs by it to attribute a multi-allocation
  // campaign across owners; it never sums usage across accounts. Adopted/plain runs leave it absent.
  campaign_id?: string;
  job_type?: string;
  plan_hash?: string;
  quota_snapshot_id?: string;
  approval?: {
    state: ApprovalState;
    approved_at?: string;
    approved_by?: string;
    reason?: string;
    bound_plan_hash?: string;
    bound_quota_snapshot_id?: string;
  };
  supervisor?: {
    // Phase B/C: for a campaign progressor this is the on-node progressor PID (the slot-filling
    // reconcile loop); for a single-run fast path it stays the per-process supervisor PID.
    pid: number;
    node_id?: string;
    metadata_path: string;
    stdout_path: string;
    stderr_path: string;
    started_at?: string;
  };
  submission?: SubmissionContext;
  // Scheduler-reported placement (iHPC): where the run is, for observability. PBS leaves this null
  // (its accounting is in `usage`). The plugin carries what the scheduler reports; it never probes GPUs.
  placement?: {
    hostname: string;
    node_id?: string;
    gpu_index?: number;
    slots_per_gpu?: number;
    // Phase B: which slot index (0-based) on the chosen GPU this run occupies. The brain assigns it
    // during pre-accounting (control/placement.ts); the node verifies GPU-idle at launch (Phase C).
    gpu_slot?: number;
    started_at?: string;
    placement_hash?: string;
  };
  // P2-a: the node+pid an operator OBSERVED at adopt time for a foreign iHPC run (born from ihpc-sched +
  // hand-written queue YAML, ingested via jobs.adopt). Present ONLY on adopted iHPC runs. This is the
  // honest minimum the observe path needs — it carries NO supervisor stdout/stderr/metadata paths (those
  // can't be synthesized for an external process without crossing the profile-root boundary), so it does
  // NOT unlock the supervised read/cancel path; it ONLY lets jobs.status probe liveness + the node's GPU
  // snapshot. Distinct from `supervisor` (a lineage-proven run we launched) and `placement` (scheduler
  // placement). `node` is the compute node the pid runs on; `pid` is the observed process pid.
  observed?: {
    node: string;
    pid: number;
  };
  // Feature B (spec §5) two-axis adoption provenance. Present ONLY on adopted runs. Two independent
  // trust axes plus a lineage verdict — do NOT collapse them: "we launched it" (terminal_record) must
  // never launder an unverified argv into "intent is authoritative".
  //  - terminal_record: did OUR agent author this exit record? "agent_authored" = the node wrapper we
  //    deployed wrote exit.code/result.json (strong, stronger than PBS qstat). "external_observed" =
  //    we only observed it (foreign job / pre-internalization).
  //  - intent: is what it ran the user's intent? "user_declared" = command_argv/workdir came from the
  //    user's sweep params with shape+root validation only (NOT semantically verified — same trust
  //    level as PBS). "unverified" = a foreign job whose argv we never declared.
  //  - lineage: proven via STATE queue_id + lease_owner matching a RunRecord we hold, or not.
  //  - discovered_via: HOW the external evidence was found — "qstat" for a PBS row pulled over SSH,
  //    "node_observed" for an iHPC pid we only saw on the node. Provenance only; never a trust claim.
  adoption?: {
    terminal_record: "agent_authored" | "external_observed";
    intent: "user_declared" | "unverified";
    lineage: "lineage_proven" | "not_lineage_proven";
    queue_id?: string;
    discovered_via?: "qstat" | "node_observed";
    adopted_at: string;
  };
  usage?: RunUsage;
  // "submitting" is a transient durable marker written just before the remote qsub/start and cleared
  // to "submitted"/"running" on success; a record stuck in "submitting" is an in-flight submission to
  // reconcile (jobs.track surfaces it), never a silently-orphaned remote job.
  status: "planned" | "submitting" | "submitted" | "running" | "finished" | "failed" | "cancelled" | "unknown";
  retry_of?: RetryLineage;
  sweep_retry_of?: SweepRetryLineage;
  created_at: string;
  updated_at: string;
  events: Array<{
    at: string;
    kind: string;
    summary: string;
    redacted_command?: string;
    artifact_path?: string;
  }>;
  // Phase B (internalized scheduler) — brain-side queue/lease/auto-progression attribution. All four
  // are organizational/observability metadata: they live ONLY on the run record, are NEVER hashed into
  // plan_hash, and are absent on plain non-campaign runs.
  queue_position?: number;
  lease_owner?: LeaseOwner;
  auto_progressed?: {
    // true when the on-node progressor (not the online brain) launched this run into a freed slot.
    by_node_agent: boolean;
    // the run whose terminal slot this run filled, when known (for the campaign ledger lineage).
    freed_by_run_id?: string;
  };
  // crash/restart relaunch attempt counter (§2.6 "新 attempt"); 0 for the first launch.
  attempt?: number;
  reproducibility?: Reproducibility;
}

export type ApprovalState = "not_required" | "required" | "approved" | "rejected" | "expired";

export type ApprovalOperation =
  | "jobs.submit"
  | "jobs.cancel"
  | "jobs.retry"
  | "transfers.execute"
  | "artifacts.fetch"
  | "artifacts.fetch.batch"
  | "artifacts.cleanup.execute";

export interface ApprovalRecord {
  schema_version?: SchemaVersion;
  approval_id: string;
  run_id: string;
  profile_id: string;
  platform: Platform;
  operation: ApprovalOperation;
  state: ApprovalState;
  // plan_hash / quota_snapshot_id are the PLANNED-job binding (the default for every plugin-planned op).
  // They are OPTIONAL only for the adopted-PBS cancel path (Option A): a job we never planned has no
  // plan_hash, so a jobs.cancel approval for it binds to the adopted identity via `remote_job_id` instead.
  plan_hash?: string;
  quota_snapshot_id?: string;
  // Set ONLY on an adopted-PBS jobs.cancel approval: the binding swaps the meaningless plan_hash for the
  // run's real, confined remote_job_id so the approval cannot be reused for a different job or account.
  remote_job_id?: string;
  scope_hash?: string;
  reasons: string[];
  requested_at: string;
  expires_at: string;
  decided_at?: string;
  decided_by?: string;
  decision_reason?: string;
  used_at?: string;
  consumed_by?: string;
  command_summary?: string;
  resource_summary?: Record<string, unknown>;
  warnings: string[];
}

export interface SubmitResult {
  mode: "live";
  run_id: string;
  profile_id: string;
  platform: Platform;
  status: "submitted" | "running";
  remote_job_id: string;
  approval_id?: string;
  plan_hash: string;
  quota_snapshot_id?: string;
  submitted_at: string;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
  supervisor?: {
    pid: number;
    node_id?: string;
    metadata_path: string;
    stdout_path: string;
    stderr_path: string;
  };
  run_record_path?: string;
}

export interface JobUsageSummary {
  core_hours: number;
  gpu_hours: number;
  cpu_efficiency_percent: number | null;
}

// P2-a: the node's live per-GPU snapshot, as the OBSERVE path carries it on a JobStatusResult. Mirrors
// the ihpc.node.usage tool output (probeNodeUsage's NodeUsageResult) but is defined here so core/types
// stays a leaf with no import cycle on the ops layer. "ok" => an honest per-GPU reading in gpus[];
// "node-unverifiable" => the node could not be read (SSH failure / no nvidia-smi) and gpus[] is EMPTY —
// never a fabricated reading.
export interface NodeGpuUsageView {
  index: number;
  name: string;
  utilization_gpu_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
}

export interface NodeProcessUsageView {
  pid: number;
  used_memory_mb: number;
}
export interface NodeUsageView {
  node: string;
  status: "ok" | "node-unverifiable";
  gpus: NodeGpuUsageView[];
  processes?: NodeProcessUsageView[];
  probed_at: string;
  reason?: string;
}

export interface JobStatusResult {
  mode: "read-only";
  run_id: string;
  profile_id: string;
  platform: Platform;
  remote_job_id: string;
  observed_at: string;
  status: RunRecord["status"];
  scheduler_state?: string;
  node?: string;
  // Scheduler-reported placement carried on the run record (iHPC observability, H8); absent for PBS.
  placement?: RunRecord["placement"];
  usage?: JobUsageSummary | null;
  // P2-a (adopted/foreign iHPC OBSERVE path only): liveness of the operator-recorded pid on its node
  // ("alive" => running, "dead" => finished, "unknown" => an indeterminate probe that preserves the
  // prior definite status) plus the node's live per-GPU snapshot (status "ok" with gpus[], or
  // "node-unverifiable" with an empty gpus[] — never a fabricated reading). Absent on every other path
  // (PBS, supervised iHPC) — those report status the normal way.
  liveness?: "alive" | "dead" | "unknown";
  gpu_usage?: NodeUsageView;
  summary: string;
  // P4 (VPN/network-drop resilience): when the live SSH probe failed because the host was unreachable
  // (VPN down), error_kind classifies the failure ("unreachable" | "timeout" | "dns") and network_hint
  // carries the one actionable next step (connect the VPN / access.doctor --export-ssh). Absent when the
  // probe ran (success, or a real remote/app error).
  error_kind?: "timeout" | "unreachable" | "dns";
  network_hint?: string;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
  run_record_path?: string;
  evidence_path?: string;
}

export interface JobTrackEntry {
  run_id: string;
  profile_id: string;
  platform: Platform;
  project: string;
  remote_job_id: string;
  previous_status: RunRecord["status"];
  status: RunRecord["status"];
  scheduler_state?: string;
  node?: string;
  usage?: JobUsageSummary | null;
  transitioned: boolean;
  summary: string;
  // P1-a (one-call fleet status, OPT-IN via jobs.track nodeUsage:true): the live per-GPU snapshot of this
  // run's compute node, fused in the same read-only sweep so an operator no longer SSHes per node for
  // nvidia-smi. Present ONLY for an ACTIVE iHPC run that has a node AND only when nodeUsage was requested.
  // De-duped per distinct node (N runs on one node share one probe) and fail-closed ("node-unverifiable"
  // with an empty gpus[] for a node we could not read — never a fabricated reading). Absent for PBS runs.
  gpu_usage?: NodeUsageView;
  // P4: same VPN-down classification as JobStatusResult, per tracked run (a sweep may be partly down).
  error_kind?: "timeout" | "unreachable" | "dns";
  network_hint?: string;
  evidence_path?: string;
  error?: string;
}

export interface JobTrackResult {
  mode: "read-only";
  observed_at: string;
  counts: {
    polled: number;
    transitioned: number;
    errors: number;
    skipped_planned: number;
    skipped_terminal: number;
    newly_terminal: number;
    needs_reconciliation: number;
  };
  truncated: boolean;
  tracked: JobTrackEntry[];
  terminal_transitions: Array<{ run_id: string; project: string; status: RunRecord["status"] }>;
  needs_reconciliation: Array<{ run_id: string; project: string; message: string }>;
  // P4: a sweep-level VPN-down hint, set when at least one tracked run failed network-unreachable, so a
  // caller doesn't have to scan every row to notice the VPN is down.
  network_hint?: string;
}

export interface JobLogStreamResult {
  stream: "stdout" | "stderr";
  path: string;
  status: "passed" | "failed";
  content: string;
  truncated: boolean;
  summary: string;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
}

export interface JobLogsResult {
  mode: "read-only";
  run_id: string;
  profile_id: string;
  platform: Platform;
  remote_job_id: string;
  observed_at: string;
  max_bytes: number;
  streams: JobLogStreamResult[];
  run_record_path?: string;
  evidence_path?: string;
}

export interface JobCancelResult {
  mode: "live";
  run_id: string;
  profile_id: string;
  platform: Platform;
  status: "cancelled";
  remote_job_id: string;
  approval_id: string;
  // Absent on an adopted-PBS cancel (Option A) — that path binds remote_job_id, not plan_hash/quota.
  plan_hash?: string;
  quota_snapshot_id?: string;
  cancelled_at: string;
  command: {
    program: string;
    args: string[];
    remote_argv: string[];
  };
  run_record_path?: string;
  evidence_path?: string;
}

export interface TransferPlan {
  run_id: string;
  profile_id: string;
  direction: "upload" | "download";
  source: string;
  destination: string;
  files?: string[];
  max_total_bytes?: number;
}

export interface PlannedTransfer {
  schema_version?: SchemaVersion;
  mode: "dry-run";
  run_id: string;
  profile_id: string;
  platform: Platform;
  direction: "upload" | "download";
  plan_hash: string;
  quota_snapshot_id?: string;
  source: string;
  destination: string;
  files?: string[];
  max_total_bytes?: number;
  script: string;
  warnings: string[];
  plan_path?: string;
}

export interface TransferExecutionRecord {
  schema_version?: SchemaVersion;
  run_id: string;
  profile_id: string;
  platform: Platform;
  approval_id?: string;
  kind: "transfer-execute";
  observed_at: string;
  evidence: {
    direction: "upload" | "download";
    source: string;
    destination: string;
    files: Array<{
      path: string;
      size_bytes: number;
      sha256?: string;
      checksum_status?: "verified" | "captured" | "skipped-large";
    }>;
    checksum_policy?: {
      algorithm: "sha256";
      max_file_bytes: number;
    };
    total_size_bytes: number;
    max_total_bytes: number;
    command: {
      program: "rsync";
      args: string[];
    };
  };
}

export type ArtifactKind = "file" | "directory" | "missing" | "other";

export interface ArtifactEntry {
  artifact_id: string;
  path: string;
  relative_path: string;
  kind: ArtifactKind;
  size_bytes?: number;
  sha256?: string;
  checksum_status?: "captured" | "skipped-large" | "not-file" | "missing";
  source_output: string;
}

export interface ArtifactManifestEntry extends ArtifactEntry {
  remote_path: string;
}

export interface ArtifactManifest {
  schema_version?: SchemaVersion;
  run_id: string;
  profile_id: string;
  platform: Platform;
  created_at: string;
  artifacts: ArtifactManifestEntry[];
  truncated: boolean;
}

export interface ArtifactFetchRecord {
  schema_version?: SchemaVersion;
  run_id: string;
  profile_id: string;
  platform: Platform;
  artifact_id: string;
  approval_id?: string;
  kind: "fetch";
  observed_at: string;
  evidence: {
    command: {
      program: "ssh";
      args: string[];
      remote_argv: string[];
    };
    artifact_path: string;
    local_path: string;
    size_bytes: number;
    sha256: string;
  };
}

export interface ArtifactFetchBatchRecord {
  schema_version?: SchemaVersion;
  run_id: string;
  profile_id: string;
  platform: Platform;
  approval_id?: string;
  kind: "fetch-batch";
  observed_at: string;
  evidence: {
    approval_id?: string;
    artifact_ids: string[];
    manifest_hash: string;
    max_bytes_per_file: number;
    max_total_bytes: number;
    total_size_bytes: number;
    files: Array<{
      artifact_id: string;
      artifact_path: string;
      local_path: string;
      size_bytes: number;
      sha256: string;
      command: {
        program: "ssh";
        args: string[];
        remote_argv: string[];
      };
    }>;
  };
}

export interface ArtifactSummaryRecord {
  schema_version?: SchemaVersion;
  mode: "local" | "remote";
  run_id: string;
  profile_id: string;
  platform: Platform;
  generated_at: string;
  summary_path: string;
  metrics_path: string;
  metrics: Record<string, unknown>;
  // Remote-sourced provenance (mode === "remote"): records that the single metric file was read over
  // the bounded SSH read seam from a profile-root-confined remote path, NOT a checksummed local fetch.
  source?: "local" | "remote";
  remote_path?: string;
  remote_sha256?: string;
  remote_size_bytes?: number;
}

export interface ArtifactCleanupPlanRecord {
  schema_version?: SchemaVersion;
  mode: "dry-run";
  run_id: string;
  profile_id: string;
  platform: Platform;
  plan_hash: string;
  cleanup_plan_hash: string;
  generated_at: string;
  remote_candidates: string[];
  local_candidates: string[];
  cleanup_plan_path: string;
  warnings: string[];
}

export interface ArtifactCleanupExecutionRecord {
  schema_version?: SchemaVersion;
  run_id: string;
  profile_id: string;
  platform: Platform;
  approval_id: string;
  kind: "cleanup-execute";
  observed_at: string;
  evidence: {
    manifest_hash: string;
    artifact_ids: string[];
    remote_deleted_files: string[];
    remote_missing: string[];
    remote_total_deleted_bytes: number;
    local_deleted_files: string[];
    command: {
      program: "ssh";
      args: string[];
      remote_argv: string[];
    };
  };
}

export type AccessCheckName =
  | "profile"
  | "vpn"
  | "ssh-config"
  | "dns"
  | "tcp"
  | "host-key"
  | "ssh-auth"
  | "remote-identity";

export type AccessCheckStatus = "passed" | "failed" | "skipped";

export interface AccessCheckStep {
  name: AccessCheckName;
  status: AccessCheckStatus;
  summary: string;
  observed_at?: string;
  command?: {
    program: string;
    args: string[];
  };
  duration_ms?: number;
  details?: Record<string, unknown>;
}

export interface AccessCheckResult {
  schema_version?: SchemaVersion;
  mode: "read-only";
  profile_id: string;
  platform: Platform;
  observed_at: string;
  requires_vpn: boolean;
  host_alias: string;
  resolved_host?: string;
  port?: number;
  overall_status: "passed" | "failed" | "partial";
  checks: AccessCheckStep[];
  warnings: string[];
  // P4: when a VPN-required profile fails network preflight, error_kind classifies the dominant failure
  // ("dns" | "unreachable" | "timeout") and network_hint carries the actionable VPN-down next step.
  // Absent when not VPN-required, when preflight passed, or when the failure was reachable-but-rejected
  // (auth / host-key), which is not a VPN drop.
  error_kind?: "timeout" | "unreachable" | "dns";
  network_hint?: string;
  evidence_path?: string;
}

export interface QuotaEvidenceCommand {
  id: string;
  status: "passed" | "failed" | "skipped";
  command: {
    program: string;
    args: string[];
    remote_argv?: string[];
  };
  exit_code?: number | null;
  duration_ms?: number;
  summary: string;
}

export interface QuotaSnapshot {
  schema_version?: SchemaVersion;
  snapshot_id: string;
  profile_id: string;
  platform: Platform;
  observed_at: string;
  source: "quotas.refresh";
  freshness: "fresh" | "stale" | "unknown";
  raw_evidence_path?: string;
  summary: {
    identity?: Record<string, unknown>;
    queues?: Record<string, unknown>;
    node_families?: Record<string, unknown>;
    sessions?: Record<string, unknown>;
    storage?: Record<string, unknown>;
    running_work?: Record<string, unknown>;
  };
  commands: QuotaEvidenceCommand[];
  warnings: string[];
}

export interface QuotaRefreshResult {
  mode: "read-only";
  snapshot: QuotaSnapshot;
  // P4: when every live SSH probe failed network-unreachable (VPN down), error_kind classifies it and
  // network_hint carries the actionable next step. The snapshot is still produced (each command recorded
  // as failed) — the hint is additive. Absent when the probes ran.
  error_kind?: "timeout" | "unreachable" | "dns";
  network_hint?: string;
  evidence_path?: string;
}

export interface DocsCacheRecord {
  schema_version?: SchemaVersion;
  source_id: string;
  title: string;
  source_url: string;
  observed_at: string;
  status_code: number;
  content_type: string;
  bytes: number;
  text_chars: number;
  content_hash: string;
  etag?: string;
  last_modified?: string;
  text: string;
  warnings: string[];
}

// --- Phase B: internalized iHPC scheduler PLAN/STATE shared types (spec §2.2 / §2.3) ---

// The single writer that authored a PLAN / holds the node lease. `client` is the agent family; never a
// secret. Mirrors the node lease.json holder minus pid/queue_id (those are node-side, Phase C).
export interface LeaseOwner {
  client: "claude" | "codex";
  device_id: string;
  issued_at: string;
}

// PLAN job entry (spec §2.2 `jobs[]`). command_argv is pre-escaped argv (no bash -lc); env values may
// carry hardened sentinels ($GPU_INDEX$/$RUN_ID$) expanded ONLY in env values on the node (Phase C).
export interface IhpcPlanJob {
  seq: number;
  run_id: string;
  command_argv: string[];
  workdir: string;
  env: Record<string, string>;
  gpu_index: number;
  gpu_count: number;
  timeout_seconds: number;
}

// PLAN file (brain -> node; spec §2.2, grouped by concern). Immutable per queue_id.
// campaign_id is `string | null`: a campaign run carries its id; the single-run FAST PATH (jobs==1,
// no campaign — Phase C seam/launch.ts) emits a PLAN with campaign_id:null and keys its fast path on
// that null. Phase C MUST reuse THIS canonical IhpcPlan type for its launch path (not a private looser
// PlanObject) so field drift is caught at compile time (review CP-5).
export interface IhpcPlan {
  schema_version: string;
  schema_compat_min: string;
  campaign_id: string | null;
  queue_id: string;
  lease_owner: LeaseOwner;
  node_id: string;
  profile_id: string;
  limits: { slot_count: number; max_slots_per_gpu: number; log_max_bytes: number };
  security: { allowed_roots: string[]; env_key_allowlist: string[] };
  policy: {
    on_job_failure: "continue" | "stop";
    failure_breaker: { max_consecutive_failures: number; require_one_success: boolean };
    idle_definition: string;
    idle_exit_seconds: number;
    restart_throttle_seconds: number;
  };
  jobs: IhpcPlanJob[];
}

// STATE per-slot entry (spec §2.3 jobs.<seq>).
// `pid` is the INNER job process pid. `wrapper_pid` is the per-slot wrapper/supervisor-of-record pid
// (the launch-time GPU-guard + SIGTERM-trap wrapper, Phase C §2.5) — this is the pid Phase D's
// dead-progressor adopt path (`ihpcStateJobToRunRecord`) uses to build the supervisor block, so that a
// dead PROGRESSOR pid is never mistaken for the supervisor of a still-live job (review CP-3 / D-2). The
// node writes wrapper_pid when it launches a slot; the brain never invents it.
export interface IhpcStateJob {
  seq: number;
  run_id: string;
  status: IhpcJobStatus;
  pid?: number;
  wrapper_pid?: number;
  gpu_index?: number;
  exit_code?: number;
  started_at_node?: string;
  finished_at_node?: string;
  log: string;
}

export type IhpcJobStatus =
  | "pending" | "launching" | "running" | "done" | "failed" | "cancelled" | "placement_conflict";

// STATE file (node -> brain; spec §2.3, grouped). The brain reads it ONCE per reconcile (Phase C).
export interface IhpcState {
  schema_version: string;
  campaign_id: string;
  queue_id: string;
  lease_owner: Pick<LeaseOwner, "client" | "device_id">;
  observed_at_node: string;
  node_clock_epoch: number;
  slot_count: number;
  progressor: { pid: number; started_at_node: string; heartbeat_node: string };
  health: { degraded: string | null; breaker_tripped: boolean };
  jobs: Record<string, IhpcStateJob>;
  counts: {
    pending: number; running: number; done: number; failed: number;
    cancelled: number; conflict: number;
  };
}
