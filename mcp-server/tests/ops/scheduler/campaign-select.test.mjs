import assert from "node:assert/strict";
import test from "node:test";
import { selectPlannedRuns } from "../../../dist/ops/scheduler/campaign/select.js";

// A minimal RunRecord-shaped fixture: only the fields selectPlannedRuns reads (campaign_id, status,
// platform) plus a run_id for identity. selectPlannedRuns is PURE — the caller supplies the records.
const rec = (run_id, status, campaign_id, platform = "uts-ihpc") => ({
  run_id,
  status,
  ...(campaign_id !== undefined ? { campaign_id } : {}),
  platform
});

test("selectPlannedRuns returns only planned iHPC runs of the requested campaign", () => {
  const records = [
    rec("a", "planned", "camp_1"), // ✓ right campaign, planned, iHPC
    rec("b", "planned", "camp_1"), // ✓
    rec("c", "running", "camp_1"), // ✗ already running (not planned)
    rec("d", "finished", "camp_1"), // ✗ terminal
    rec("e", "failed", "camp_1"), // ✗ terminal
    rec("f", "cancelled", "camp_1"), // ✗ terminal
    rec("g", "planned", "camp_2"), // ✗ other campaign
    rec("h", "planned", undefined), // ✗ no campaign attribution
    rec("i", "planned", "camp_1", "uts-hpc") // ✗ not an iHPC run (PBS array, foreign mechanism)
  ];
  const selected = selectPlannedRuns("camp_1", records);
  assert.deepEqual(
    selected.map((r) => r.run_id),
    ["a", "b"],
    "only planned uts-ihpc runs tagged with camp_1 are launch candidates"
  );
});

test("selectPlannedRuns returns [] when the campaign has no planned runs", () => {
  const records = [rec("a", "running", "camp_1"), rec("b", "finished", "camp_1")];
  assert.deepEqual(selectPlannedRuns("camp_1", records), []);
});

test("selectPlannedRuns returns [] for an unknown campaign id", () => {
  const records = [rec("a", "planned", "camp_1")];
  assert.deepEqual(selectPlannedRuns("camp_X", records), []);
});

test("selectPlannedRuns preserves input order and does not mutate the input array", () => {
  const records = [rec("z", "planned", "camp_1"), rec("a", "planned", "camp_1")];
  const snapshot = records.map((r) => r.run_id);
  const selected = selectPlannedRuns("camp_1", records);
  assert.deepEqual(selected.map((r) => r.run_id), ["z", "a"], "selection preserves caller order (no sort)");
  assert.deepEqual(records.map((r) => r.run_id), snapshot, "input array is not reordered");
});
