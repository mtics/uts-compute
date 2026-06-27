import assert from "node:assert/strict";
import test from "node:test";
import { buildEvidenceTemplate } from "../../../scripts/client-installed-smoke.mjs";
import { validateClientSmokeEvidence, validateClientSmokeEvidenceSet } from "../../../scripts/validate-client-smoke-evidence.mjs";

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}

function completedEvidence(client) {
  const evidence = clone(buildEvidenceTemplate(client));
  evidence.client_version = "test-client-1.0.0";
  evidence.observed_at = "2026-06-15T01:02:03.000Z";
  evidence.checks.state_migrate_plan.plan_hash = "a".repeat(64);
  evidence.checks.jobs_plan_dry_run.plan_hash = "b".repeat(64);
  evidence.checks.jobs_plan_dry_run.run_id = `client-smoke-${client}-abc123`;
  return evidence;
}

test("completed client-installed smoke evidence validates for both release clients", () => {
  const codex = completedEvidence("codex");
  const claude = completedEvidence("claude-code");

  assert.equal(validateClientSmokeEvidence(codex).ok, true);
  assert.equal(validateClientSmokeEvidence(claude).ok, true);

  const result = validateClientSmokeEvidenceSet(
    [
      { file: "codex.json", evidence: codex },
      { file: "claude-code.json", evidence: claude }
    ],
    { requireBothClients: true }
  );

  assert.equal(result.ok, true, JSON.stringify(result, null, 2));
  assert.equal(result.release_gate_passed, true);
  assert.deepEqual(result.clients_seen, ["claude-code", "codex"]);
});

test("client-installed smoke evidence requires both Codex and Claude Code for release gate", () => {
  const result = validateClientSmokeEvidenceSet([{ file: "codex.json", evidence: completedEvidence("codex") }], {
    requireBothClients: true,
    skipPackageValidation: true
  });

  assert.equal(result.ok, false);
  assert.equal(result.release_gate_passed, false);
  assert.ok(result.set_issues.some((issue) => issue.code === "missing-client" && issue.client === "claude-code"));
});

test("client-installed smoke evidence rejects unfilled prompt templates", () => {
  const result = validateClientSmokeEvidence(buildEvidenceTemplate("codex"));

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "placeholder-plan-hash"));
  assert.ok(result.issues.some((issue) => issue.code === "placeholder-run-id"));
});

test("client-installed smoke evidence rejects missing skill and a broken client install binding", () => {
  const evidence = completedEvidence("codex");
  evidence.checks.skills_discovered.skills = evidence.checks.skills_discovered.skills.filter((skill) => skill !== "stage-transfer");
  // Codex (mcp-config) must record how the MCP server was registered; blank breaks the binding.
  evidence.plugin.mcp_registration = "";

  const result = validateClientSmokeEvidence(evidence);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "missing-skill"));
  assert.ok(result.issues.some((issue) => issue.code === "codex-mcp-registration-missing"));
});

test("client-installed smoke evidence rejects a claude-code file claiming the Codex install method", () => {
  const evidence = completedEvidence("claude-code");
  evidence.plugin.install_method = "mcp-config";

  const result = validateClientSmokeEvidence(evidence);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "client-install-method" || issue.code === "schema"));
});

test("client-installed smoke evidence rejects local profile, secret, path, and forbidden tool leaks", () => {
  const evidence = completedEvidence("claude-code");
  evidence.notes = [
    "profiles.local.yaml was used",
    "password: should-not-appear",
    "/Users/example/private/path",
    "jobs.submit was called"
  ];

  const result = validateClientSmokeEvidence(evidence);

  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "profiles-local-leak"));
  assert.ok(result.issues.some((issue) => issue.code === "secret-like-leak"));
  assert.ok(result.issues.some((issue) => issue.code === "absolute-local-path-leak"));
  assert.ok(result.issues.some((issue) => issue.code === "forbidden-tool-mentioned"));
});
