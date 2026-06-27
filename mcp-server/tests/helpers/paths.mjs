// Shared filesystem anchors for the test suite.
//
// `const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..")` was
// hand-recomputed in ~33 test files relative to each file's own location under mcp-server/tests/.
// This module owns the single computation. Helper files live one level deeper
// (mcp-server/tests/helpers/), so the climb to the repository root is "../../..".
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Where the committed example specs live. `examples/jobs/<name>.json` and
// `examples/transfers/<name>.json` back readExample()/readTransferExample().
export const examplesDir = path.join(repoRoot, "examples");

// Runtime-state isolation (Bug P2). The server now defaults its `.uts-computing` root to a per-user
// state dir, so an in-process test must NOT be allowed to fall through to the real ~/.local/state.
// Relocate every runtime write this process makes into a fresh temp dir via UTS_COMPUTING_HOME, set
// before any server code resolves the root, and removed on process exit. Subprocess servers spawned by
// withMcpClient pass their own UTS_COMPUTING_HOME, which wins over this inherited value, so this only
// governs in-process tool calls and the fixtures dropped beside them. `node --test` runs each test FILE
// in its own process, so each file gets its own isolated root with no cross-file contention.
// realpathSync canonicalizes the temp dir (on macOS os.tmpdir() lives under the /var -> /private/var
// symlink): the server realpaths runtime paths for its containment guards, so a test that builds a
// path from runtimeRoot must use the SAME canonical form or equality checks against server output fail.
const testHome = process.env.UTS_COMPUTING_HOME
  ? path.resolve(process.env.UTS_COMPUTING_HOME)
  : fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "uts-test-home-")));
process.env.UTS_COMPUTING_HOME = testHome;
process.once("exit", () => {
  try {
    fs.rmSync(testHome, { recursive: true, force: true });
  } catch {
    /* best-effort: the OS reclaims the temp dir regardless */
  }
});

// The `.uts-computing` runtime root the in-process server writes under for this test process. Tests
// that drop fixtures beside the server's home (quota snapshots, run records) anchor here.
export const runtimeRoot = path.join(testHome, ".uts-computing");
