// Unit tests for stripSshNoise: the OpenSSH post-quantum warning + iHPC banner noise filter.
// Placed next to the helper's source in ihpc-node-usage.ts (exported for testing).
import assert from "node:assert/strict";
import test from "node:test";
import { stripSshNoise } from "../../../dist/ops/jobs/ihpc-node-usage.js";

const RAW_FULL = [
  "** WARNING: connection is not using a post-quantum key exchange algorithm.",
  '** This session may be vulnerable to "store now, decrypt later" attacks.',
  "** The server may need to be upgraded. See https://openssh.com/pq.html",
  "***************************************************************",
  "*                    Welcome to the iHPC                      *",
  "***************************************************************",
  "nvidia-smi: command not found"
].join("\n");

test("strips post-quantum warning + iHPC banner, keeps the real error", () => {
  assert.equal(stripSshNoise(RAW_FULL), "nvidia-smi: command not found");
});

test("all-noise input falls back to a generic message", () => {
  assert.match(
    stripSshNoise("** WARNING: connection is not using a post-quantum key exchange algorithm."),
    /probe failed/i
  );
});

test("banner-only (multiple border lines + multi-line body) falls back to generic", () => {
  const bannerOnly = [
    "***************************************************************",
    "*                    Welcome to the iHPC                      *",
    "*            Do not use for unauthorised work.                *",
    "***************************************************************"
  ].join("\n");
  assert.match(stripSshNoise(bannerOnly), /probe failed/i);
});

test("keeps genuine error lines after stripping", () => {
  const withExtra = RAW_FULL + "\nexit 255\nsome other error";
  const result = stripSshNoise(withExtra);
  assert.ok(result.includes("nvidia-smi: command not found"));
  assert.ok(result.includes("exit 255"));
  assert.ok(result.includes("some other error"));
});

test("passes through clean stderr untouched", () => {
  const clean = "some real error message\nexit 1";
  assert.equal(stripSshNoise(clean), clean);
});

test("empty string falls back to generic message", () => {
  assert.match(stripSshNoise(""), /probe failed/i);
});

test("whitespace-only falls back to generic message", () => {
  assert.match(stripSshNoise("   \n  \n  "), /probe failed/i);
});

test("collapses extra blank lines left after stripping", () => {
  const withBlanks = "** WARNING: connection is not using a post-quantum key exchange algorithm.\n\n\nnvidia-smi: command not found\n\n";
  assert.equal(stripSshNoise(withBlanks), "nvidia-smi: command not found");
});
