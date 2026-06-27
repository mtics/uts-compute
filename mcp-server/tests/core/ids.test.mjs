// Run-id grammar: must accept real campaign run names (mixed case, underscores, dots) while staying
// injection- and traversal-safe. The grammar is a single path segment with a forced leading
// alphanumeric, so it can never be `.`/`..` and never contains `/` — no traversal is expressible.
import assert from "node:assert/strict";
import test from "node:test";
import { assertSafeRunId, SAFE_RUN_ID_PATTERN } from "../../dist/core/ids.js";

test("accepts a real campaign run_id with mixed case, underscores, and a dot", () => {
  // The field-observed name that jobs.adopt rejected ~40% of the time as "Unsafe run_id".
  assert.doesNotThrow(() => assertSafeRunId("MMPFedRec_Cards_lr0.001_mainhpo"));
  assert.ok(SAFE_RUN_ID_PATTERN.test("MMPFedRec_Cards_lr0.001_mainhpo"));
});

test("accepts other realistic campaign/sweep names", () => {
  for (const ok of [
    "MMPFedRec_KU_seed0_mainhpo",
    "Beauty.MovieLens.5seed",
    "run-123",
    "abc",
    "a-b-c",
    "X0_y.z-1",
  ]) {
    assert.doesNotThrow(() => assertSafeRunId(ok), `should accept: ${JSON.stringify(ok)}`);
  }
});

test("still rejects traversal, slashes, leading punctuation, shell metachars, and bad length", () => {
  for (const bad of [
    "..", ".", "-x", "_x", ".x",        // leading punctuation / bare dot-dot
    "evil..id", "a..b", "Run..1", "x...y", // embedded `..` rejected (defense-in-depth vs traversal)
    "a/b", "a\\b",                        // path separators
    "a b", "a;b", "a$b", "a`b", "a|b", "a*b", "a&b", "a'b", "a\"b", "a(b)", // shell metachars
    "", "ab",                            // too short (min 3)
    "a".repeat(129),                     // too long (max 128)
  ]) {
    assert.throws(() => assertSafeRunId(bad), /Unsafe run_id/, `should reject: ${JSON.stringify(bad)}`);
  }
});
