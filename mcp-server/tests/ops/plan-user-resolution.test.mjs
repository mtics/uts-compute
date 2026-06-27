import assert from "node:assert/strict";
import test from "node:test";
import { planJob } from "../../dist/ops/plans/planner.js";
import { readExample, tempRuntimeDir, writeProfileConfig } from "../helpers/index.mjs";

const cetusProfile = {
  profile_id: "uts-hpc-cetus-test",
  platform: "uts-hpc",
  account_label: "cetus-test",
  login: {
    host_alias: "u00000001@hpc-login.example.invalid",
    username_ref: "UTS_HPC_CETUS_USER",
    ssh_agent: false,
    requires_vpn: true
  },
  defaults: { queue: "smallq", workspace: "/shared/homes/${USER}" },
  quota_snapshot: null
};

test("jobs.plan resolves ${USER} to the real account in PBS log paths when host_alias carries it", () => {
  const planDir = tempRuntimeDir("test-user-plans");
  const auditDir = tempRuntimeDir("test-user-runs");
  const configPath = writeProfileConfig("cetus", [cetusProfile]);
  const job = readExample("hpc-cpu.json");
  job.run_id = "user-resolve-001";
  job.profile_id = "uts-hpc-cetus-test";
  delete job.workdir; // derive from profile workspace
  job.resources = { queue: "smallq", ncpus: 1, memory_gb: 1, walltime: "00:05:00", ngpus: 0 };

  const plan = planJob(job, { planDir, auditDir, configPath });

  assert.equal(plan.normalized_job_spec.workdir, "/shared/homes/u00000001/user-resolve-001");
  assert.match(plan.script, /#PBS -o \/shared\/homes\/u00000001\/user-resolve-001\/logs\/user-resolve-001\.out/);
  assert.match(plan.script, /#PBS -e \/shared\/homes\/u00000001\/user-resolve-001\/logs\/user-resolve-001\.err/);
  assert.match(plan.script, /cd "\/shared\/homes\/u00000001\/user-resolve-001"/);
  assert.equal(plan.script.includes("${USER}"), false);
});

test("jobs.plan keeps ${USER} literal when host_alias carries no resolvable user", () => {
  // example profile uts-hpc-account-a host_alias 'uts-hpc' has no '@', so paths stay account-agnostic
  const plan = planJob(readExample("hpc-cpu.json"), { auditDir: tempRuntimeDir("test-user-runs"), writeAudit: false });
  assert.equal(plan.script.includes("${USER}"), true);
});
