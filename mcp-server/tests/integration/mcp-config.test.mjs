// Regression test for the shipped Code-plugin .mcp.json config (Bug P1).
//
// The MCP config must point UTS_COMPUTING_CONFIG at a profiles file that is actually SHIPPED (the
// example), anchored to the plugin root via ${CLAUDE_PLUGIN_ROOT} — NOT the never-shipped
// profiles.local.yaml (which caused ENOENT for every profile-dependent tool). The P0 server fallback
// is the safety net, but the shipped default must itself be valid.
import assert from "node:assert/strict";
import test from "node:test";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../helpers/index.mjs";

// Validate the SHIPPED .mcp.json — i.e. the committed version — not the working-tree file. A developer
// may keep a local, never-committed override (e.g. `git update-index --skip-worktree .mcp.json` pointing
// UTS_COMPUTING_CONFIG at their real profiles.local.yaml); that legitimate local deviation must not fail
// this check, which is about what the plugin actually ships. Fall back to the working file when not in a
// git checkout (e.g. an unpacked install).
function readShippedMcpJson() {
  try {
    return execFileSync("git", ["show", "HEAD:.mcp.json"], { cwd: repoRoot, encoding: "utf8" });
  } catch {
    return fs.readFileSync(path.join(repoRoot, ".mcp.json"), "utf8");
  }
}

const mcp = JSON.parse(readShippedMcpJson());
const cfg = mcp.mcpServers?.["uts-compute"]?.env?.UTS_COMPUTING_CONFIG;

test(".mcp.json points UTS_COMPUTING_CONFIG at the bundled example via ${CLAUDE_PLUGIN_ROOT}", () => {
  assert.equal(cfg, "${CLAUDE_PLUGIN_ROOT}/profiles/profiles.example.yaml");
});

test(".mcp.json does not reference the never-shipped profiles.local.yaml", () => {
  assert.doesNotMatch(cfg ?? "", /profiles\.local\.yaml/);
});

test("the profiles file the .mcp.json config points at actually ships in the plugin root", () => {
  const rel = cfg.replace("${CLAUDE_PLUGIN_ROOT}/", "");
  assert.ok(fs.existsSync(path.join(repoRoot, rel)), `${rel} must exist`);
});

// C2: the shipped .mcp.json must wire the approval token from user_config so token-gated operations
// (approvals.decide, state.migrate.apply, and the cancel/cleanup paths that consume an approved
// record) are actually usable. Reads the committed (HEAD) config, like the assertions above.
test(".mcp.json wires UTS_COMPUTING_APPROVAL_TOKEN to ${user_config.approval_token}", () => {
  const token = mcp.mcpServers?.["uts-compute"]?.env?.UTS_COMPUTING_APPROVAL_TOKEN;
  assert.equal(token, "${user_config.approval_token}");
});

test("manifest.json declares an optional approval_token user_config field and wires it into env", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
  assert.ok(manifest.user_config?.approval_token, "approval_token must be declared in user_config");
  assert.equal(manifest.user_config.approval_token.type, "string");
  assert.equal(manifest.user_config.approval_token.required, false);
  assert.equal(
    manifest.server?.mcp_config?.env?.UTS_COMPUTING_APPROVAL_TOKEN,
    "${user_config.approval_token}"
  );
});
