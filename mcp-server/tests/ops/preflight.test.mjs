import assert from "node:assert/strict";
import test from "node:test";
import { validateQueueContract } from "../../dist/ops/jobs/ihpc-preflight.js";

// P9: validateQueueContract is a PURE, LOCAL primitive — no SSH. It validates the queue-YAML contract
// (my_nodes / experiments structure), checks each experiment's --dataset CLI token against a
// caller-supplied datasetDirs allowlist (case-sensitive: MovieLens != ML), and parses the embedded
// --param_overrides '...' JSON (optionally Ajv-validating it against a parameter_space). Findings carry
// the new { level, path, message, suggestion? } QueueFinding shape.

const goodYaml = {
  my_nodes: [{ hostname: "venus01", gpu_count: 2 }],
  experiments: [
    {
      name: "e1",
      command: "python train.py --dataset MovieLens --param_overrides '{\"learning_rate\":0.01}'",
      requires_gpu: true
    }
  ]
};

test("valid queue YAML + present dataset -> no errors", () => {
  const f = validateQueueContract(goodYaml, ["MovieLens", "Cards"]);
  assert.equal(f.filter((x) => x.level === "error").length, 0);
});

test("missing my_nodes / empty experiments -> structural errors", () => {
  assert.ok(validateQueueContract({ experiments: [] }).some((x) => x.level === "error"));
});

test("dataset typo (--dataset MovieLens) vs available ['ML'] is flagged (case-sensitive)", () => {
  const f = validateQueueContract(goodYaml, ["ML", "Cards"]); // MovieLens not present, ML != MovieLens
  assert.ok(f.some((x) => /dataset|MovieLens/.test(x.message)));
});

test("malformed param_overrides JSON -> error", () => {
  const bad = {
    my_nodes: [{ hostname: "v" }],
    experiments: [{ name: "e", command: "python x --param_overrides '{not json}'", requires_gpu: false }]
  };
  assert.ok(validateQueueContract(bad).some((x) => /param_overrides|json/i.test(x.message)));
});

test("param_overrides validated against an optional parameter_space", () => {
  const space = { type: "object", properties: { learning_rate: { type: "number" } }, additionalProperties: false };
  assert.equal(validateQueueContract(goodYaml, ["MovieLens"], space).filter((x) => x.level === "error").length, 0);
});

// L2: the dataset allowlist check (which P3's ihpc.campaign.generate relies on for "preflight-clean by
// construction") must also catch the `--dataset=<value>` equals form, not only `--dataset <value>`.
test("dataset typo in the --dataset=<value> equals form is flagged", () => {
  const yaml = {
    my_nodes: [{ hostname: "venus01" }],
    experiments: [{ name: "e1", command: "python train.py --dataset=Unknown", requires_gpu: true }]
  };
  const f = validateQueueContract(yaml, ["MovieLens", "Cards"]);
  assert.ok(f.some((x) => x.level === "error" && /dataset|Unknown/.test(x.message)), "--dataset=Unknown must be caught");
});

test("present dataset in the --dataset=<value> equals form passes the allowlist", () => {
  const yaml = {
    my_nodes: [{ hostname: "venus01" }],
    experiments: [{ name: "e1", command: "python train.py --dataset=MovieLens", requires_gpu: true }]
  };
  assert.equal(validateQueueContract(yaml, ["MovieLens", "Cards"]).filter((x) => x.level === "error").length, 0);
});

// L2: --param_overrides also appears double-quoted, with the inner JSON using standard double quotes.
test("double-quoted --param_overrides is parsed and validated", () => {
  const space = { type: "object", properties: { learning_rate: { type: "number" } }, additionalProperties: false };
  const yamlJson = {
    my_nodes: [{ hostname: "venus01" }],
    experiments: [
      { name: "e1", command: 'python train.py --dataset MovieLens --param_overrides "{\\"learning_rate\\":0.01}"', requires_gpu: true }
    ]
  };
  assert.equal(validateQueueContract(yamlJson, ["MovieLens"], space).filter((x) => x.level === "error").length, 0);
});

test("malformed double-quoted --param_overrides JSON is flagged", () => {
  const bad = {
    my_nodes: [{ hostname: "v" }],
    experiments: [{ name: "e", command: 'python x --param_overrides "{not json}"', requires_gpu: false }]
  };
  assert.ok(validateQueueContract(bad).some((x) => /param_overrides|json/i.test(x.message)));
});
