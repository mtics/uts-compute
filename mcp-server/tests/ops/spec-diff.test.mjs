import assert from "node:assert/strict";
import test from "node:test";
import { diffJobSpecs } from "../../dist/ops/plans/spec-diff.js";

const base = {
  run_id: "a",
  profile_id: "uts-hpc-account-a",
  platform: "uts-hpc",
  experiment: { name: "exp" },
  resources: { queue: "smallq", ncpus: 2, memory_gb: 4, walltime: "01:00:00", ngpus: 0 },
  command: "python a.py"
};

test("diffJobSpecs reports changed resource fields and a changed command", () => {
  const next = {
    ...base,
    resources: { ...base.resources, memory_gb: 16, walltime: "04:00:00" },
    command: "python b.py"
  };
  const changes = diffJobSpecs(base, next);
  const fields = changes.map((c) => c.field);
  assert.ok(fields.includes("resources.memory_gb"));
  assert.ok(fields.includes("resources.walltime"));
  assert.ok(fields.includes("command"));
  assert.ok(!fields.includes("resources.ncpus"));
  const mem = changes.find((c) => c.field === "resources.memory_gb");
  assert.equal(mem.from, 4);
  assert.equal(mem.to, 16);
});

test("diffJobSpecs returns no changes for identical specs", () => {
  assert.deepEqual(diffJobSpecs(base, { ...base }), []);
});
