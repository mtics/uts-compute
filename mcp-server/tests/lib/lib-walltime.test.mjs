import assert from "node:assert/strict";
import test from "node:test";
import { parseWalltimeSeconds, parseHmsSeconds, formatWalltime } from "../../dist/lib/walltime.js";

// The shared PBS-walltime codec (docs/archive/layering-audit-2026-06.md finding 11). These pin the two
// load-bearing properties: the strict/lenient grammar split stays distinct, and format is the
// inverse of the strict parse (round-trip).

test("parseWalltimeSeconds is strict HH:MM:SS and rejects malformed input", () => {
  assert.equal(parseWalltimeSeconds("24:00:00"), 86400);
  assert.equal(parseWalltimeSeconds("02:00:00"), 7200);
  assert.equal(parseWalltimeSeconds("200:00:00"), 720000);
  assert.equal(parseWalltimeSeconds("00:05:30"), 330);
  assert.equal(parseWalltimeSeconds("  01:30:45  "), 5445);
  // Strict: not exactly three colon-groups with two-digit MM/SS -> undefined (rejected, not zeroed).
  assert.equal(parseWalltimeSeconds("nonsense"), undefined);
  assert.equal(parseWalltimeSeconds("1:2:3"), undefined);
  assert.equal(parseWalltimeSeconds("1:00:00:00"), undefined);
});

test("parseHmsSeconds is lenient [DD:]HH:MM:SS, accepts a day prefix and >24h, zeroes garbage", () => {
  assert.equal(parseHmsSeconds("01:00:00"), 3600);
  assert.equal(parseHmsSeconds("01:30:45"), 5445);
  // Hours may exceed 24 (scheduler-emitted resources_used.*).
  assert.equal(parseHmsSeconds("200:00:00"), 720000);
  // A 4-group [DD:]HH:MM:SS value is accepted; every colon-group is folded in base-60.
  assert.equal(parseHmsSeconds("1:02:00:00"), ((1 * 60 + 2) * 60 + 0) * 60 + 0);
  assert.equal(parseHmsSeconds("1:02:00:00"), 223200);
  // Any non-finite part -> 0 (the trusted-field lenient contract).
  assert.equal(parseHmsSeconds("bad"), 0);
});

test("formatWalltime is the inverse of the strict parse (round-trip)", () => {
  for (const value of ["00:00:00", "00:05:30", "02:00:00", "24:00:00", "200:00:00"]) {
    assert.equal(formatWalltime(parseWalltimeSeconds(value)), value);
  }
  assert.equal(formatWalltime(0), "00:00:00");
  assert.equal(formatWalltime(5445), "01:30:45");
  // seconds -> HH:MM:SS round-trips back to the same seconds.
  for (const seconds of [0, 1, 59, 60, 3599, 3600, 5445, 86400, 720000]) {
    assert.equal(parseWalltimeSeconds(formatWalltime(seconds)), seconds);
  }
});
