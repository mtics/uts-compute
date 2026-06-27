import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { readExample, tempRuntimeDir } from "../helpers/index.mjs";

// Stub the injectable git seam: answer both the project probe (--show-toplevel) and the
// reproducibility probe (HEAD / abbrev-ref / status) so planJob runs end to end offline.
function gitRunnerFor(toplevel) {
  return (args) => {
    const key = args.join(" ");
    if (key === "rev-parse --show-toplevel") return { ok: true, stdout: toplevel };
    if (key === "rev-parse HEAD") return { ok: true, stdout: "a".repeat(40) };
    if (key === "rev-parse --abbrev-ref HEAD") return { ok: true, stdout: "main" };
    if (key === "status --porcelain") return { ok: true, stdout: "" };
    return { ok: false, stdout: "" };
  };
}

test("planJob writes the git-derived project and project_hash into the run record", () => {
  const job = readExample("hpc-cpu.json");
  job.run_id = "proj-plan-a";
  const plan = planJob(job, {
    planDir: tempRuntimeDir("proj-plans"),
    auditDir: tempRuntimeDir("proj-runs"),
    gitRunner: gitRunnerFor("/home/u/Diffusion Ablation")
  });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.equal(record.project, "diffusion-ablation");
  assert.match(record.project_hash, /^proj-[0-9a-f]{12}$/);
});

test("project never affects plan_hash: same spec, different repo => same plan_hash", () => {
  const job = readExample("hpc-cpu.json");
  job.run_id = "proj-invariant";
  const planAlpha = planJob(job, {
    planDir: tempRuntimeDir("pa"),
    auditDir: tempRuntimeDir("pa"),
    gitRunner: gitRunnerFor("/home/u/project-alpha")
  });
  const planBeta = planJob(job, {
    planDir: tempRuntimeDir("pb"),
    auditDir: tempRuntimeDir("pb"),
    gitRunner: gitRunnerFor("/home/u/project-beta")
  });
  assert.equal(planAlpha.plan_hash, planBeta.plan_hash);
  const recAlpha = JSON.parse(fs.readFileSync(planAlpha.audit_path, "utf8"));
  const recBeta = JSON.parse(fs.readFileSync(planBeta.audit_path, "utf8"));
  assert.notEqual(recAlpha.project_hash, recBeta.project_hash);
});

test("planJob attaches a spec_diff against the latest prior run of the same project", () => {
  const dirs = {
    planDir: tempRuntimeDir("sd-p"),
    auditDir: tempRuntimeDir("sd-r"),
    gitRunner: gitRunnerFor("/home/u/spec-diff-proj")
  };
  const job1 = readExample("hpc-cpu.json");
  job1.run_id = "sd-first";
  job1.resources.memory_gb = 4;
  planJob(job1, dirs);

  const job2 = readExample("hpc-cpu.json");
  job2.run_id = "sd-second";
  job2.resources.memory_gb = 16;
  const plan2 = planJob(job2, dirs);

  assert.ok(plan2.spec_diff, "spec_diff present");
  assert.equal(plan2.spec_diff.against_run_id, "sd-first");
  const mem = plan2.spec_diff.changes.find((c) => c.field === "resources.memory_gb");
  assert.ok(mem);
  assert.equal(mem.from, 4);
  assert.equal(mem.to, 16);
});

test("planJob writes campaign_id onto the run record but never into plan_hash", () => {
  const dirs = (suffix) => ({
    planDir: tempRuntimeDir(`camp-p-${suffix}`),
    auditDir: tempRuntimeDir(`camp-r-${suffix}`),
    gitRunner: gitRunnerFor("/home/u/proj")
  });
  const job = readExample("hpc-cpu.json");
  job.run_id = "camp-plan-a";
  const plan = planJob(job, { ...dirs("a"), campaignId: "camp-alpha" });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.equal(record.campaign_id, "camp-alpha");

  // Same spec, different campaign id => identical plan_hash (campaign_id is organizational metadata,
  // exactly like project — never hashed into the normalized spec).
  const job2 = readExample("hpc-cpu.json");
  job2.run_id = "camp-plan-a";
  const plan2 = planJob(job2, { ...dirs("b"), campaignId: "camp-beta" });
  assert.equal(plan.plan_hash, plan2.plan_hash);

  // Omitting campaignId leaves campaign_id absent on the record (adopted/plain plans declare none).
  const job3 = readExample("hpc-cpu.json");
  job3.run_id = "camp-plan-none";
  const plan3 = planJob(job3, dirs("c"));
  const record3 = JSON.parse(fs.readFileSync(plan3.audit_path, "utf8"));
  assert.equal(record3.campaign_id, undefined);
});

test("planJob records experiment.job_type lineage into the run record", () => {
  const job = readExample("hpc-cpu.json");
  job.run_id = "lineage-a";
  job.experiment.job_type = "train";
  const plan = planJob(job, {
    planDir: tempRuntimeDir("lin-p"),
    auditDir: tempRuntimeDir("lin-r"),
    gitRunner: gitRunnerFor("/home/u/proj")
  });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.equal(record.job_type, "train");
});

test("planJob outside a git repo records the unassigned project", () => {
  const job = readExample("hpc-cpu.json");
  job.run_id = "proj-nogit-a";
  const plan = planJob(job, {
    planDir: tempRuntimeDir("proj-nogit-p"),
    auditDir: tempRuntimeDir("proj-nogit-r"),
    gitRunner: () => ({ ok: false, stdout: "" })
  });
  const record = JSON.parse(fs.readFileSync(plan.audit_path, "utf8"));
  assert.equal(record.project, "unassigned");
  assert.match(record.project_hash, /^proj-[0-9a-f]{12}$/);
});
