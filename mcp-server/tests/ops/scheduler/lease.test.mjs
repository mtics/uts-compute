import assert from "node:assert/strict";
import test from "node:test";
import { decideLease, isLeaseStale } from "../../../dist/ops/scheduler/control/lease.js";

const me = { client: "claude", device_id: "laptop-7f3a", issued_at: "2026-06-20T14:32:10Z" };
const other = { client: "codex", device_id: "desktop-9", issued_at: "2026-06-20T14:00:00Z" };

test("decideLease=acquire when no lease exists", () => {
  const d = decideLease({ held: null, me, nodeNowEpoch: 1000, heartbeatEpoch: null, staleSeconds: 120 });
  assert.equal(d.action, "acquire");
});

test("decideLease=refresh when we already hold it", () => {
  const d = decideLease({ held: me, me, nodeNowEpoch: 1000, heartbeatEpoch: 990, staleSeconds: 120 });
  assert.equal(d.action, "refresh");
});

test("decideLease=blocked when a LIVE other holder owns it", () => {
  const d = decideLease({ held: other, me, nodeNowEpoch: 1000, heartbeatEpoch: 980, staleSeconds: 120 });
  assert.equal(d.action, "blocked");
  assert.equal(d.holder.client, "codex");
});

test("decideLease=takeover when the other holder's lease is STALE (dead)", () => {
  // heartbeat 800,now 1000 → age 200 > 120 → stale → 接管
  const d = decideLease({ held: other, me, nodeNowEpoch: 1000, heartbeatEpoch: 800, staleSeconds: 120 });
  assert.equal(d.action, "takeover");
});

test("isLeaseStale uses node-clock age only (no cross-clock subtraction)", () => {
  assert.equal(isLeaseStale({ nodeNowEpoch: 1000, heartbeatEpoch: 800, staleSeconds: 120 }), true);
  assert.equal(isLeaseStale({ nodeNowEpoch: 1000, heartbeatEpoch: 950, staleSeconds: 120 }), false);
  assert.equal(isLeaseStale({ nodeNowEpoch: 1000, heartbeatEpoch: null, staleSeconds: 120 }), true); // no heartbeat → stale
});
