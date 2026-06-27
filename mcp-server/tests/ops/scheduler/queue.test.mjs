import assert from "node:assert/strict";
import test from "node:test";
import { orderQueue, launchableBatch } from "../../../dist/ops/scheduler/control/queue.js";

const rec = (run_id, status, queue_position) => ({ run_id, status, queue_position, campaign_id: "c1" });

test("orderQueue sorts by queue_position FIFO, ties by run_id", () => {
  const ordered = orderQueue([rec("b", "planned", 2), rec("a", "planned", 1), rec("c", "planned", 1)]);
  assert.deepEqual(ordered.map((r) => r.run_id), ["a", "c", "b"]);
});

test("launchableBatch respects max_concurrent minus already-running", () => {
  const recs = [
    rec("r1", "running", 0), rec("r2", "planned", 1), rec("r3", "planned", 2), rec("r4", "planned", 3)
  ];
  const batch = launchableBatch(recs, { maxConcurrent: 3 });
  // 1 running + room for 2 more → r2, r3
  assert.deepEqual(batch.map((r) => r.run_id), ["r2", "r3"]);
});

test("launchableBatch returns empty when max_concurrent is saturated", () => {
  const recs = [rec("r1", "running", 0), rec("r2", "running", 1), rec("r3", "planned", 2)];
  assert.deepEqual(launchableBatch(recs, { maxConcurrent: 2 }), []);
});

test("launchableBatch ignores terminal and non-campaign runs", () => {
  const recs = [
    rec("r1", "finished", 0), rec("r2", "failed", 1), rec("r3", "planned", 2),
    { run_id: "x", status: "planned", queue_position: 3, campaign_id: "OTHER" }
  ];
  const batch = launchableBatch(recs, { maxConcurrent: 5, campaignId: "c1" });
  assert.deepEqual(batch.map((r) => r.run_id), ["r3"]);
});
