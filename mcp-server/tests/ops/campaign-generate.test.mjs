import assert from "node:assert/strict";
import test from "node:test";
import YAML from "yaml";
import { generateCampaignQueue } from "../../dist/ops/jobs/ihpc-generate.js";
import { validateQueueContract } from "../../dist/ops/jobs/ihpc-preflight.js";

// P3: generateCampaignQueue is a PURE, LOCAL, dry-run primitive (no SSH). It emits a canonical
// scheduler queue YAML from structured inputs and is GUARANTEED preflight-clean by construction: it
// runs validateQueueContract internally and REFUSES to emit when any error-level finding would fire.
// Output round-trips through YAML and the parsed queue passes the very same preflight the plugin
// already ships (ihpc.campaign.preflight). This closes the loop: generate -> preflight -> submit.

const goodInput = {
  myNodes: [
    "turing2",
    { hostname: "turing1", gpus: [1] },
    { hostname: "neptune5", block_gpus: [0] }
  ],
  experiments: [
    {
      name: "bert-lr1e-4",
      command:
        "conda activate nlp && cd ~/Data/Workspace/proj && python train.py --dataset MovieLens --param_overrides '{\"learning_rate\":1e-4}'",
      requires_gpu: true
    },
    {
      name: "preprocess",
      command: "conda activate base && python preprocess.py",
      requires_gpu: false
    }
  ],
  datasetDirs: ["MovieLens", "Cards"]
};

test("generate emits a canonical queue YAML that round-trips and PASSES preflight", () => {
  const result = generateCampaignQueue(goodInput);

  // The emitted text is a string of YAML that parses back to a queue object.
  assert.equal(typeof result.generate.yaml, "string");
  const parsed = YAML.parse(result.generate.yaml);

  // Canonical structure: my_nodes (preserving the per-node spec shape) + experiments.
  assert.deepEqual(parsed.my_nodes, [
    "turing2",
    { hostname: "turing1", gpus: [1] },
    { hostname: "neptune5", block_gpus: [0] }
  ]);
  assert.equal(parsed.experiments.length, 2);
  assert.equal(parsed.experiments[0].name, "bert-lr1e-4");
  assert.equal(parsed.experiments[0].requires_gpu, true);
  assert.equal(parsed.experiments[1].requires_gpu, false);

  // GUARANTEE: the round-tripped YAML passes the SAME preflight contract the plugin validates with,
  // using the datasetDirs the caller supplied.
  const findings = validateQueueContract(parsed, goodInput.datasetDirs);
  assert.equal(findings.filter((f) => f.level === "error").length, 0);

  // The result also surfaces the coupled preflight verdict and a deterministic content hash.
  assert.equal(result.generate.preflight.valid, true);
  assert.equal(result.generate.preflight.findings.filter((f) => f.level === "error").length, 0);
  assert.match(result.generate.content_hash, /^[a-f0-9]{64}$/);
});

test("generate is deterministic — same input -> byte-identical YAML and content hash", () => {
  const a = generateCampaignQueue(goodInput);
  const b = generateCampaignQueue(goodInput);
  assert.equal(a.generate.yaml, b.generate.yaml);
  assert.equal(a.generate.content_hash, b.generate.content_hash);
});

test("generate REFUSES a --dataset not in datasetDirs (coupled to preflight, fail-closed)", () => {
  const bad = {
    myNodes: ["turing2"],
    experiments: [
      { name: "e", command: "python train.py --dataset ML", requires_gpu: true } // ML != MovieLens
    ],
    datasetDirs: ["MovieLens"]
  };
  assert.throws(() => generateCampaignQueue(bad), /preflight|dataset|ML/i);
});

// L2: the equals form (`--dataset=Unknown`) was previously invisible to the dataset allowlist check, so
// generation would NOT refuse a typo'd dataset in that form. It must now refuse, keeping generation
// preflight-clean by construction regardless of which --dataset spelling the operator used.
test("generate REFUSES a --dataset=<value> equals-form typo", () => {
  const bad = {
    myNodes: ["turing2"],
    experiments: [
      { name: "e", command: "python train.py --dataset=Unknown", requires_gpu: true } // Unknown not in datasetDirs
    ],
    datasetDirs: ["MovieLens"]
  };
  assert.throws(() => generateCampaignQueue(bad), /preflight|dataset|Unknown/i);
});

test("generate REFUSES a malformed --param_overrides JSON payload", () => {
  const bad = {
    myNodes: ["turing2"],
    experiments: [{ name: "e", command: "python x --param_overrides '{not json}'", requires_gpu: false }]
  };
  assert.throws(() => generateCampaignQueue(bad), /preflight|param_overrides|json/i);
});

test("generate REFUSES empty experiments / empty my_nodes (structural contract)", () => {
  assert.throws(() => generateCampaignQueue({ myNodes: [], experiments: [] }), /preflight|my_nodes|experiments/i);
});

test("generate honors an optional parameter_space and refuses overrides that violate it", () => {
  const space = { type: "object", properties: { learning_rate: { type: "number" } }, additionalProperties: false };
  const bad = {
    myNodes: ["turing2"],
    experiments: [
      {
        name: "e",
        command: "python train.py --param_overrides '{\"learning_rate\":\"oops\"}'",
        requires_gpu: true
      }
    ],
    parameterSpace: space
  };
  assert.throws(() => generateCampaignQueue(bad), /preflight|parameter_space|learning_rate/i);
});

test("generate carries optional queue-local scheduler overrides through verbatim", () => {
  const result = generateCampaignQueue({
    ...goodInput,
    scheduler: { slots_per_gpu: 1, gpu_free_threshold_pct: 40, respect_external_gpu_processes: true }
  });
  const parsed = YAML.parse(result.generate.yaml);
  assert.deepEqual(parsed.scheduler, {
    slots_per_gpu: 1,
    gpu_free_threshold_pct: 40,
    respect_external_gpu_processes: true
  });
});
