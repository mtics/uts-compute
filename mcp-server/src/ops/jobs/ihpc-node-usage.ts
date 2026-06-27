// mcp-server/src/ops/jobs/ihpc-node-usage.ts
// ihpc.node.usage — the brain side of the READ-ONLY one-shot per-GPU utilization probe. This is the
// cheapest honest fix for the "no live GPU view" gap: an operator can see current per-GPU utilization +
// memory for an iHPC node WITHOUT bare SSH. NO daemon, NO continuous telemetry, NO new SSH assembler —
// it REUSES the EXISTING canary two-hop seam (sshSupervisorArgs + an inline-shipped fixed python probe,
// NODE_USAGE_PY), exactly like probeNodeCanary in ihpc-preflight.ts.
//
// FAIL-CLOSED: an SSH failure / timeout / unparseable output / empty (no-nvidia-smi) report yields a
// `node-unverifiable` status with an EMPTY gpus[] — the probe NEVER fabricates a reading. A node we
// could not honestly read GPUs from is reported as unverifiable, never as "0% / idle".
import { runProcess, type CommandResult } from "../../lib/process.js";
import { encodeSpec, normalizeTimeout, parseJsonLastLine } from "../../lib/shared.js";
import { sshSupervisorArgs } from "../../lib/ssh.js";
import { isSafeRemoteToken } from "../../core/ids.js";
import { getProfile } from "../../core/config.js";
import { PLATFORM, type ComputeProfile } from "../../core/types.js";
import { NODE_USAGE_PY } from "../scheduler/seam/node-usage-py.js";

// Standard / max SSH timeouts (mirrors the canary's 10s/30s policy in ihpc-preflight.ts).
const NODE_USAGE_DEFAULT_TIMEOUT_MS = 10000;
const NODE_USAGE_MAX_TIMEOUT_MS = 30000;

// One GPU's live reading, as parsed from NODE_USAGE_PY's JSON. Every field is validated defensively
// before use (the probe is trusted to print this shape, but a partial/garbage row is filtered, not
// trusted as a reading).
export interface NodeGpuUsage {
  index: number;
  name: string;
  utilization_gpu_percent: number;
  memory_used_mb: number;
  memory_total_mb: number;
}

// One compute process's live GPU memory (pid + used GPU memory MiB), from NODE_USAGE_PY's per-process
// query. Per-process MEMORY only — per-process utilization is not reliably exposed by nvidia-smi here
// (it needs pmon and is flaky). Lets the observe path attribute a node's GPU to one run by its pid (L2).
export interface NodeProcessUsage {
  pid: number;
  used_memory_mb: number;
}

// The shape the brain expects back from NODE_USAGE_PY's single JSON line.
interface NodeUsageReport {
  ok: boolean;
  gpus: NodeGpuUsage[];
  processes: NodeProcessUsage[];
  errors: string[];
}

// The structured tool output. status:"ok" means we have an honest per-GPU reading; status:
// "node-unverifiable" means we could NOT read the node (SSH failure, unparseable output, or
// nvidia-smi absent/failed) — in which case gpus is EMPTY and `reason` explains why.
export interface NodeUsageResult {
  node: string;
  status: "ok" | "node-unverifiable";
  gpus: NodeGpuUsage[];
  processes: NodeProcessUsage[];
  probed_at: string;
  reason?: string;
}

// The executor the probe ships NODE_USAGE_PY through. Same shape as the canary's CanaryExecutor and the
// repo's lib/process Executor: tests inject a crafted-JSON stub; production uses runProcess.
export type NodeUsageExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin: string
) => Promise<CommandResult>;

function isNodeGpuUsage(value: unknown): value is NodeGpuUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.index === "number" &&
    typeof record.name === "string" &&
    typeof record.utilization_gpu_percent === "number" &&
    typeof record.memory_used_mb === "number" &&
    typeof record.memory_total_mb === "number"
  );
}

function isNodeProcessUsage(value: unknown): value is NodeProcessUsage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return typeof record.pid === "number" && typeof record.used_memory_mb === "number";
}

// Narrow an unknown parsed JSON value to a NodeUsageReport, or return null when it is not the expected
// shape (the caller treats null as fail-closed node-unverifiable). PURE (no IO) so it is unit-testable
// in isolation from the SSH seam. Lenient on element types (malformed rows are filtered); strict that
// `gpus` is present and an array (a report with no gpus[] field is not a valid usage report).
export function parseNodeUsageReport(value: unknown): NodeUsageReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (!Array.isArray(record.gpus)) {
    return null;
  }
  const gpus = record.gpus.filter(isNodeGpuUsage).map((gpu) => ({
    index: gpu.index,
    name: gpu.name,
    utilization_gpu_percent: gpu.utilization_gpu_percent,
    memory_used_mb: gpu.memory_used_mb,
    memory_total_mb: gpu.memory_total_mb
  }));
  const processes = Array.isArray(record.processes)
    ? record.processes.filter(isNodeProcessUsage).map((p) => ({ pid: p.pid, used_memory_mb: p.used_memory_mb }))
    : [];
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  return { ok: record.ok === true, gpus, processes, errors };
}

function unverifiable(node: string, reason: string): NodeUsageResult {
  return { node, status: "node-unverifiable", gpus: [], processes: [], probed_at: new Date().toISOString(), reason };
}

// probeNodeUsage — validates the profile + `node` token, ships the FIXED NODE_USAGE_PY over the existing
// two-hop sshSupervisorArgs seam (encodeSpec carries only {kind:"node-usage"} — the probe ignores it),
// parses the JSON last line, and returns a structured per-GPU result. FAIL-CLOSED on any failure.
//
// Node-token validation runs BEFORE any SSH. Beyond isSafeRemoteToken, a LEADING-DASH token is rejected
// here so the node id can never be parsed as an ssh/option flag on the inner hop (the seam's
// leading-dash hardening, folded in at the brain so the rejection is explicit and unit-tested).
export async function probeNodeUsage(
  profile: ComputeProfile,
  node: string,
  executor: NodeUsageExecutor = runProcess,
  timeoutMs: number = NODE_USAGE_DEFAULT_TIMEOUT_MS
): Promise<NodeUsageResult> {
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(
      `Profile ${profile.profile_id} is for ${profile.platform}, but ihpc.node.usage requires a uts-ihpc profile`
    );
  }
  // Reject a leading-dash token explicitly (an isSafeRemoteToken string can start with `-`, e.g.
  // `-oProxyCommand=...`, which the inner ssh hop would parse as an option flag) BEFORE the safe-token
  // grammar check, so it can never reach the SSH argv.
  if (node.startsWith("-") || !isSafeRemoteToken(node)) {
    throw new Error(`Unsafe iHPC compute node id: ${node}`);
  }
  const bounded = normalizeTimeout(timeoutMs, {
    default: NODE_USAGE_DEFAULT_TIMEOUT_MS,
    max: NODE_USAGE_MAX_TIMEOUT_MS
  });
  const spec = encodeSpec({ kind: "node-usage" });
  const args = sshSupervisorArgs(profile.login.host_alias, node, bounded, spec);

  let result: CommandResult;
  try {
    result = await executor("ssh", args, bounded, NODE_USAGE_PY);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return unverifiable(node, `the probe could not be run (${reason})`);
  }

  if (result.timedOut) {
    return unverifiable(node, "the probe timed out");
  }
  if (result.exitCode !== 0) {
    const reason = (result.stderr || `exit ${String(result.exitCode)}`).trim().split(/\r?\n/)[0];
    return unverifiable(node, `the probe exited non-zero (${reason})`);
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLastLine(result.stdout, "iHPC node usage");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return unverifiable(node, reason);
  }
  const report = parseNodeUsageReport(parsed);
  if (report === null) {
    return unverifiable(node, "the probe returned an unexpected JSON shape");
  }

  // nvidia-smi absent/failed (ok:false) or no parseable GPU rows => unverifiable, NOT a fake reading.
  if (!report.ok || report.gpus.length === 0) {
    const detail = report.errors.length > 0 ? report.errors.join("; ") : "nvidia-smi reported no GPUs";
    return unverifiable(node, detail);
  }

  return { node, status: "ok", gpus: report.gpus, processes: report.processes, probed_at: new Date().toISOString() };
}

// The ops function the MCP handler binds. getProfile is injectable for tests (configPath); production
// uses the default config. Returns { usage: NodeUsageResult }.
export interface IhpcNodeUsageInput {
  profileId: string;
  node: string;
  timeoutMs?: number;
}

export interface IhpcNodeUsageOptions {
  executor?: NodeUsageExecutor;
  configPath?: string;
}

export interface IhpcNodeUsageResult {
  usage: NodeUsageResult;
}

export async function runIhpcNodeUsage(
  input: IhpcNodeUsageInput,
  options: IhpcNodeUsageOptions = {}
): Promise<IhpcNodeUsageResult> {
  const profile = getProfile(input.profileId, options.configPath);
  const usage = await probeNodeUsage(profile, input.node, options.executor ?? runProcess, input.timeoutMs);
  return { usage };
}
