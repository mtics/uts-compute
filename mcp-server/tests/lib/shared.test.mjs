import assert from "node:assert/strict";
import test from "node:test";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  assertSafeRemotePath,
  encodeSpec,
  isHexDigest,
  isInsideRemoteRoot,
  isSafeRemotePath,
  parseJsonLastLine,
  safeTimestamp,
  safeTimestampOf,
  sha256File,
  sha256Hex
} from "../../dist/lib/shared.js";

test("isSafeRemotePath accepts absolute paths and ${} templates, rejects traversal/metachars/relative", () => {
  // Accepted: absolute, template-substituted, dotted, hyphenated.
  assert.equal(isSafeRemotePath("/scratch/u/run-1/logs"), true);
  assert.equal(isSafeRemotePath("/home/${USER}/work"), true);
  assert.equal(isSafeRemotePath("/a/b.c_d-e/f"), true);

  // Rejected: relative (no leading slash).
  assert.equal(isSafeRemotePath("relative/path"), false);
  assert.equal(isSafeRemotePath(""), false);

  // Rejected: parent-dir traversal segments.
  assert.equal(isSafeRemotePath("/scratch/../etc/passwd"), false);
  assert.equal(isSafeRemotePath("/a/b/.."), false);

  // Rejected: shell-active metacharacters and whitespace.
  for (const bad of [
    "/a/b;rm -rf",
    "/a/$(whoami)",
    "/a/`id`",
    "/a/b|c",
    "/a/b&c",
    "/a/b>c",
    "/a/b<c",
    "/a/b\"c",
    "/a/b'c",
    "/a/(b)",
    "/a/[b]",
    "/a/b c"
  ]) {
    assert.equal(isSafeRemotePath(bad), false, `expected ${bad} to be unsafe`);
  }
});

test("assertSafeRemotePath throws a labelled error for traversal, metachars, and relative paths", () => {
  // Does not throw for a safe path.
  assert.doesNotThrow(() => assertSafeRemotePath("/scratch/run/logs", "workdir"));

  for (const bad of ["../escape", "/a/../b", "/a/$(x)", "/a;rm", "no-leading-slash"]) {
    assert.throws(
      () => assertSafeRemotePath(bad, "workdir"),
      /workdir contains shell-active, relative, or unsupported remote path characters/,
      `expected ${bad} to throw the labelled error`
    );
  }
});

test("isInsideRemoteRoot treats the root as itself-or-nested, trailing-slash insensitive", () => {
  // Root itself and any nested path are inside.
  assert.equal(isInsideRemoteRoot("/scratch/u", "/scratch/u"), true);
  assert.equal(isInsideRemoteRoot("/scratch/u/run-1", "/scratch/u"), true);

  // A single trailing slash on the root is normalized away (matches every prior copy).
  assert.equal(isInsideRemoteRoot("/scratch/u", "/scratch/u/"), true);
  assert.equal(isInsideRemoteRoot("/scratch/u/run-1", "/scratch/u/"), true);

  // Sibling prefixes that are not path-nested are rejected.
  assert.equal(isInsideRemoteRoot("/scratch/used", "/scratch/u"), false);
  assert.equal(isInsideRemoteRoot("/other", "/scratch/u"), false);

  // Canonical strip-ALL trailing-slash semantics (/\/+$/): a root with >=2 trailing
  // slashes must behave identically to one with none. The old strip-one copies left a
  // dangling slash here, so this case pins the chosen behavior against regression.
  assert.equal(isInsideRemoteRoot("/scratch/u", "/scratch/u//"), true);
  assert.equal(isInsideRemoteRoot("/scratch/u/run-1", "/scratch/u///"), true);
  assert.equal(isInsideRemoteRoot("/scratch/used", "/scratch/u//"), false);
});

test("encodeSpec uses plain JSON.stringify insertion order (not key-sorted)", () => {
  // The wire bytes must follow insertion order, so {b,a} differs from {a,b}.
  const encoded = encodeSpec({ b: 1, a: 2 });
  assert.equal(encoded, Buffer.from(JSON.stringify({ b: 1, a: 2 }), "utf8").toString("base64url"));
  assert.equal(Buffer.from(encoded, "base64url").toString("utf8"), '{"b":1,"a":2}');
  assert.notEqual(encodeSpec({ b: 1, a: 2 }), encodeSpec({ a: 2, b: 1 }));
});

test("parseJsonLastLine returns the last non-empty JSON line and wraps invalid JSON", () => {
  assert.deepEqual(parseJsonLastLine('noise\n{"ok":true}\n', "thing"), { ok: true });
  assert.deepEqual(parseJsonLastLine('  {"a":1}  \r\n\n', "thing"), { a: 1 });
  assert.throws(() => parseJsonLastLine("   \n\n", "thing"), /thing helper did not return JSON/);
  assert.throws(() => parseJsonLastLine("not json", "thing"), /thing helper returned invalid JSON/);
});

test("isHexDigest validates 64-char lowercase hex", () => {
  const valid = "a".repeat(64);
  assert.equal(isHexDigest(valid), true);
  assert.equal(isHexDigest("A".repeat(64)), false); // uppercase rejected
  assert.equal(isHexDigest("a".repeat(63)), false); // too short
  assert.equal(isHexDigest("g".repeat(64)), false); // non-hex
});

test("sha256Hex matches Node's createHash for a buffer", () => {
  const buf = Buffer.from("hello world", "utf8");
  assert.equal(sha256Hex(buf), crypto.createHash("sha256").update(buf).digest("hex"));
});

test("sha256File streams a file to the same digest as an in-memory hash", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "uts-sha-"));
  const file = path.join(dir, "blob.bin");
  // Larger than the 1 MiB chunk to exercise the streaming loop across reads.
  const payload = Buffer.alloc(1024 * 1024 * 2 + 17, 7);
  fs.writeFileSync(file, payload);
  try {
    assert.equal(sha256File(file), crypto.createHash("sha256").update(payload).digest("hex"));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("safeTimestamp and safeTimestampOf replace ':' and '.' with '-'", () => {
  const now = new Date("2026-06-17T12:34:56.789Z");
  assert.equal(safeTimestamp(now), "2026-06-17T12-34-56-789Z");
  // String sibling operates on the rendered ISO without re-parsing through new Date().
  assert.equal(safeTimestampOf(now.toISOString()), safeTimestamp(now));
  assert.equal(safeTimestampOf("2026-06-17T00:00:00.000Z"), "2026-06-17T00-00-00-000Z");
});
