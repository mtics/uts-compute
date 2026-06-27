// Regression tests for runtime-state directory resolution (Bug P2).
//
// A real install must NEVER write its `.uts-computing` run/plan/transfer state into the installed
// plugin / launch CWD — one field install accumulated ~18.7k files / 163 MB of test-run records there.
// With no env set the root must resolve under a per-user state dir (outside the project root);
// UTS_COMPUTING_STATE_DIR (and the legacy UTS_COMPUTING_HOME relocation hook) must override it, with
// STATE_DIR winning when both are present.
//
// This file deliberately does NOT import the test helpers: helpers/paths.mjs sets UTS_COMPUTING_HOME on
// import to isolate runtime writes, which would mask the production default we assert here.
import assert from "node:assert/strict";
import test, { afterEach } from "node:test";
import os from "node:os";
import path from "node:path";
import { runtimeBaseDir, runtimeRootDir, projectRoot } from "../../dist/core/paths.js";

const KEYS = ["UTS_COMPUTING_STATE_DIR", "UTS_COMPUTING_HOME", "XDG_STATE_HOME"];
const ORIG = Object.fromEntries(KEYS.map((k) => [k, process.env[k]]));
function setEnv(values) {
  for (const k of KEYS) {
    if (values[k] === undefined) delete process.env[k];
    else process.env[k] = values[k];
  }
}
afterEach(() => setEnv(ORIG));

test("defaults the runtime root to a per-user state dir, never the plugin/project dir", () => {
  setEnv({});
  const root = runtimeRootDir();
  assert.ok(path.isAbsolute(root), "runtime root must be absolute");
  assert.equal(root, path.join(os.homedir(), ".local", "state", ".uts-computing"));
  const rel = path.relative(projectRoot, root);
  assert.ok(
    rel.startsWith("..") || path.isAbsolute(rel),
    `runtime root must be OUTSIDE the project root, got ${root}`
  );
});

test("honors $XDG_STATE_HOME (when absolute) as the per-user base", () => {
  setEnv({ XDG_STATE_HOME: "/xdg/state" });
  assert.equal(runtimeRootDir(), path.join("/xdg/state", ".uts-computing"));
});

test("ignores a relative $XDG_STATE_HOME and falls back to ~/.local/state", () => {
  setEnv({ XDG_STATE_HOME: "relative/state" });
  assert.equal(runtimeRootDir(), path.join(os.homedir(), ".local", "state", ".uts-computing"));
});

test("UTS_COMPUTING_STATE_DIR overrides the default base", () => {
  setEnv({ UTS_COMPUTING_STATE_DIR: "/srv/uts-state" });
  assert.equal(runtimeBaseDir(), path.resolve("/srv/uts-state"));
  assert.equal(runtimeRootDir(), path.join("/srv/uts-state", ".uts-computing"));
});

test("UTS_COMPUTING_STATE_DIR wins over UTS_COMPUTING_HOME when both are set", () => {
  setEnv({ UTS_COMPUTING_STATE_DIR: "/srv/state", UTS_COMPUTING_HOME: "/srv/home" });
  assert.equal(runtimeRootDir(), path.join("/srv/state", ".uts-computing"));
});

test("UTS_COMPUTING_HOME still relocates the root (test-harness isolation hook)", () => {
  setEnv({ UTS_COMPUTING_HOME: "/srv/home" });
  assert.equal(runtimeRootDir(), path.join("/srv/home", ".uts-computing"));
});
