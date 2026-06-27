import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Regression lock for the duplication colony (docs/archive/duplication-audit-2026-06.md). lib/ is the single
// home for the server's low-level primitives; scripts/lint-no-dup-lib-defs.mjs fails CI if any module
// under src/ (outside lib/) re-defines a name lib/ already exports. These tests pin BOTH directions:
// the real tree passes, and a deliberately re-introduced duplicate is caught.
const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "../../..");
const lintScript = path.join(repoRoot, "mcp-server", "scripts", "lint-no-dup-lib-defs.mjs");
const srcDir = path.join(repoRoot, "mcp-server", "src");

function runLint() {
  return spawnSync(process.execPath, [lintScript], { cwd: repoRoot, encoding: "utf8" });
}

test("lint-no-dup-lib-defs passes on the real source tree", () => {
  const result = runLint();
  assert.equal(result.status, 0, `lint should pass on the real tree:\n${result.stdout}${result.stderr}`);
  assert.match(result.stdout, /no module re-defines/);
});

test("lint-no-dup-lib-defs fails when a module re-defines a lib export", () => {
  // Throwaway fixture: a fresh local definition shadowing a lib/ export must break the build.
  const fixture = path.join(srcDir, "__dup_guard_fixture__.ts");
  fs.writeFileSync(
    fixture,
    [
      "// throwaway fixture for lib-dup-guard.test.mjs — written and removed within the test.",
      "export function assertSafeSshTarget(target: string): void {",
      '  if (!target) throw new Error("duplicate");',
      "}",
      "export const runProcess = () => undefined;",
      ""
    ].join("\n"),
    "utf8"
  );
  try {
    const result = runLint();
    assert.equal(result.status, 1, "lint must fail when a lib export is re-defined locally");
    assert.match(result.stderr, /re-defines lib export 'assertSafeSshTarget'/);
    assert.match(result.stderr, /re-defines lib export 'runProcess'/);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});

test("lint-no-dup-lib-defs fails when a module re-defines a lib interface or type", () => {
  // The pass-2 regression fix: the guard must also cover lib TYPE exports (CommandResult / Executor
  // in lib/process.ts, ArgvReplacement / FailureSummaryWording in lib/redact.ts), not just
  // function/const. A re-introduced `interface CommandResult` or `type FailureSummaryWording` must
  // break the build.
  const fixture = path.join(srcDir, "__dup_type_guard_fixture__.ts");
  fs.writeFileSync(
    fixture,
    [
      "// throwaway fixture for lib-dup-guard.test.mjs — written and removed within the test.",
      "export interface CommandResult {",
      "  exitCode: number | null;",
      "}",
      "export type FailureSummaryWording = { timedOut: string };",
      ""
    ].join("\n"),
    "utf8"
  );
  try {
    const result = runLint();
    assert.equal(result.status, 1, "lint must fail when a lib interface/type is re-defined locally");
    assert.match(result.stderr, /re-defines lib export 'CommandResult'/);
    assert.match(result.stderr, /re-defines lib export 'FailureSummaryWording'/);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});

test("lint-no-dup-lib-defs allows a type-only re-export and an aliased re-export of a lib type", () => {
  // `export type { CommandResult } from "..."` (braces) and the per-module `export type X = Executor`
  // alias pattern (a DIFFERENT name) are both legitimate and must pass — neither re-defines the
  // guarded name itself.
  const fixture = path.join(srcDir, "__type_reexport_guard_fixture__.ts");
  fs.writeFileSync(
    fixture,
    [
      "// throwaway fixture for lib-dup-guard.test.mjs — written and removed within the test.",
      'export type { CommandResult, Executor } from "./lib/process.js";',
      "import type { Executor } from \"./lib/process.js\";",
      "export type LocalExecutorAlias = Executor;",
      ""
    ].join("\n"),
    "utf8"
  );
  try {
    const result = runLint();
    assert.equal(result.status, 0, `type re-export/alias must pass:\n${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});

test("lint-no-dup-lib-defs allows a legitimate re-export of a lib name", () => {
  // The access.ts pattern: `export { name } from "./lib/..."` is NOT a re-definition and must pass.
  const fixture = path.join(srcDir, "__reexport_guard_fixture__.ts");
  fs.writeFileSync(
    fixture,
    [
      "// throwaway fixture for lib-dup-guard.test.mjs — written and removed within the test.",
      'export { assertSafeSshTarget, sshTimeoutSeconds } from "./lib/shared.js";',
      ""
    ].join("\n"),
    "utf8"
  );
  try {
    const result = runLint();
    assert.equal(result.status, 0, `re-export must pass:\n${result.stdout}${result.stderr}`);
  } finally {
    fs.rmSync(fixture, { force: true });
  }
});
