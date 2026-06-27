// Low-level primitives shared by ALL of the server's modules — not a subset. (This file began life
// scoped to just the data-movement/state cluster, which is exactly how the duplication colony grew;
// its charter is now charter-wide. See docs/archive/duplication-audit-2026-06.md.) These primitives were
// copy-pasted into each module; consolidated here so the copies can't drift apart.
//
// lib/ is a set of LEAF modules: a file here may import Node built-ins and other lib/ leaves, but it
// must NOT pull in a domain module that could (transitively) import lib/ back, or the dependency
// graph would cycle. shared.ts is a pure leaf — it imports only node:crypto / node:fs. A CI guard
// (scripts/lint-no-dup-lib-defs.mjs, wired into `npm run lint` / pretest) fails the build if any
// module under src/ outside lib/ re-defines a name this file exports, so the copies cannot come back.

import crypto from "node:crypto";
import fs from "node:fs";

// Filesystem-safe timestamp for evidence/record filenames (ISO 8601 with `:` and `.` replaced).
export function safeTimestamp(now: Date): string {
  return now.toISOString().replace(/[:.]/g, "-");
}

// Filesystem-safe form of an already-rendered ISO 8601 string (`:` and `.` replaced). Use this for
// sites that have a string timestamp in hand — round-tripping through `new Date(iso)` could
// re-normalize a non-canonical ISO string and silently change persisted snapshot_id/filename values.
export function safeTimestampOf(isoTimestamp: string): string {
  return isoTimestamp.replace(/[:.]/g, "-");
}

export function stripTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

// Whole-second timeout (>= 1) for an `ssh -o ConnectTimeout=` style flag.
export function sshTimeoutSeconds(timeoutMs: number): number {
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

// Validate an optional integer against per-call-site bounds, substituting `default` when absent.
// Each caller passes its OWN bounds (timeout caps, byte limits, entry counts, expiry hours) — these
// diverge intentionally per module (e.g. transfer's 600000ms cap vs access's 30000ms cap, or
// transfer's 50GB byte ceiling) and MUST NOT be flattened to a single shared bound. The error
// message is `${label} must be an integer between ${min} and ${max}`, matching every prior copy.
export function boundedInteger(
  value: number | undefined,
  bounds: { default: number; min: number; max: number; label: string }
): number {
  const { default: defaultValue, min, max, label } = bounds;
  const candidate = value ?? defaultValue;
  if (!Number.isInteger(candidate) || candidate < min || candidate > max) {
    throw new Error(`${label} must be an integer between ${min} and ${max}`);
  }
  return candidate;
}

// Whole-millisecond timeout clamped to a per-call-site policy window. The min (1000) and the
// `timeoutMs` label are shared across every module; only the `default` and `max` diverge by tool
// (access 5000/30000, transfer 30000/600000, the middle modules 10000/30000) so each caller passes
// its OWN bounds. Delegates to boundedInteger, so the throw is the byte-identical
// `timeoutMs must be an integer between 1000 and ${max}` every prior module-local copy produced.
export function normalizeTimeout(timeoutMs: number | undefined, bounds: { default: number; max: number }): number {
  return boundedInteger(timeoutMs, { default: bounds.default, min: 1000, max: bounds.max, label: "timeoutMs" });
}

// Round a number to 2 decimal places (the money/usage rounding used for core/gpu-hours and mem_gb).
// One home for the `Math.round(value * 100) / 100` idiom that accounting.ts, rightsize.ts and jobs.ts
// each copy-pasted; the webui server imports this from dist for its /api/summary rollup so the four
// copies can't drift. (No round1 here yet — accounting.ts keeps its single round1 user locally.)
export function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

// True when `candidate` is `root` itself or a path nested under it (trailing-slash insensitive).
export function isInsideRemoteRoot(candidate: string, root: string): boolean {
  const normalizedRoot = stripTrailingSlash(root);
  return candidate === normalizedRoot || candidate.startsWith(`${normalizedRoot}/`);
}

// Reject SSH host aliases that could be parsed as flags or contain shell-unsafe characters.
export function assertSafeSshTarget(target: string): void {
  if (!target || target.startsWith("-") || !/^[A-Za-z0-9._@:+-]+$/.test(target)) {
    throw new Error(`Unsafe SSH host alias: ${target}`);
  }
}

// Recursively sort object keys and drop `undefined` so JSON output is deterministic (for hashing).
export function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(canonicalize);
  }
  if (!value || typeof value !== "object") {
    return value;
  }
  return Object.fromEntries(
    Object.entries(value as Record<string, unknown>)
      .filter(([, entryValue]) => entryValue !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entryValue]) => [key, canonicalize(entryValue)])
  );
}

export function stableJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

// True when `value` is an absolute remote path free of traversal segments and shell-active
// characters. The grammar permits `${}` so `${USER}`-templated roots pass; callers that need a
// concrete (non-templated) path validate separately.
export function isSafeRemotePath(value: string): boolean {
  return (
    value.startsWith("/") &&
    !value.split("/").includes("..") &&
    /^[A-Za-z0-9_./${}-]+$/.test(value) &&
    !/[\s`"';&|<>()[\]]/.test(value)
  );
}

export function assertSafeRemotePath(value: string, label: string): void {
  if (!isSafeRemotePath(value)) {
    throw new Error(`${label} contains shell-active, relative, or unsupported remote path characters`);
  }
}

// Like assertSafeRemotePath but splits the verdict into two labelled messages (traversal vs shell-active)
// for the iHPC PLAN/launch paths, which want to tell the operator WHICH rule a templated workdir/root
// broke. Same grammar as isSafeRemotePath (the `${}` allowance lets `${USER}`-templated paths through).
// Hoisted from byte-identical private copies in ops/jobs/ihpc-start.ts and ops/scheduler/campaign/start.ts
// so the single-run and campaign launch paths share one guard (it is used like a lib primitive in both).
export function assertSafeRemotePathTemplate(value: string, label: string): void {
  if (!value.startsWith("/") || value.split("/").includes("..")) {
    throw new Error(`${label} must be an absolute remote path without traversal`);
  }
  if (!/^[A-Za-z0-9_./${}-]+$/.test(value) || /[\s`"';&|<>()[\]]/.test(value)) {
    throw new Error(`${label} contains shell-active or unsupported characters`);
  }
}

// base64url-encode a JSON spec for transport on a remote argv. MUST stay plain JSON.stringify
// (insertion-order) — substituting stableJson would change the wire bytes the remote helper decodes.
// Param is `object` (not `Record<string, unknown>`) so interface-typed specs without an index
// signature (e.g. ihpc-start's SupervisorSpec) pass without widening the interface — only its
// JSON serialization is observed, so any object shape is acceptable.
export function encodeSpec(value: object): string {
  return Buffer.from(JSON.stringify(value), "utf8").toString("base64url");
}

// Parse the last non-empty line of a remote helper's stdout as JSON, with a labelled error.
export function parseJsonLastLine(stdout: string, label: string): unknown {
  const raw = stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1);
  if (!raw) {
    throw new Error(`${label} helper did not return JSON`);
  }
  try {
    return JSON.parse(raw) as unknown;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new Error(`${label} helper returned invalid JSON: ${message}`);
  }
}

// Canonical "render an unknown thrown value as a string" primitive. A try/catch's `catch (error)`
// binds `unknown`, so every module that wants the message in a summary/finding needs this exact
// `instanceof Error ? message : String(...)` narrowing. It lived as a private copy in core/access.ts
// and ops/access/doctor.ts (plus inlined in ~9 other modules); hoisted here so it has one home.
export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

// True when `value` is a lowercase-hex SHA-256 digest (64 chars). Not a path/shell guard.
// Callers that need a throwing form keep their own wrapper so the offending value can be
// interpolated into the message (e.g. approvals.assertPlanHash, artifacts.assertSha256).
export function isHexDigest(value: string): boolean {
  return /^[a-f0-9]{64}$/.test(value);
}

// Hex SHA-256 of an in-memory buffer. Callers that want a prefixed/sliced id (artifactIdFor,
// projectHashFor, approvals) slice the result themselves — keep that at the call site.
export function sha256Hex(value: Buffer): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// 1 MiB read-chunk for streaming SHA-256. The remote Python mirror (lib/remote-python.ts
// PY_SHA256_FILE, `handle.read(...)`) must stay in lock-step with this value; the cross-check is
// enforced by tests/remote-python-snapshot.test.mjs. Chunking does not change the digest, but the
// duplication audit requires the local and remote chunk sizes stay identical.
export const READ_CHUNK_BYTES = 1024 * 1024;

// Streaming hex SHA-256 of a file read in 1 MiB chunks (bounded memory for large transfers).
export function sha256File(filePath: string): string {
  const digest = crypto.createHash("sha256");
  const buffer = Buffer.allocUnsafe(READ_CHUNK_BYTES);
  const fd = fs.openSync(filePath, "r");
  try {
    for (;;) {
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, null);
      if (bytesRead === 0) {
        break;
      }
      digest.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    fs.closeSync(fd);
  }
  return digest.digest("hex");
}
