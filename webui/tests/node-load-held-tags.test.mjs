// T5 assertion tests: the node-load panel renders the "held · no plugin run" chip for held_no_run
// nodes, and per-profile error lines for profile_errors entries.
// These are source-text assertion tests (assert.match against app.js) — the standard pattern for
// front-end rendering in this codebase (see ihpc-node-load.test.mjs, node-load-live.test.mjs).
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const appSource = fs.readFileSync(path.join(repoRoot, "webui/public/app.js"), "utf8");

test("nodeCard renders 'held · no plugin run' chip when held_no_run is true", () => {
  assert.match(appSource, /held · no plugin run/);
});

test("nodeCard uses held_no_run flag from node data", () => {
  assert.match(appSource, /n\.held_no_run/);
});

test("nodeLoadBody renders per-profile error lines from profile_errors", () => {
  assert.match(appSource, /profile_errors/);
});

test("profile_errors renders with 'couldn\\'t reach login host' or similar probe-failure label", () => {
  // The error text must give the user something actionable about why cnode mynodes failed
  assert.match(appSource, /couldn.t reach login host|probe.error|probe_error/i);
});
