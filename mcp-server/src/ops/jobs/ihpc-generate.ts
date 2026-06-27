// mcp-server/src/ops/jobs/ihpc-generate.ts
// P3: GENERATE a canonical scheduler queue YAML from structured inputs — the dry-run, LOCAL, NO-SSH
// counterpart to ihpc.campaign.preflight. ihpc-sched consumes a `queue.yaml` (my_nodes + experiments);
// the plugin could VALIDATE one but not EMIT one, so operators hand-wrote dozens of queue.*.yaml files
// and maintained external gen_*.py scripts the plugin can't see. This closes the loop so the plugin OWNS
// the format end-to-end: generate -> preflight -> (existing) campaign.submit.
//
// The generator is COUPLED to preflight: after building the queue structure it runs the EXACT same
// validateQueueContract the preflight tool uses, and REFUSES to emit (throws) if any error-level finding
// would fire. A file produced here is therefore preflight-clean by construction. Like jobs.plan /
// sweep.plan it is pure + deterministic + dry-run: no SSH, no GPU probing, no state mutation. It returns
// the canonical YAML text, the parsed queue object, the coupled preflight verdict, and a deterministic
// content_hash (sha256 of the emitted YAML) so a caller can record/diff what it generated.
import YAML from "yaml";
import { sha256Hex } from "../../lib/shared.js";
import { validateQueueContract, type QueueFinding } from "./ihpc-preflight.js";

// A single node the scheduler may use. Mirrors queue.example.yaml exactly: either a bare hostname string
// ("turing2") or a mapping { hostname, gpus?, block_gpus? } to pin/exclude specific GPU indices. We keep
// the union (not just the object form) so a generated file is byte-faithful to how operators write them.
export interface QueueNodeSpec {
  hostname: string;
  gpus?: number[];
  block_gpus?: number[];
}
export type QueueNode = string | QueueNodeSpec;

// One experiment row: name + command + requires_gpu (the launch contract preflight enforces). The
// command is the operator's own shell line (conda activate ... && cd ... && python ...); it is emitted
// VERBATIM — this is a local config generator, not a remote executor, so nothing here runs the command.
export interface QueueExperimentSpec {
  name: string;
  command: string;
  requires_gpu: boolean;
}

// Optional queue-local scheduler overrides (slots_per_gpu, gpu_free_threshold_pct, ...). These override
// config.yaml's scheduler: block only for this queue (per queue.example.yaml). Passed through verbatim;
// preflight does not constrain them, so we keep them a permissive record.
export type QueueSchedulerOverrides = Record<string, unknown>;

export interface CampaignGenerateInput {
  myNodes: QueueNode[];
  experiments: QueueExperimentSpec[];
  // Optional, but recommended: the same allowlist preflight uses to catch a --dataset typo at GENERATE
  // time (so a generated file can never reference a dataset the operator does not actually have).
  datasetDirs?: string[];
  // Optional JSON Schema for the embedded --param_overrides object, enforced at generate time too.
  parameterSpace?: Record<string, unknown>;
  scheduler?: QueueSchedulerOverrides;
}

export interface CampaignGenerateResult {
  generate: {
    yaml: string;
    queue: Record<string, unknown>;
    content_hash: string;
    preflight: { valid: boolean; findings: QueueFinding[] };
  };
}

// Build the canonical queue object in queue.example.yaml's exact shape: my_nodes first, then optional
// queue-local scheduler:, then experiments. Each node spec is normalized to a bare string when only a
// hostname is given (so generated files match how operators write the common case), or a mapping that
// preserves gpus/block_gpus when present. Experiment rows carry only the three contract fields.
function buildQueueObject(input: CampaignGenerateInput): Record<string, unknown> {
  const my_nodes = input.myNodes.map((node) => {
    if (typeof node === "string") {
      return node;
    }
    const spec: Record<string, unknown> = { hostname: node.hostname };
    if (node.gpus !== undefined) {
      spec.gpus = node.gpus;
    }
    if (node.block_gpus !== undefined) {
      spec.block_gpus = node.block_gpus;
    }
    return spec;
  });

  const queue: Record<string, unknown> = { my_nodes };

  // scheduler: sits between my_nodes and experiments in the canonical example; keep that ordering.
  if (input.scheduler !== undefined) {
    queue.scheduler = input.scheduler;
  }

  queue.experiments = input.experiments.map((experiment) => ({
    name: experiment.name,
    command: experiment.command,
    requires_gpu: experiment.requires_gpu
  }));

  return queue;
}

/**
 * Generate a canonical scheduler queue YAML, GUARANTEED to pass ihpc.campaign.preflight.
 *
 * Pure, local, dry-run, deterministic: builds the queue structure, validates it with the SAME
 * validateQueueContract the preflight tool runs, and REFUSES to emit (throws) when any error-level
 * finding would fire. The returned `content_hash` is the sha256 of the emitted YAML text.
 */
export function generateCampaignQueue(input: CampaignGenerateInput): CampaignGenerateResult {
  const queue = buildQueueObject(input);

  // COUPLING: run the exact preflight contract BEFORE emitting. A generated file must be preflight-clean
  // by construction, so any error-level finding here is fatal — we refuse to write/return a bad queue.
  const findings = validateQueueContract(queue, input.datasetDirs, input.parameterSpace);
  const errors = findings.filter((finding) => finding.level === "error");
  if (errors.length > 0) {
    const detail = errors.map((finding) => `${finding.path || "(root)"}: ${finding.message}`).join("; ");
    throw new Error(
      `Refusing to generate a queue YAML that would fail preflight (${errors.length} error(s)): ${detail}`
    );
  }

  // Deterministic emit: a stable YAML serialization of the canonical object, hashed for record/diff.
  const yaml = YAML.stringify(queue);
  const content_hash = sha256Hex(Buffer.from(yaml, "utf8"));

  return {
    generate: {
      yaml,
      queue,
      content_hash,
      preflight: { valid: findings.every((finding) => finding.level !== "error"), findings }
    }
  };
}
