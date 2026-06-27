import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

// This module compiles to mcp-server/dist/core/paths.js. projectRoot is the single anchor every other
// module resolves external files against (schemas/, profiles/, templates/, package.json), so it must
// point at the repo root regardless of how deep this compiled file sits under dist/. Anchoring on a
// FIXED depth (`resolve(distDir, "../../..")`) silently renders "<outside-project>" the moment the
// compiled-module layout shifts (M12/L17), so resolveProjectRoot walks up to the `name: "uts-compute"`
// package.json marker instead, falling back to the historical fixed depth so existing installs never
// regress.
const distDir = path.dirname(fileURLToPath(import.meta.url));

function resolveProjectRoot(): string {
  let dir = distDir;
  // Bounded walk-up (the repo root sits 3 dirs above dist/core; 10 is generous slack for relocations).
  for (let depth = 0; depth < 10; depth += 1) {
    const pkgPath = path.join(dir, "package.json");
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as { name?: unknown };
      if (pkg.name === "uts-compute") return dir;
    } catch {
      // No package.json here (or unreadable/malformed) — keep walking up.
    }
    const parent = path.dirname(dir);
    if (parent === dir) break; // reached the filesystem root
    dir = parent;
  }
  const fallback = path.resolve(distDir, "../../..");
  process.stderr.write(
    `[uts-compute] WARN: could not locate the "uts-compute" package.json above ${distDir}; ` +
      `falling back to a fixed dist depth (${fallback}). Schema/profile resolution may be wrong.\n`
  );
  return fallback;
}

export const projectRoot = resolveProjectRoot();

export function resolveProjectPath(inputPath: string): string {
  return path.isAbsolute(inputPath) ? inputPath : path.resolve(projectRoot, inputPath);
}

export function assertInsideProject(candidatePath: string, label: string): string {
  const resolved = resolveProjectPath(candidatePath);
  const relative = path.relative(projectRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside the project root`);
  }
  return resolved;
}

// Base dir the `.uts-computing` runtime-state root lives under, resolved first-match-wins (Bug P2):
//   1. UTS_COMPUTING_STATE_DIR — explicit operator/CI override of where run/plan/transfer records go.
//   2. UTS_COMPUTING_HOME       — relocation hook used by the test harness to isolate each test
//      process's runtime root so concurrent test files and live MCP servers can't contend.
//   3. per-user state dir       — $XDG_STATE_HOME (when absolute) or ~/.local/state.
//
// The default is deliberately NOT projectRoot: a real install must never write its runtime state into
// the installed plugin / launch CWD (one field install accumulated ~18.7k test-run files / 163 MB of
// `.uts-computing/` inside the plugin dir). The state root is `<base>/.uts-computing` (runtimeRootDir),
// so the RUNTIME_DIRS literals below stay byte-identical regardless of which base is in effect.
export function runtimeBaseDir(): string {
  const stateDir = process.env.UTS_COMPUTING_STATE_DIR;
  if (stateDir) return path.resolve(stateDir);
  const home = process.env.UTS_COMPUTING_HOME;
  if (home) return path.resolve(home);
  const xdgState = process.env.XDG_STATE_HOME;
  return xdgState && path.isAbsolute(xdgState) ? path.resolve(xdgState) : path.join(os.homedir(), ".local", "state");
}

export function runtimeRootDir(): string {
  return path.resolve(runtimeBaseDir(), ".uts-computing");
}

// Canonical registry of the `.uts-computing/<subdir>` runtime-state directories. These were
// copy-pasted as module-local `const X_DIR = ".uts-computing/..."` (and as overridable parameter
// defaults in several public signatures); centralised here so the literals can't drift apart. The
// values MUST stay byte-identical to the prior literals — they back parameter defaults that callers
// and tests pass explicitly, so `as const` strings (never re-derived) are required.
export const RUNTIME_DIRS = {
  runs: ".uts-computing/runs",
  plans: ".uts-computing/plans",
  approvals: ".uts-computing/approvals",
  quotas: ".uts-computing/quotas",
  artifacts: ".uts-computing/artifacts",
  transfers: ".uts-computing/transfers",
  jobOps: ".uts-computing/job-ops",
  onboarding: ".uts-computing/onboarding",
  access: ".uts-computing/access",
  docsCache: ".uts-computing/docs-cache"
} as const;

export function assertInsideRuntime(candidatePath: string, label: string): string {
  // Resolve a relative candidate (the RUNTIME_DIRS ".uts-computing/<subdir>" defaults) against the
  // runtime base; accept an absolute candidate (a caller/test temp dir) as given; then confine the
  // result to the runtime root. The root is now per-user by default (never projectRoot — see
  // runtimeBaseDir), so the single "must stay inside .uts-computing" containment check below is the
  // only traversal guard that still has meaning, and it holds for every base.
  const runtimeRoot = runtimeRootDir();
  const resolved = path.isAbsolute(candidatePath)
    ? candidatePath
    : path.resolve(runtimeBaseDir(), candidatePath);
  const relative = path.relative(runtimeRoot, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside .uts-computing`);
  }
  return resolved;
}

// Realpath-resolved containment guard: rejects symlink escapes by comparing the resolved real paths.
export function assertRealPathInside(candidatePath: string, rootPath: string, label: string): void {
  const realCandidate = fs.realpathSync(candidatePath);
  const realRoot = fs.realpathSync(rootPath);
  const relative = path.relative(realRoot, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside its resource directory`);
  }
}

// Variant of assertRealPathInside where the ROOT is already realpath-resolved by the caller (e.g. a
// metric-walk loop that resolves the root once, then validates many children). Only the candidate is
// realpath-resolved here. The error suffix differs deliberately — artifacts.ts's metric reader emits
// `... must stay inside fetched artifact files`, so that exact wording is preserved.
export function assertRealPathInsideRealRoot(candidatePath: string, rootRealPath: string, label: string): void {
  const realCandidate = fs.realpathSync(candidatePath);
  const relative = path.relative(rootRealPath, realCandidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} must stay inside fetched artifact files`);
  }
}

// Read-side record path-containment guard shared by the flat-layout record readers (audit.readRunRecord,
// plan-store.readPlanArtifact, ihpc-start.readQuotaSnapshot). Builds `<dir>/<id>.json`, runs the cheap
// relative-containment pre-check with the caller's own `containmentMessage` (kept per-site so the
// thrown messages stay byte-identical), then the realpath symlink-escape guard with `realpathLabel`.
// `dir` MUST already be an assertInsideRuntime-confined directory and `id` MUST already be grammar-
// validated by the caller. Returns the absolute file path.
export function resolveRecordPath(
  dir: string,
  id: string,
  options: { containmentMessage: string; realpathLabel: string }
): string {
  const filePath = path.join(dir, `${id}.json`);
  const relative = path.relative(dir, filePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(options.containmentMessage);
  }
  assertRealPathInside(filePath, dir, options.realpathLabel);
  return filePath;
}
