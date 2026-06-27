import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { buildRunRecord, writeRunRecord, readRunRecord, updateRunRecord } from "../../dist/core/audit.js";
import { repoRoot, runtimeRoot } from "../helpers/index.mjs";

function tempAuditDir() {
  // Anchored on the per-process isolated runtimeRoot (Bug P2), not the plugin/repo dir.
  const dir = path.join(runtimeRoot, `test-concurrency-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function seedRecord(auditDir) {
  const job = JSON.parse(fs.readFileSync(path.join(repoRoot, "examples/jobs", "hpc-cpu.json"), "utf8"));
  const record = buildRunRecord(job, "seed"); // rev 0
  writeRunRecord(record, auditDir);
  return record.run_id;
}

test("updateRunRecord bumps rev and refuses a write from a stale base rev (optimistic concurrency)", () => {
  const auditDir = tempAuditDir();
  const runId = seedRecord(auditDir);

  // Two actors read the same record at rev 0 (e.g. a jobs.track sweep and a jobs.cancel).
  const actorA = readRunRecord(runId, auditDir);
  const actorB = readRunRecord(runId, auditDir);
  assert.equal(actorA.rev, 0);

  // Actor B writes first → on-disk rev advances to 1.
  actorB.status = "running";
  updateRunRecord(actorB, auditDir);
  assert.equal(readRunRecord(runId, auditDir).rev, 1);

  // Actor A still holds rev 0; its write must be refused, not silently clobber B's update.
  actorA.status = "cancelled";
  assert.throws(() => updateRunRecord(actorA, auditDir), /changed concurrently/);
  assert.equal(readRunRecord(runId, auditDir).status, "running");
});

test("sequential updates on the same in-memory record advance rev without conflict", () => {
  const auditDir = tempAuditDir();
  const runId = seedRecord(auditDir);
  const record = readRunRecord(runId, auditDir);
  record.status = "submitting";
  updateRunRecord(record, auditDir);
  record.status = "submitted";
  updateRunRecord(record, auditDir);
  assert.equal(readRunRecord(runId, auditDir).rev, 2);
  assert.equal(readRunRecord(runId, auditDir).status, "submitted");
});

test("a legacy record without a rev updates without a false conflict and adopts rev 1", () => {
  const auditDir = tempAuditDir();
  const runId = seedRecord(auditDir);
  // Strip the rev to simulate a record written before this field existed.
  const filePath = path.join(auditDir, `${runId}.json`);
  const legacy = JSON.parse(fs.readFileSync(filePath, "utf8"));
  delete legacy.rev;
  fs.writeFileSync(filePath, `${JSON.stringify(legacy, null, 2)}\n`, "utf8");

  const record = readRunRecord(runId, auditDir);
  assert.equal(record.rev, undefined);
  record.status = "running";
  updateRunRecord(record, auditDir);
  assert.equal(readRunRecord(runId, auditDir).rev, 1);
});
