// Unit tests for the run-semantics module (U1): classifyRun + the resolveFieldState matrix. Pure module,
// no DOM — runs under `node --test`. These assertions ARE the structural contract; a matrix change must
// update them deliberately.
import assert from "node:assert/strict";
import test from "node:test";
import {
  RUN_KIND,
  FIELD_STATE,
  classifyRun,
  runIsAdopted,
  resolveFieldState,
  fieldStateToken,
  isPlottable
} from "../public/run-semantics.js";

const plannedHpc = {
  platform: "uts-hpc",
  status: "running",
  plan_hash: "abc123",
  reproducibility: { git: { sha: "deadbeef" } },
  project: "uts-computing-platform",
  queue: "smallq",
  submission: { node: "hpc-exec01", requested: { ncpus: 4, memory_gb: 16 } }
};
const adoptedHpc = {
  platform: "uts-hpc",
  status: "running",
  remote_job_id: "3686.hpc-head01",
  submission: { node: "hpc-exec03", requested: {} }
};
const adoptedHpcWithUsage = {
  ...adoptedHpc,
  usage: { core_hours: 254.16, gpu_hours: 42.36, mem_gb: 11.51, ncpus: 12, ngpus: 2 }
};
const adoptedHpcTerminal = { ...adoptedHpc, status: "finished" };
const adoptedIhpc = {
  platform: "uts-ihpc",
  status: "running",
  remote_job_id: "ihpc-mmfedavg-beauty-deep-mainhpo-3174690",
  observed: { node: "venus6", pid: 3174690 },
  submission: { node: "venus6", requested: {} }
};

test("classifyRun separates planned from adopted, HPC from iHPC", () => {
  assert.equal(classifyRun(plannedHpc), RUN_KIND.PLANNED_HPC);
  assert.equal(classifyRun(adoptedHpc), RUN_KIND.ADOPTED_HPC);
  assert.equal(classifyRun(adoptedIhpc), RUN_KIND.ADOPTED_IHPC);
  assert.equal(runIsAdopted(plannedHpc), false);
  assert.equal(runIsAdopted(adoptedHpc), true);
});

test("explicit run_class / adopted flag overrides inference", () => {
  assert.equal(classifyRun({ platform: "uts-hpc", run_class: "adopted-hpc", plan_hash: "x" }), RUN_KIND.ADOPTED_HPC);
  assert.equal(runIsAdopted({ adopted: false, plan_hash: undefined }), false);
});

test("usage: iHPC is not_applicable (no batch accounting); HPC pending while active, present when captured", () => {
  assert.equal(resolveFieldState(adoptedIhpc, "usage").state, FIELD_STATE.NOT_APPLICABLE);
  assert.equal(resolveFieldState(adoptedHpc, "usage").state, FIELD_STATE.PENDING);
  assert.equal(resolveFieldState(adoptedHpcWithUsage, "usage").state, FIELD_STATE.PRESENT);
});

test("usage: a terminal HPC run with no usage is UNKNOWN (loud — a real gap, not n/a)", () => {
  assert.equal(resolveFieldState(adoptedHpcTerminal, "usage").state, FIELD_STATE.UNKNOWN);
});

test("requested: present for planned, pending for adopted-HPC (recoverable), n/a for adopted-iHPC", () => {
  assert.equal(resolveFieldState(plannedHpc, "requested").state, FIELD_STATE.PRESENT);
  assert.equal(resolveFieldState(adoptedHpc, "requested").state, FIELD_STATE.PENDING);
  assert.equal(resolveFieldState(adoptedIhpc, "requested").state, FIELD_STATE.NOT_APPLICABLE);
});

test("queue: present for planned-HPC, pending for adopted-HPC, n/a for iHPC", () => {
  assert.equal(resolveFieldState(plannedHpc, "queue").state, FIELD_STATE.PRESENT);
  assert.equal(resolveFieldState(adoptedHpc, "queue").state, FIELD_STATE.PENDING);
  assert.equal(resolveFieldState(adoptedIhpc, "queue").state, FIELD_STATE.NOT_APPLICABLE);
});

test("plan/project/reproducibility: present for planned, not_applicable for adopted", () => {
  for (const field of ["plan", "project", "reproducibility"]) {
    assert.equal(resolveFieldState(plannedHpc, field).state, FIELD_STATE.PRESENT, `${field} planned`);
    assert.equal(resolveFieldState(adoptedHpc, field).state, FIELD_STATE.NOT_APPLICABLE, `${field} adopted`);
  }
});

test("plan: a planned run missing its plan_hash is UNKNOWN", () => {
  assert.equal(resolveFieldState({ platform: "uts-hpc", status: "running", reproducibility: {} }, "plan").state, FIELD_STATE.UNKNOWN);
});

test("node: present when known; pending while active without a node", () => {
  assert.equal(resolveFieldState(adoptedIhpc, "node").state, FIELD_STATE.PRESENT);
  assert.equal(resolveFieldState({ platform: "uts-hpc", status: "running" }, "node").state, FIELD_STATE.PENDING);
  assert.equal(resolveFieldState({ platform: "uts-hpc", status: "planned" }, "node").state, FIELD_STATE.NOT_APPLICABLE);
});

test("placement: n/a for PBS, pending for iHPC without one", () => {
  assert.equal(resolveFieldState(adoptedHpc, "placement").state, FIELD_STATE.NOT_APPLICABLE);
  assert.equal(resolveFieldState(adoptedIhpc, "placement").state, FIELD_STATE.PENDING);
});

test("liveness/gpu: pending for adopted-iHPC (probe via refresh), n/a otherwise", () => {
  assert.equal(resolveFieldState(adoptedIhpc, "liveness").state, FIELD_STATE.PENDING);
  assert.equal(resolveFieldState(adoptedIhpc, "gpu").state, FIELD_STATE.PENDING);
  assert.equal(resolveFieldState(plannedHpc, "gpu").state, FIELD_STATE.NOT_APPLICABLE);
  // present once the observe result is attached
  assert.equal(resolveFieldState({ ...adoptedIhpc, gpu_usage: { status: "ok", gpus: [] } }, "gpu").state, FIELD_STATE.PRESENT);
});

test("fieldStateToken distinguishes the three non-present states", () => {
  assert.equal(fieldStateToken(resolveFieldState(adoptedHpc, "usage")), "pending");
  assert.equal(fieldStateToken(resolveFieldState(adoptedIhpc, "usage")), "n/a");
  assert.equal(fieldStateToken(resolveFieldState(adoptedHpcTerminal, "usage")), "missing");
  assert.equal(fieldStateToken(resolveFieldState(adoptedHpcWithUsage, "usage")), "");
});

test("isPlottable is true only when the field is present (Explore must not silently drop the rest)", () => {
  assert.equal(isPlottable(adoptedHpcWithUsage, "usage"), true);
  assert.equal(isPlottable(adoptedHpc, "usage"), false);
  assert.equal(isPlottable(adoptedIhpc, "usage"), false);
  assert.equal(isPlottable(plannedHpc, "requested"), true);
});
