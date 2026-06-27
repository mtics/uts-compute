// mcp-server/src/ops/jobs/ihpc-preflight.ts
// P9: pre-flight a campaign's scheduler queue YAML BEFORE launch, locally — so a `MovieLens`≠`ML`
// dataset typo or a malformed `--param_overrides '{...}'` payload is caught on the operator's laptop,
// not after the campaign has been dispatched to the cluster. This primitive is PURE and LOCAL: it does
// NO SSH, never probes GPUs, and never reads the remote filesystem. Dataset existence is checked
// against a caller-supplied `datasetDirs` allowlist (a remote `ssh test -d` probe is a deliberate
// later-phase candidate, not P9). It declares its own structured-finding shape (QueueFinding) because
// the repo's other validators return ValidationResult { valid; errors[] }, which can't carry the
// per-finding path/level/suggestion this needs.
import fs from "node:fs";
import type { AnySchema, ErrorObject } from "ajv";
import * as Ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import YAML from "yaml";
import { runProcess, type CommandResult } from "../../lib/process.js";
import { encodeSpec, normalizeTimeout, parseJsonLastLine } from "../../lib/shared.js";
import { sshSupervisorArgs } from "../../lib/ssh.js";
import { isSafeRemoteToken } from "../../core/ids.js";
import { getProfile } from "../../core/config.js";
import { assertInsideProject, assertRealPathInside, projectRoot } from "../../core/paths.js";
import { PLATFORM, type ComputeProfile } from "../../core/types.js";
import { CANARY_PY, GPU_BUSY_MEM_FRACTION, GPU_BUSY_UTIL_PERCENT } from "../scheduler/seam/canary-py.js";

// Reuse the exact Ajv2020 instance pattern from core/validation.ts:27-30 (the repo's record-schema
// validator), so an optional parameter_space is interpreted with the same draft + format support.
const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module.Ajv2020 }).default;
const addFormats = (addFormatsModule as unknown as { default: (ajv: InstanceType<typeof Ajv2020>) => void }).default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

// A single pre-flight finding. `level:"error"` means the campaign would mis-launch; `level:"warning"`
// is advisory. `path` points at the offending location (e.g. `experiments[0].command` or, for the
// opt-in node canary, `node`/`node.gpu[0]`). `code` is an optional stable machine identifier for the
// canary findings (gpu-unavailable / cuda-unavailable / cuda-unverified / gpu-busy / node-unverifiable)
// so an agent can branch without string-matching the message. `suggestion` is an optional human hint.
export interface QueueFinding {
  level: "error" | "warning";
  code?: string;
  path: string;
  message: string;
  suggestion?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Pull the dataset name out of the `--dataset <token>` CLI flag in an experiment command. BOTH the
// space form (`--dataset MovieLens`) and the equals form (`--dataset=MovieLens`) are matched, or the
// allowlist check P3's ihpc.campaign.generate relies on would silently miss the equals form. The dataset
// is ALWAYS a CLI flag, never a key inside param_overrides (verified across the real configs:
// param_overrides carries hyperparameters only). Case-sensitive by design.
function extractDataset(command: string): string | undefined {
  const match = command.match(/--dataset(?:\s+|=)(\S+)/);
  return match ? match[1] : undefined;
}

// Pull the `--param_overrides <quoted-json>` slice for BOTH quote styles:
//   single-quoted: `--param_overrides '{"lr":0.01}'` — the inner JSON uses double quotes, so the next
//                  single-quote is an unambiguous terminator (slice verbatim).
//   double-quoted: `--param_overrides "{\"lr\":0.01}"` — the inner JSON's double quotes are backslash-
//                  escaped, so we scan to the next UNescaped double-quote and then unescape `\"` -> `"`
//                  (and `\\` -> `\`) to recover the JSON payload.
// A naive `{...}` regex would mis-handle nested objects/arrays (e.g. `"topk":[50]`,
// `"multimodal_ablation":{...}`), so we slice on the literal quote delimiters instead.
function extractParamOverridesRaw(command: string): string | undefined {
  const singleMarker = "--param_overrides '";
  const doubleMarker = "--param_overrides \"";
  const singleStart = command.indexOf(singleMarker);
  const doubleStart = command.indexOf(doubleMarker);
  // Choose whichever quote style appears first (a command carries at most one --param_overrides).
  const useSingle =
    singleStart !== -1 && (doubleStart === -1 || singleStart < doubleStart);
  if (useSingle) {
    const sliceStart = singleStart + singleMarker.length;
    const end = command.indexOf("'", sliceStart);
    return end === -1 ? undefined : command.slice(sliceStart, end);
  }
  if (doubleStart === -1) {
    return undefined;
  }
  const sliceStart = doubleStart + doubleMarker.length;
  // Scan for the first UNescaped closing double-quote, honoring backslash escapes inside.
  let out = "";
  for (let i = sliceStart; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "\\" && i + 1 < command.length) {
      out += command[i + 1]; // unescape: `\"` -> `"`, `\\` -> `\`
      i += 1;
      continue;
    }
    if (ch === "\"") {
      return out; // closing delimiter reached
    }
    out += ch;
  }
  return undefined; // no closing double-quote
}

function formatAjvErrors(errors: ErrorObject[] | null | undefined): string[] {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`);
}

/**
 * Validate a scheduler queue YAML (already parsed to an object) against the launch contract.
 *
 * @param queueYaml    parsed queue config: top-level `my_nodes` (non-empty array) + `experiments`
 *                     (non-empty array, each `{ name:string, command:string, requires_gpu:boolean }`).
 * @param datasetDirs  optional allowlist of locally-present dataset directory names. When supplied,
 *                     each experiment's `--dataset <token>` is checked for an EXACT, case-sensitive
 *                     match. When omitted, the dataset check is skipped entirely.
 * @param paramSpace   optional JSON Schema for the embedded `--param_overrides` object; when supplied,
 *                     each parsed override object is Ajv-validated against it.
 * @returns QueueFinding[] — empty (or warning-only) means safe to launch.
 */
export function validateQueueContract(
  queueYaml: unknown,
  datasetDirs?: string[],
  paramSpace?: Record<string, unknown>
): QueueFinding[] {
  const findings: QueueFinding[] = [];

  if (!isRecord(queueYaml)) {
    findings.push({ level: "error", path: "", message: "queue YAML must be a mapping/object." });
    return findings;
  }

  // --- 1. Structure -----------------------------------------------------------------------------
  const myNodes = queueYaml.my_nodes;
  if (!Array.isArray(myNodes) || myNodes.length < 1) {
    findings.push({
      level: "error",
      path: "my_nodes",
      message: "my_nodes must be a non-empty array of nodes the scheduler may use.",
      suggestion: "List at least one node you hold an active session on (e.g. - venus01)."
    });
  }

  const experiments = queueYaml.experiments;
  if (!Array.isArray(experiments) || experiments.length < 1) {
    findings.push({
      level: "error",
      path: "experiments",
      message: "experiments must be a non-empty array.",
      suggestion: "Add at least one experiment with name/command/requires_gpu."
    });
    // No experiments to inspect — the structural error above is enough.
    return findings;
  }

  experiments.forEach((experiment, index) => {
    const basePath = `experiments[${index}]`;
    if (!isRecord(experiment)) {
      findings.push({ level: "error", path: basePath, message: "experiment must be a mapping/object." });
      return;
    }

    if (typeof experiment.name !== "string" || experiment.name.length === 0) {
      findings.push({ level: "error", path: `${basePath}.name`, message: "experiment name must be a non-empty string." });
    }
    if (typeof experiment.requires_gpu !== "boolean") {
      findings.push({
        level: "error",
        path: `${basePath}.requires_gpu`,
        message: "requires_gpu must be a boolean."
      });
    }

    const command = experiment.command;
    if (typeof command !== "string" || command.length === 0) {
      findings.push({ level: "error", path: `${basePath}.command`, message: "command must be a non-empty string." });
      return; // nothing more to parse out of a missing command
    }

    // --- 2. Dataset existence (only when datasetDirs supplied) ----------------------------------
    if (datasetDirs !== undefined) {
      const dataset = extractDataset(command);
      if (dataset !== undefined && !datasetDirs.includes(dataset)) {
        findings.push({
          level: "error",
          path: `${basePath}.command`,
          message: `dataset "${dataset}" (from --dataset) is not present locally (case-sensitive match).`,
          suggestion: `Available datasets: ${datasetDirs.join(", ") || "(none)"}. Check for a typo (e.g. MovieLens vs ML).`
        });
      }
    }

    // --- 3. param_overrides shape --------------------------------------------------------------
    const raw = extractParamOverridesRaw(command);
    if (raw !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        findings.push({
          level: "error",
          path: `${basePath}.command`,
          message: `--param_overrides is not valid JSON: ${reason}`,
          suggestion: "Ensure the value is a single-quoted JSON object, e.g. --param_overrides '{\"learning_rate\":0.01}'."
        });
        return;
      }

      if (paramSpace !== undefined) {
        const validate = ajv.compile(paramSpace as AnySchema);
        if (validate(parsed) !== true) {
          for (const message of formatAjvErrors(validate.errors)) {
            findings.push({
              level: "error",
              path: `${basePath}.command`,
              message: `--param_overrides violates parameter_space: ${message}`
            });
          }
        }
      }
    }
  });

  return findings;
}

// ---------------------------------------------------------------------------------------------------
// OPT-IN on-node GPU/CUDA canary (audit MEDIUM reliability recommendation). This is the ONLY part of
// preflight that does SSH — and it runs ONLY when the caller supplies BOTH a profileId and a node. The
// default (validateQueueContract alone) stays PURE-LOCAL, exactly as before. The canary probes the
// node's GPU(s) BEFORE the campaign occupies it, so a broken/busy/CUDA-mismatched node is caught here
// instead of after N failed slots. It REUSES the existing two-hop seam (sshSupervisorArgs + the fixed
// inline CANARY_PY), exactly like campaign/start.ts's state read — no new SSH assembler, no free-form
// remote shell, no interpolation of any caller input into the remote command.
// ---------------------------------------------------------------------------------------------------

// The canary's standard / max SSH timeouts (mirrors the scheduler's 10s/30s policy in campaign/start.ts).
const CANARY_DEFAULT_TIMEOUT_MS = 10000;
const CANARY_MAX_TIMEOUT_MS = 30000;

// The shape the brain expects back from CANARY_PY's single JSON line. Every field is validated
// defensively before use (the probe is trusted to print this shape, but a partial/garbage line must
// fail CLOSED to a node-unverifiable error, never be read as healthy).
interface CanaryGpu {
  index: number;
  mem_used: number;
  mem_total: number;
  util: number;
}
interface CanaryReport {
  ok: boolean;
  gpu_count: number;
  gpus: CanaryGpu[];
  torch_present: boolean;
  cuda_available: boolean | null;
  errors: string[];
}

// The executor the canary ships CANARY_PY through. Same shape as the scheduler's CampaignStartExecutor
// and the repo's lib/process Executor: tests inject a crafted-JSON stub; production uses runProcess.
export type CanaryExecutor = (
  program: string,
  args: string[],
  timeoutMs: number,
  stdin: string
) => Promise<CommandResult>;

function isCanaryGpu(value: unknown): value is CanaryGpu {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const record = value as Record<string, unknown>;
  return (
    typeof record.index === "number" &&
    typeof record.mem_used === "number" &&
    typeof record.mem_total === "number" &&
    typeof record.util === "number"
  );
}

// Narrow an unknown parsed JSON value to a CanaryReport, or return null when it is not the expected
// shape (which the caller treats as fail-closed node-unverifiable). Lenient on `errors`/`gpus` element
// types (filtered), strict on the load-bearing scalar verdict fields.
function asCanaryReport(value: unknown): CanaryReport | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record.gpu_count !== "number" || typeof record.torch_present !== "boolean") {
    return null;
  }
  if (!(record.cuda_available === null || typeof record.cuda_available === "boolean")) {
    return null;
  }
  const gpus = Array.isArray(record.gpus) ? record.gpus.filter(isCanaryGpu) : [];
  const errors = Array.isArray(record.errors)
    ? record.errors.filter((entry): entry is string => typeof entry === "string")
    : [];
  return {
    ok: record.ok === true,
    gpu_count: record.gpu_count,
    gpus,
    torch_present: record.torch_present,
    cuda_available: record.cuda_available as boolean | null,
    errors
  };
}

// True iff a single GPU is "busy" by the advisory threshold: utilization at/over GPU_BUSY_UTIL_PERCENT,
// OR used/total memory fraction at/over GPU_BUSY_MEM_FRACTION. Mirrors the node-side verdict (the two
// constants are SHARED from canary-py.ts) so the brain and probe never disagree on the threshold.
function isGpuBusy(gpu: CanaryGpu): boolean {
  const memFraction = gpu.mem_total > 0 ? gpu.mem_used / gpu.mem_total : 0;
  return gpu.util >= GPU_BUSY_UTIL_PERCENT || memFraction >= GPU_BUSY_MEM_FRACTION;
}

// Map a parsed CanaryReport to QueueFinding[]. PURE (no IO) so it is unit-testable in isolation from
// the SSH seam. The mapping (each row is one independent finding; a node can be both gpu-busy and
// cuda-unverified):
//   nvidia-smi failed / gpu_count===0  -> error   gpu-unavailable   (node would mis-launch)
//   cuda_available===false             -> error   cuda-unavailable  (driver/lib mismatch; the real killer)
//   torch_present===false              -> warning cuda-unverified   (could not verify CUDA on the node)
//   every GPU busy (util/mem over thr) -> warning gpu-busy          (node occupied; slots may queue/OOM)
export function mapCanaryReportToFindings(report: CanaryReport): QueueFinding[] {
  const findings: QueueFinding[] = [];

  if (report.gpu_count === 0) {
    const detail = report.errors.length > 0 ? ` (${report.errors.join("; ")})` : "";
    findings.push({
      level: "error",
      code: "gpu-unavailable",
      path: "node",
      message: `no GPU is present/visible on the node — nvidia-smi reported zero GPUs${detail}.`,
      suggestion: "Confirm you are targeting a GPU node and that nvidia-smi works there before launching."
    });
  }

  if (report.cuda_available === false) {
    findings.push({
      level: "error",
      code: "cuda-unavailable",
      path: "node",
      message:
        "CUDA is NOT usable on the node (torch.cuda.is_available() is false) — a driver/library mismatch " +
        "that nvidia-smi can pass while real CUDA work fails.",
      suggestion: "Resolve the driver/CUDA-toolkit mismatch on the node before occupying it."
    });
  } else if (report.torch_present === false) {
    // Could not verify CUDA usability at all (torch not importable). Advisory, not blocking.
    findings.push({
      level: "warning",
      code: "cuda-unverified",
      path: "node",
      message: "could not verify CUDA — torch is not importable on the node, so CUDA usability is unconfirmed.",
      suggestion: "Install/activate the torch environment on the node if you rely on the canary's CUDA check."
    });
  }

  // "every GPU busy" only fires when there IS at least one GPU and ALL of them are busy (a fully
  // occupied node). A zero-GPU node already produced the gpu-unavailable error above.
  if (report.gpus.length > 0 && report.gpus.every(isGpuBusy)) {
    findings.push({
      level: "warning",
      code: "gpu-busy",
      path: "node",
      message: `all ${report.gpus.length} GPU(s) on the node are busy (utilization/memory over the busy threshold).`,
      suggestion: "Another tenant is using the node — launching now may queue/OOM; pick a freer node or wait."
    });
  }

  return findings;
}

// A single fail-closed finding for an unverifiable node (non-zero exit / timeout / unparseable JSON).
// An unverifiable node is NEVER treated as healthy — the whole point of the canary is to refuse to
// occupy a node we could not probe.
function nodeUnverifiableFinding(reason: string): QueueFinding[] {
  return [
    {
      level: "error",
      code: "node-unverifiable",
      path: "node",
      message: `could not verify the node before launch: ${reason}.`,
      suggestion: "Check connectivity to the node (and that python3 is on it) before occupying it; failing closed."
    }
  ];
}

// probeNodeCanary — the brain side of the opt-in canary. Validates `node` as a safe remote token, ships
// the FIXED CANARY_PY over the existing two-hop sshSupervisorArgs seam (encodeSpec carries only
// {kind:"canary"} — the probe ignores it), parses the JSON last line, and maps it to QueueFinding[].
// FAIL-CLOSED: a non-zero exit, a timeout, or unparseable JSON yields a node-unverifiable ERROR (never
// "healthy"). The default executor is the real runProcess; tests inject a stub.
export async function probeNodeCanary(
  profile: ComputeProfile,
  node: string,
  executor: CanaryExecutor = runProcess,
  timeoutMs: number = CANARY_DEFAULT_TIMEOUT_MS
): Promise<QueueFinding[]> {
  if (!isSafeRemoteToken(node)) {
    throw new Error(`Unsafe iHPC compute node id: ${node}`);
  }
  const bounded = normalizeTimeout(timeoutMs, { default: CANARY_DEFAULT_TIMEOUT_MS, max: CANARY_MAX_TIMEOUT_MS });
  const spec = encodeSpec({ kind: "canary" });
  const args = sshSupervisorArgs(profile.login.host_alias, node, bounded, spec);

  let result: CommandResult;
  try {
    result = await executor("ssh", args, bounded, CANARY_PY);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return nodeUnverifiableFinding(`the probe could not be run (${reason})`);
  }

  if (result.timedOut) {
    return nodeUnverifiableFinding("the probe timed out");
  }
  if (result.exitCode !== 0) {
    const reason = (result.stderr || `exit ${String(result.exitCode)}`).trim().split(/\r?\n/)[0];
    return nodeUnverifiableFinding(`the probe exited non-zero (${reason})`);
  }

  let parsed: unknown;
  try {
    parsed = parseJsonLastLine(result.stdout, "iHPC node canary");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return nodeUnverifiableFinding(reason);
  }
  const report = asCanaryReport(parsed);
  if (report === null) {
    return nodeUnverifiableFinding("the probe returned an unexpected JSON shape");
  }

  return mapCanaryReportToFindings(report);
}

// The full ihpc.campaign.preflight ops function the MCP handler binds. It runs the PURE-LOCAL
// validateQueueContract ALWAYS, and — ONLY when BOTH profileId and node are provided — additionally
// runs the opt-in on-node canary and concatenates its findings. With neither (the default), behavior is
// byte-identical to the pre-canary tool: pure local, no SSH (the executor is never touched). The
// executor + configPath are injectable for tests; production uses runProcess + the default config.
export interface IhpcPreflightInput {
  // Provide EXACTLY ONE of queueYaml (a pre-parsed object) or queueYamlPath (a confined local path to an
  // operator's existing hand-written queue YAML, read + parsed here). The latter lets the plugin validate
  // a file the operator already maintains, instead of only an in-memory object.
  queueYaml?: unknown;
  queueYamlPath?: string;
  datasetDirs?: string[];
  parameterSpace?: Record<string, unknown>;
  profileId?: string;
  node?: string;
  timeoutMs?: number;
}

// Resolve the queue object to validate from EXACTLY ONE of queueYaml / queueYamlPath. The path read is
// LOCAL and CONFINED: relative paths resolve against the project root and absolute / traversal paths that
// escape it are rejected (assertInsideProject), mirroring how docs.search / transfers confine the only
// caller-influenced local paths. No SSH on this path.
function resolveQueueYaml(input: IhpcPreflightInput): unknown {
  const hasInline = input.queueYaml !== undefined;
  const hasPath = input.queueYamlPath !== undefined;
  if (hasInline === hasPath) {
    throw new Error("ihpc.campaign.preflight requires exactly one of queueYaml or queueYamlPath.");
  }
  if (hasInline) {
    return input.queueYaml;
  }
  const resolved = assertInsideProject(input.queueYamlPath as string, "Queue YAML path");
  // assertInsideProject is lexical; also realpath-confine so a symlink living inside the project but
  // pointing OUTSIDE it (e.g. -> /etc/secrets) is refused before the read — defense-in-depth beyond
  // the established docs.search/transfer pattern, since this path is operator-influenced.
  assertRealPathInside(resolved, projectRoot, "Queue YAML path");
  const text = fs.readFileSync(resolved, "utf8");
  return YAML.parse(text);
}

export interface IhpcPreflightOptions {
  executor?: CanaryExecutor;
  configPath?: string;
}

export interface IhpcPreflightResult {
  preflight: { valid: boolean; findings: QueueFinding[] };
}

export async function runIhpcPreflight(
  input: IhpcPreflightInput,
  options: IhpcPreflightOptions = {}
): Promise<IhpcPreflightResult> {
  const queueYaml = resolveQueueYaml(input);
  const localFindings = validateQueueContract(queueYaml, input.datasetDirs, input.parameterSpace);

  // Opt-in node canary ONLY when BOTH profileId and node are supplied. The default path NEVER touches
  // the executor (pure-local, no SSH) — this is the security/parity invariant the audit requires.
  let canaryFindings: QueueFinding[] = [];
  if (input.profileId !== undefined && input.node !== undefined) {
    const profile = getProfile(input.profileId, options.configPath);
    if (profile.platform !== PLATFORM.IHPC) {
      throw new Error(
        `Profile ${profile.profile_id} is for ${profile.platform}, but the node canary requires a uts-ihpc profile`
      );
    }
    canaryFindings = await probeNodeCanary(profile, input.node, options.executor ?? runProcess, input.timeoutMs);
  }

  const findings = [...localFindings, ...canaryFindings];
  return { preflight: { valid: findings.every((finding) => finding.level !== "error"), findings } };
}
