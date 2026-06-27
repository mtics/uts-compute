import { assertSafeSshTarget, isSafeRemotePath, normalizeTimeout, safeTimestampOf } from "../../lib/shared.js";
import { redactWithTokens } from "../../lib/redact.js";
import { classifyRemoteFailure, type RemoteFailureClassification } from "../../lib/net-errors.js";
import { sshReadOnlyArgs } from "../../lib/ssh.js";
import { isSafeRemoteToken } from "../../core/ids.js";
import { type CommandExecutor, defaultCommandExecutor, type CommandResult } from "../../core/access.js";
import { getProfile } from "../../core/config.js";
import { assertInsideRuntime, RUNTIME_DIRS } from "../../core/paths.js";
import { writeEvidenceJson } from "../../lib/evidence.js";
import { assertQuotaSnapshot } from "../../core/validation.js";
import { parsePbsQueueLimits, parseDfAvailable, IHPC_NODE_FAMILIES, inferNodeFamily } from "./quota-limits.js";
import { isSafeRemoteJobId } from "../../core/ids.js";
import { PLATFORM } from "../../core/types.js";
import type { ComputeProfile, QuotaEvidenceCommand, QuotaRefreshResult, QuotaSnapshot } from "../../core/types.js";

export interface QuotaRefreshOptions {
  timeoutMs?: number;
  writeEvidence?: boolean;
  configPath?: string;
  executor?: CommandExecutor;
  now?: Date;
}

interface RawQuotaEvidence {
  snapshot: QuotaSnapshot;
  // `classification` is the P4 net-error classification of the RAW command result (carried internally so
  // refresh*ForProfile can aggregate a VPN-down hint); it is stripped before the command lands in the
  // persisted snapshot/evidence by stripCommandOutput.
  command_outputs: Array<QuotaEvidenceCommand & { stdout?: string; stderr?: string; classification?: RemoteFailureClassification }>;
}

// Timeout policy (per-module, deliberate): standard 10s default / 30s cap shared by the middle
// modules. Named consts so the policy stays explicit, not folded into a shared bound.
const DEFAULT_TIMEOUT_MS = 10000;
const MAX_TIMEOUT_MS = 30000;
const EVIDENCE_DIR = RUNTIME_DIRS.quotas;

export async function refreshQuotas(profileId: string, options: QuotaRefreshOptions = {}): Promise<QuotaRefreshResult> {
  const profile = getProfile(profileId, options.configPath);
  if (profile.platform === PLATFORM.HPC) {
    return refreshHpcQuotasForProfile(profile, options);
  }
  if (profile.platform === PLATFORM.IHPC) {
    return refreshIhpcQuotasForProfile(profile, options);
  }
  throw new Error(`Unsupported platform for quotas.refresh: ${String(profile.platform)}`);
}

export async function refreshHpcQuotasForProfile(
  profile: ComputeProfile,
  options: Omit<QuotaRefreshOptions, "configPath"> = {}
): Promise<QuotaRefreshResult> {
  if (profile.platform !== PLATFORM.HPC) {
    throw new Error(`HPC quota refresh requires an uts-hpc profile, got ${profile.platform}`);
  }
  assertSafeSshTarget(profile.login.host_alias);

  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultCommandExecutor;
  const observedAt = (options.now ?? new Date()).toISOString();
  const warnings = ["M2b read-only quota refresh: no scheduler writes, transfers, or workload commands were executed"];
  const commandOutputs: RawQuotaEvidence["command_outputs"] = [];

  const whoami = await runHpcCommand("identity.whoami", profile.login.host_alias, ["whoami"], timeoutMs, executor);
  commandOutputs.push(whoami);
  const remoteUser = parseRemoteUser(whoami.stdout ?? "");

  commandOutputs.push(await runHpcCommand("identity.id", profile.login.host_alias, ["id"], timeoutMs, executor));
  commandOutputs.push(await runHpcCommand("identity.groups", profile.login.host_alias, ["groups"], timeoutMs, executor));
  commandOutputs.push(await runHpcCommand("queues.qstat-q", profile.login.host_alias, ["qstat", "-Q"], timeoutMs, executor));
  commandOutputs.push(await runHpcCommand("queues.qstat-qf", profile.login.host_alias, ["qstat", "-Qf"], timeoutMs, executor));
  commandOutputs.push(
    remoteUser
      ? await runHpcCommand("running.qstat-u", profile.login.host_alias, ["qstat", "-u", remoteUser], timeoutMs, executor, {
          redactTokens: [remoteUser]
        })
      : skippedCommand("running.qstat-u", "Skipped qstat -u because whoami did not return a safe username")
  );
  commandOutputs.push(
    await runHpcCommand("nodes.pbsnodes-json", profile.login.host_alias, ["pbsnodes", "-F", "json", "-a"], timeoutMs, executor)
  );
  commandOutputs.push(await runHpcCommand("storage.quota-s", profile.login.host_alias, ["quota", "-s"], timeoutMs, executor));
  for (const storageCommand of storageDfCommands(profile, remoteUser)) {
    commandOutputs.push(
      await runHpcCommand(storageCommand.id, profile.login.host_alias, storageCommand.remote_argv, timeoutMs, executor, {
        redactTokens: remoteUser ? [remoteUser] : []
      })
    );
  }

  const snapshot: QuotaSnapshot = {
    snapshot_id: `quota-${profile.profile_id}-${safeTimestampOf(observedAt)}`,
    profile_id: profile.profile_id,
    platform: profile.platform,
    observed_at: observedAt,
    source: "quotas.refresh",
    freshness: "fresh",
    summary: buildHpcSummary(commandOutputs, profile.login.username_ref, remoteUser),
    commands: commandOutputs.map(stripCommandOutput),
    warnings
  };
  assertQuotaSnapshot(snapshot);

  const result: QuotaRefreshResult = {
    mode: "read-only",
    snapshot,
    ...aggregateNetworkDrop(commandOutputs)
  };

  if (options.writeEvidence ?? true) {
    result.evidence_path = writeQuotaEvidence({ snapshot, command_outputs: commandOutputs }, remoteUser ? [remoteUser] : []);
    result.snapshot.raw_evidence_path = result.evidence_path;
    assertQuotaSnapshot(result.snapshot);
  }

  return result;
}

export async function refreshIhpcQuotasForProfile(
  profile: ComputeProfile,
  options: Omit<QuotaRefreshOptions, "configPath"> = {}
): Promise<QuotaRefreshResult> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`iHPC quota refresh requires an uts-ihpc profile, got ${profile.platform}`);
  }
  assertSafeSshTarget(profile.login.host_alias);

  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultCommandExecutor;
  const observedAt = (options.now ?? new Date()).toISOString();
  const warnings = ["M2c read-only iHPC refresh: no cnode allocation, scheduler writes, transfers, or workload commands were executed"];
  const commandOutputs: RawQuotaEvidence["command_outputs"] = [];

  const whoami = await runIhpcCommand("identity.whoami", profile.login.host_alias, ["whoami"], timeoutMs, executor);
  commandOutputs.push(whoami);
  const remoteUser = parseRemoteUser(whoami.stdout ?? "");

  commandOutputs.push(await runIhpcCommand("identity.id", profile.login.host_alias, ["id"], timeoutMs, executor));
  commandOutputs.push(await runIhpcCommand("identity.groups", profile.login.host_alias, ["groups"], timeoutMs, executor));
  commandOutputs.push(await runIhpcCommand("nodes.cnode-avail", profile.login.host_alias, ["cnode", "avail"], timeoutMs, executor));
  commandOutputs.push(await runIhpcCommand("nodes.cnode-all", profile.login.host_alias, ["cnode", "all"], timeoutMs, executor));
  commandOutputs.push(await runIhpcCommand("sessions.cnode-mynodes", profile.login.host_alias, ["cnode", "mynodes"], timeoutMs, executor));
  commandOutputs.push(await runIhpcCommand("sessions.sessiontime", profile.login.host_alias, ["sessiontime"], timeoutMs, executor));
  commandOutputs.push(await runIhpcCommand("storage.projvolu", profile.login.host_alias, ["projvolu"], timeoutMs, executor));
  for (const storageCommand of storageDfCommands(profile, remoteUser)) {
    commandOutputs.push(
      await runIhpcCommand(storageCommand.id, profile.login.host_alias, storageCommand.remote_argv, timeoutMs, executor, {
        redactTokens: remoteUser ? [remoteUser] : []
      })
    );
  }
  for (const storageCommand of storageDuCommands(profile, remoteUser)) {
    commandOutputs.push(
      await runIhpcCommand(storageCommand.id, profile.login.host_alias, storageCommand.remote_argv, timeoutMs, executor, {
        redactTokens: remoteUser ? [remoteUser] : []
      })
    );
  }

  const snapshot: QuotaSnapshot = {
    snapshot_id: `quota-${profile.profile_id}-${safeTimestampOf(observedAt)}`,
    profile_id: profile.profile_id,
    platform: profile.platform,
    observed_at: observedAt,
    source: "quotas.refresh",
    freshness: "fresh",
    summary: buildIhpcSummary(commandOutputs, profile.login.username_ref, remoteUser),
    commands: commandOutputs.map(stripCommandOutput),
    warnings
  };
  assertQuotaSnapshot(snapshot);

  const result: QuotaRefreshResult = {
    mode: "read-only",
    snapshot,
    ...aggregateNetworkDrop(commandOutputs)
  };

  if (options.writeEvidence ?? true) {
    result.evidence_path = writeQuotaEvidence({ snapshot, command_outputs: commandOutputs }, remoteUser ? [remoteUser] : []);
    result.snapshot.raw_evidence_path = result.evidence_path;
    assertQuotaSnapshot(result.snapshot);
  }

  return result;
}

// P4: aggregate a VPN-down hint over the whole refresh. The snapshot is always produced (each command is
// recorded as passed/failed/skipped), so this only ADDS an actionable next step when the refresh looks
// like a network drop: at least one live command was network-unreachable AND none actually succeeded.
// Requiring "none passed" is the misclassification guard — if even one ssh command came back, the host
// was reachable and a single failed command is an app/permission error, not a VPN drop. error_kind is
// taken from the first unreachable command (timeout/unreachable/dns), so a pure DNS-down refresh reports
// "dns". The shared NETWORK_DROP_HINT wording lives in lib/net-errors.
function aggregateNetworkDrop(
  outputs: RawQuotaEvidence["command_outputs"]
): { error_kind: "timeout" | "unreachable" | "dns"; network_hint: string } | undefined {
  const ran = outputs.filter((output) => output.classification);
  if (ran.some((output) => output.classification?.kind === "ok")) {
    return undefined;
  }
  const firstUnreachable = ran.find((output) => output.classification?.network_unreachable);
  if (!firstUnreachable?.classification) {
    return undefined;
  }
  const kind = firstUnreachable.classification.kind;
  // network_unreachable is only ever set for timeout/unreachable/dns, so this narrows safely.
  if (kind !== "timeout" && kind !== "unreachable" && kind !== "dns") {
    return undefined;
  }
  return { error_kind: kind, network_hint: firstUnreachable.classification.hint as string };
}

async function runHpcCommand(
  id: string,
  hostAlias: string,
  remoteArgv: string[],
  timeoutMs: number,
  executor: CommandExecutor,
  options: { redactTokens?: string[] } = {}
): Promise<QuotaEvidenceCommand & { stdout: string; stderr: string; classification: RemoteFailureClassification }> {
  assertAllowedHpcRemoteArgv(remoteArgv);
  const args = sshReadOnlyArgs(hostAlias, timeoutMs, remoteArgv);
  const started = Date.now();
  const result = await executor("ssh", args, timeoutMs);
  const durationMs = Date.now() - started;
  const stdout = redactQuotaText(result.stdout, options.redactTokens);
  const stderr = redactQuotaText(result.stderr, options.redactTokens);

  return {
    id,
    status: result.exitCode === 0 ? "passed" : "failed",
    command: {
      program: "ssh",
      args: redactCommandArgs(args, options.redactTokens),
      remote_argv: redactCommandArgs(remoteArgv, options.redactTokens)
    },
    exit_code: result.exitCode,
    duration_ms: durationMs,
    summary: result.exitCode === 0 ? `${id} completed` : `${id} failed: ${stderr || `exit ${String(result.exitCode)}`}`,
    stdout,
    stderr,
    // Classify the RAW result (not the redacted copy) so timedOut and the unredacted stderr banner feed
    // the net-error classifier exactly. Redaction never touches the network banners, but raw is correct.
    classification: classifyRemoteFailure(result)
  };
}

async function runIhpcCommand(
  id: string,
  hostAlias: string,
  remoteArgv: string[],
  timeoutMs: number,
  executor: CommandExecutor,
  options: { redactTokens?: string[] } = {}
): Promise<QuotaEvidenceCommand & { stdout: string; stderr: string; classification: RemoteFailureClassification }> {
  assertAllowedIhpcRemoteArgv(remoteArgv);
  const args = sshReadOnlyArgs(hostAlias, timeoutMs, remoteArgv);
  const started = Date.now();
  const result = await executor("ssh", args, timeoutMs);
  const durationMs = Date.now() - started;
  const stdout = redactQuotaText(result.stdout, options.redactTokens);
  const stderr = redactQuotaText(result.stderr, options.redactTokens);

  return {
    id,
    status: result.exitCode === 0 ? "passed" : "failed",
    command: {
      program: "ssh",
      args: redactCommandArgs(args, options.redactTokens),
      remote_argv: redactCommandArgs(remoteArgv, options.redactTokens)
    },
    exit_code: result.exitCode,
    duration_ms: durationMs,
    summary: result.exitCode === 0 ? `${id} completed` : `${id} failed: ${stderr || `exit ${String(result.exitCode)}`}`,
    stdout,
    stderr,
    // See runHpcCommand: classify the raw result for the P4 VPN-down aggregation.
    classification: classifyRemoteFailure(result)
  };
}

function skippedCommand(id: string, summary: string): QuotaEvidenceCommand & { stdout: string; stderr: string } {
  return {
    id,
    status: "skipped",
    command: {
      program: "ssh",
      args: [],
      remote_argv: []
    },
    summary,
    stdout: "",
    stderr: ""
  };
}

function buildHpcSummary(
  outputs: RawQuotaEvidence["command_outputs"],
  usernameRef: string,
  remoteUser: string | null
): QuotaSnapshot["summary"] {
  const byId = new Map(outputs.map((output) => [output.id, output]));
  const groups = parseWords(byId.get("identity.groups")?.stdout ?? "");
  const qstatQ = byId.get("queues.qstat-q")?.stdout ?? "";
  const qstatQf = byId.get("queues.qstat-qf")?.stdout ?? "";
  const qstatU = byId.get("running.qstat-u")?.stdout ?? "";
  const pbsnodes = byId.get("nodes.pbsnodes-json")?.stdout ?? "";

  return {
    identity: {
      username_ref: usernameRef,
      remote_user_observed: Boolean(remoteUser),
      id_observed: byId.get("identity.id")?.status === "passed",
      groups,
      group_count: groups.length
    },
    queues: {
      observed: byId.get("queues.qstat-q")?.status === "passed",
      queue_names: parseQueueNames(qstatQ),
      qstat_qf_observed: byId.get("queues.qstat-qf")?.status === "passed",
      queue_limits: parsePbsQueueLimits(qstatQf)
    },
    node_families: parsePbsNodesSummary(pbsnodes),
    running_work: {
      observed: byId.get("running.qstat-u")?.status === "passed",
      job_count: parseQstatJobCount(qstatU),
      by_queue: parseQstatByQueue(qstatU)
    },
    storage: parseStorageSummary(outputs)
  };
}

function buildIhpcSummary(
  outputs: RawQuotaEvidence["command_outputs"],
  usernameRef: string,
  remoteUser: string | null
): QuotaSnapshot["summary"] {
  const byId = new Map(outputs.map((output) => [output.id, output]));
  const groups = parseWords(byId.get("identity.groups")?.stdout ?? "");
  const cnodeAvail = byId.get("nodes.cnode-avail")?.stdout ?? "";
  const cnodeAll = byId.get("nodes.cnode-all")?.stdout ?? "";
  const cnodeMynodes = byId.get("sessions.cnode-mynodes")?.stdout ?? "";

  return {
    identity: {
      username_ref: usernameRef,
      remote_user_observed: Boolean(remoteUser),
      id_observed: byId.get("identity.id")?.status === "passed",
      groups,
      group_count: groups.length
    },
    queues: {
      observed: false,
      note: "iHPC is an interactive node platform, not a PBS queue platform"
    },
    node_families: {
      observed: byId.get("nodes.cnode-avail")?.status === "passed" || byId.get("nodes.cnode-all")?.status === "passed",
      available_families: parseIhpcNodeFamilies(cnodeAvail),
      all_families: parseIhpcNodeFamilies(cnodeAll),
      available_line_count: countNonEmptyLines(cnodeAvail),
      all_line_count: countNonEmptyLines(cnodeAll)
    },
    sessions: {
      observed:
        byId.get("sessions.cnode-mynodes")?.status === "passed" || byId.get("sessions.sessiontime")?.status === "passed",
      mynodes_line_count: countNonEmptyLines(cnodeMynodes),
      sessiontime_observed: byId.get("sessions.sessiontime")?.status === "passed",
      active_nodes: parseIhpcActiveNodes(cnodeMynodes)
    },
    running_work: {
      observed: byId.get("sessions.cnode-mynodes")?.status === "passed",
      active_session_count: parseIhpcActiveSessionCount(cnodeMynodes)
    },
    storage: parseStorageSummary(outputs)
  };
}

function parseRemoteUser(stdout: string): string | null {
  const candidate = stdout.trim();
  return /^[A-Za-z0-9._-]{1,64}$/.test(candidate) ? candidate : null;
}

function parseWords(stdout: string): string[] {
  return stdout
    .trim()
    .split(/\s+/)
    .filter(Boolean);
}

function parseQueueNames(stdout: string): string[] {
  const names = new Set<string>();
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || /^Queue\b/i.test(trimmed) || /^-+(?:\s+-+)*$/.test(trimmed)) {
      continue;
    }
    const [name] = trimmed.split(/\s+/);
    if (/^[A-Za-z0-9_.-]+$/.test(name)) {
      names.add(name);
    }
  }
  return [...names].sort();
}

function parseQstatJobCount(stdout: string): number {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^[0-9]+(?:\.[A-Za-z0-9_.-]+)?\s+/.test(line)).length;
}

// Count the account's running/queued jobs per queue from `qstat -u <user>` so conformance can
// check per-user max_run / max_queued. Queue names may be column-truncated (e.g. "small_g*").
function parseQstatByQueue(stdout: string): Record<string, { running: number; queued: number }> {
  const byQueue: Record<string, { running: number; queued: number }> = {};
  for (const line of stdout.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!/^[0-9]+(?:\.[A-Za-z0-9_.-]+)?\s+/.test(trimmed)) {
      continue;
    }
    const fields = trimmed.split(/\s+/);
    if (fields.length < 6) {
      continue;
    }
    const queue = fields[2];
    const state = fields[fields.length - 2];
    if (!/^[A-Za-z0-9_.*-]+$/.test(queue)) {
      continue;
    }
    const bucket = (byQueue[queue] ??= { running: 0, queued: 0 });
    if (state === "R" || state === "E") {
      bucket.running += 1;
    } else if (state === "Q" || state === "H" || state === "W" || state === "T") {
      bucket.queued += 1;
    }
  }
  return byQueue;
}

function parsePbsNodesSummary(stdout: string): Record<string, unknown> {
  try {
    const parsed = JSON.parse(stdout) as unknown;
    if (!parsed || typeof parsed !== "object") {
      return { observed: true, node_count: null, parse_status: "non_object_json" };
    }
    const nodes = (parsed as { nodes?: unknown }).nodes;
    if (!nodes || typeof nodes !== "object" || Array.isArray(nodes)) {
      return { observed: true, node_count: null, parse_status: "missing_nodes_object" };
    }
    const stateCounts: Record<string, number> = {};
    for (const node of Object.values(nodes as Record<string, { state?: string }>)) {
      const state = typeof node?.state === "string" ? node.state : "unknown";
      stateCounts[state] = (stateCounts[state] ?? 0) + 1;
    }
    return {
      observed: true,
      node_count: Object.keys(nodes).length,
      states: stateCounts,
      parse_status: "parsed"
    };
  } catch {
    return {
      observed: Boolean(stdout.trim()),
      node_count: null,
      parse_status: "invalid_json"
    };
  }
}

function parseStorageSummary(outputs: RawQuotaEvidence["command_outputs"]): Record<string, unknown> {
  const storageCommands = outputs.filter((output) => output.id.startsWith("storage."));
  const filesystems = storageCommands
    .filter((output) => output.id.startsWith("storage.df-") && output.status === "passed")
    .flatMap((output) => {
      const kind = output.id.slice("storage.df-".length);
      return parseDfAvailable(output.stdout ?? "").map((entry) => ({ kind, ...entry }));
    });
  return {
    observed: storageCommands.some((output) => output.status === "passed"),
    quota_observed: storageCommands.some((output) => output.id === "storage.quota-s" && output.status === "passed"),
    project_volume_observed: storageCommands.some((output) => output.id === "storage.projvolu" && output.status === "passed"),
    filesystem_count: storageCommands.filter((output) => output.id.startsWith("storage.df-") && output.status === "passed").length,
    usage_count: storageCommands.filter((output) => output.id.startsWith("storage.du-") && output.status === "passed").length,
    failed_count: storageCommands.filter((output) => output.status === "failed").length,
    skipped_count: storageCommands.filter((output) => output.status === "skipped").length,
    // Structured per-filesystem availability for autonomous storage-headroom conformance.
    filesystems
  };
}

function storageDfCommands(
  profile: ComputeProfile,
  remoteUser: string | null
): Array<{ id: string; remote_argv: string[] }> {
  if (!remoteUser) {
    return [];
  }
  const roots = [
    ["workspace", profile.defaults.workspace],
    ["scratch", profile.defaults.scratch],
    ["project", profile.defaults.project]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return roots
    .map(([kind, root]) => [kind, substituteRemoteUser(root, remoteUser)] as [string, string])
    .filter(([, root]) => isSafeRemotePath(root))
    .map(([kind, root]) => ({
      id: `storage.df-${kind}`,
      remote_argv: ["df", "-hP", root]
    }));
}

function storageDuCommands(
  profile: ComputeProfile,
  remoteUser: string | null
): Array<{ id: string; remote_argv: string[] }> {
  if (!remoteUser) {
    return [];
  }
  const roots = [
    ["workspace", profile.defaults.workspace],
    ["scratch", profile.defaults.scratch],
    ["project", profile.defaults.project]
  ].filter((entry): entry is [string, string] => Boolean(entry[1]));

  return roots
    .map(([kind, root]) => [kind, substituteRemoteUser(root, remoteUser)] as [string, string])
    .filter(([, root]) => isSafeRemotePath(root))
    .map(([kind, root]) => ({
      id: `storage.du-${kind}`,
      remote_argv: ["du", "-s", "-h", root]
    }));
}

function substituteRemoteUser(value: string, remoteUser: string): string {
  return value.replaceAll("${USER}", remoteUser);
}

function stripCommandOutput(command: QuotaEvidenceCommand & { stdout?: string; stderr?: string }): QuotaEvidenceCommand {
  return {
    id: command.id,
    status: command.status,
    command: command.command,
    exit_code: command.exit_code,
    duration_ms: command.duration_ms,
    summary: command.summary
  };
}

function parseIhpcNodeFamilies(stdout: string): string[] {
  const families = new Set<string>();
  const lower = stdout.toLowerCase();
  for (const family of IHPC_NODE_FAMILIES) {
    if (new RegExp(`\\b${family}[a-z0-9_-]*\\b`).test(lower)) {
      families.add(family);
    }
  }
  return [...families].sort();
}

function parseIhpcActiveSessionCount(stdout: string): number {
  // An iHPC "session" is a compute node the user currently holds. Count the SAME validated node rows
  // parseIhpcActiveNodes accepts (first token is a safe node id) so the multi-line `cnode mynodes`
  // welcome banner and the column header are never miscounted as sessions. A user holding zero nodes
  // must report 0 — this number gates iHPC supervised start in selectActiveComputeNode.
  return parseIhpcActiveNodes(stdout).length;
}

function parseIhpcActiveNodes(stdout: string): Array<{ node: string; family?: string }> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^no\b/i.test(line) && !/^node\b/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((node) => isSafeRemoteJobId(node))
    .map((node) => ({
      node,
      ...(inferNodeFamily(node) ? { family: inferNodeFamily(node) } : {})
    }));
}

function countNonEmptyLines(stdout: string): number {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean).length;
}

function writeQuotaEvidence(evidence: RawQuotaEvidence, redactTokens: string[]): string {
  const evidenceDir = assertInsideRuntime(EVIDENCE_DIR, "Quota evidence directory");
  return writeEvidenceJson(
    evidenceDir,
    `${evidence.snapshot.snapshot_id}.json`,
    redactQuotaEvidence(evidence, redactTokens),
    "Quota evidence"
  );
}

function redactQuotaEvidence(evidence: RawQuotaEvidence, redactTokens: string[]): RawQuotaEvidence {
  return {
    snapshot: evidence.snapshot,
    command_outputs: evidence.command_outputs.map((command) => ({
      ...command,
      command: {
        ...command.command,
        args: redactCommandArgs(command.command.args, redactTokens),
        remote_argv: redactCommandArgs(command.command.remote_argv ?? [], redactTokens)
      },
      stdout: redactQuotaText(command.stdout ?? "", redactTokens),
      stderr: redactQuotaText(command.stderr ?? "", redactTokens)
    }))
  };
}

function redactQuotaText(text: string, redactTokens: string[] = []): string {
  return redactWithTokens(text, redactTokens, () => "<redacted-remote-user>");
}

function redactCommandArgs(args: string[], redactTokens: string[] = []): string[] {
  return args.map((arg) => redactQuotaText(arg, redactTokens));
}

function assertAllowedHpcRemoteArgv(remoteArgv: string[]): void {
  const exactAllowlist = [
    ["whoami"],
    ["id"],
    ["groups"],
    ["qstat", "-Q"],
    ["qstat", "-Qf"],
    ["pbsnodes", "-F", "json", "-a"],
    ["quota", "-s"]
  ];
  if (exactAllowlist.some((allowed) => sameArray(allowed, remoteArgv))) {
    return;
  }
  if (remoteArgv.length === 3 && remoteArgv[0] === "qstat" && remoteArgv[1] === "-u" && isSafeRemoteToken(remoteArgv[2])) {
    return;
  }
  if (remoteArgv.length === 3 && remoteArgv[0] === "df" && remoteArgv[1] === "-hP" && isSafeRemotePath(remoteArgv[2])) {
    return;
  }
  throw new Error(`quotas.refresh remote command is not allowlisted: ${remoteArgv.join(" ")}`);
}

function assertAllowedIhpcRemoteArgv(remoteArgv: string[]): void {
  const exactAllowlist = [
    ["whoami"],
    ["id"],
    ["groups"],
    ["cnode", "avail"],
    ["cnode", "all"],
    ["cnode", "mynodes"],
    ["sessiontime"],
    ["projvolu"]
  ];
  if (exactAllowlist.some((allowed) => sameArray(allowed, remoteArgv))) {
    return;
  }
  if (remoteArgv.length === 3 && remoteArgv[0] === "df" && remoteArgv[1] === "-hP" && isSafeRemotePath(remoteArgv[2])) {
    return;
  }
  if (
    remoteArgv.length === 4 &&
    remoteArgv[0] === "du" &&
    remoteArgv[1] === "-s" &&
    remoteArgv[2] === "-h" &&
    isSafeRemotePath(remoteArgv[3])
  ) {
    return;
  }
  throw new Error(`quotas.refresh iHPC remote command is not allowlisted: ${remoteArgv.join(" ")}`);
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}
