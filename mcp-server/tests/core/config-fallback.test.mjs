// Regression tests for the config-path fallback (Bug P0).
//
// The server must stay alive (load profiles) when UTS_COMPUTING_CONFIG is (a) unset, (b) still holds an
// unsubstituted "${...}" token because the host did not substitute ${__dirname}/${CLAUDE_PLUGIN_ROOT}
// (the Desktop .mcpb does NOT substitute tokens inside user_config defaults), or (c) points at a
// nonexistent file (e.g. the never-shipped profiles.local.yaml). In all three it must fall back to the
// bundled example resolved from the SERVER's own location. A valid absolute path the operator supplies
// — including one outside the project root, as the Desktop "file" user_config yields — must load.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot } from "../helpers/index.mjs";
import { defaultConfigPath, effectiveConfigStatus, listProfiles } from "../../dist/core/config.js";

const EXAMPLE = path.join(repoRoot, "profiles", "profiles.example.yaml");
const real = (p) => fs.realpathSync(p);
const ENV = "UTS_COMPUTING_CONFIG";
const ORIG = process.env[ENV];

function setEnv(value) {
  if (value === undefined) delete process.env[ENV];
  else process.env[ENV] = value;
}
afterEach(() => setEnv(ORIG));

test("falls back to the bundled example when UTS_COMPUTING_CONFIG is unset (and returns an absolute path)", () => {
  setEnv(undefined);
  const resolved = defaultConfigPath();
  assert.ok(path.isAbsolute(resolved), "fallback path must be absolute, not CWD-relative");
  assert.equal(real(resolved), real(EXAMPLE));
  assert.ok(listProfiles().length > 0, "bundled example must load at least one profile");
});

test("falls back when the path still holds an unsubstituted ${...} token (no ENOENT on the literal)", () => {
  setEnv("${__dirname}/profiles/profiles.example.yaml");
  assert.equal(real(defaultConfigPath()), real(EXAMPLE));
  assert.doesNotThrow(() => listProfiles());
});

test("falls back when the configured file does not exist (e.g. an unshipped profiles file)", () => {
  // A path guaranteed not to exist (unique per run). Must NOT be profiles.local.yaml: that file
  // legitimately exists in a real dev checkout (the operator's untracked local profiles, per the
  // secrets policy), so using it would defeat the test on a real machine.
  setEnv(path.join(os.tmpdir(), `uts-missing-config-${process.pid}-${Date.now()}.yaml`));
  assert.equal(real(defaultConfigPath()), real(EXAMPLE));
  assert.ok(listProfiles().length > 0);
});

test("honors a valid absolute config outside the project root (Desktop user-supplied file)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uts-cfg-"));
  const file = path.join(dir, "my-profiles.yaml");
  fs.copyFileSync(EXAMPLE, file);
  try {
    setEnv(file);
    assert.equal(defaultConfigPath(), file, "a valid env path must be used verbatim, not overridden");
    assert.ok(listProfiles().length > 0, "an external absolute config must load");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A trailing-slash ${CLAUDE_PLUGIN_ROOT}/${__dirname} makes UTS_COMPUTING_CONFIG carry a doubled
// separator ("<root>//profiles/..."). The OS treats it as the same file, but it must not leak into the
// displayed config_status.config_path. defaultConfigPath normalizes it.
test("normalizes a doubled separator in an absolute env path (no '//' in config_path)", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uts-cfg-slash-"));
  const file = path.join(dir, "my-profiles.yaml");
  fs.copyFileSync(EXAMPLE, file);
  const messy = dir + path.sep + path.sep + "my-profiles.yaml"; // injected doubled separator
  try {
    setEnv(messy);
    assert.ok(fs.existsSync(messy), "sanity: the OS treats the doubled separator as the same file");
    assert.equal(defaultConfigPath(), file, "defaultConfigPath must collapse the doubled separator");
    const s = effectiveConfigStatus();
    assert.equal(s.config_path, file);
    assert.ok(!s.config_path.includes(path.sep + path.sep), "config_path must not contain a doubled separator");
    assert.ok(listProfiles().length > 0, "the normalized path must still load");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// H4/M13: the plugin must be able to DISCLOSE that it has fallen back to the bundled example profiles —
// both to the agent (via effectiveConfigStatus / the tool envelope) and loudly to stderr.
test("effectiveConfigStatus reports example fallback when env is unset", () => {
  setEnv(undefined);
  const s = effectiveConfigStatus();
  assert.equal(s.using_example_profiles, true);
  assert.match(s.config_path, /profiles\.example\.yaml$/);
});

test("effectiveConfigStatus reports a real config (not example) when env points at an external file", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uts-cfg-status-"));
  const file = path.join(dir, "my-profiles.yaml");
  fs.copyFileSync(EXAMPLE, file);
  try {
    setEnv(file);
    const s = effectiveConfigStatus();
    assert.equal(s.using_example_profiles, false);
    assert.equal(s.config_path, file);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("unset/empty fallback now WARNS to stderr (no longer silent)", () => {
  setEnv(undefined);
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk) => {
    writes.push(String(chunk));
    return true;
  };
  try {
    defaultConfigPath();
    assert.ok(
      writes.some((w) => /bundled example profiles/i.test(w)),
      "expected a fallback warning on stderr when UTS_COMPUTING_CONFIG is unset"
    );
  } finally {
    process.stderr.write = orig;
  }
});
