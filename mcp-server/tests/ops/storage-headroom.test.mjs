import assert from "node:assert/strict";
import test from "node:test";
import { parseDfAvailable, parseHumanBytes } from "../../dist/ops/quotas/quota-limits.js";
import { checkStorageHeadroom } from "../../dist/ops/quotas/conformance.js";

const GiB = 1024 ** 3;
const TiB = 1024 ** 4;

test("parseHumanBytes converts df -h human sizes to bytes", () => {
  assert.equal(parseHumanBytes("400G"), 400 * GiB);
  assert.equal(parseHumanBytes("1.2T"), Math.round(1.2 * TiB));
  assert.equal(parseHumanBytes("512"), 512);
  assert.equal(parseHumanBytes("0"), 0);
  assert.equal(parseHumanBytes("-"), null);
  assert.equal(parseHumanBytes(""), null);
});

test("parseDfAvailable parses df -hP rows into structured filesystem availability", () => {
  const stdout = [
    "Filesystem            Size  Used Avail Capacity Mounted on",
    "nfs.example:/data     1.2T  800G  400G      67% /data",
    "nfs.example:/scratch  900G  890G   10G      99% /scratch"
  ].join("\n");

  const rows = parseDfAvailable(stdout);
  assert.equal(rows.length, 2);
  assert.deepEqual(
    { ...rows[0], avail_bytes: rows[0].avail_bytes },
    {
      filesystem: "nfs.example:/data",
      size: "1.2T",
      used: "800G",
      avail: "400G",
      capacity_percent: 67,
      mounted_on: "/data",
      avail_bytes: 400 * GiB
    }
  );
  assert.equal(rows[1].capacity_percent, 99);
  assert.equal(rows[1].mounted_on, "/scratch");
});

test("parseDfAvailable tolerates a blank or header-only payload", () => {
  assert.deepEqual(parseDfAvailable(""), []);
  assert.deepEqual(parseDfAvailable("Filesystem Size Used Avail Capacity Mounted on"), []);
});

test("checkStorageHeadroom flags a filesystem at or above the capacity ceiling", () => {
  const filesystems = [
    { mounted_on: "/data", capacity_percent: 67, avail_bytes: 400 * GiB },
    { mounted_on: "/scratch", capacity_percent: 99, avail_bytes: 10 * GiB }
  ];
  const violations = checkStorageHeadroom(filesystems);
  assert.equal(violations.length, 1);
  assert.equal(violations[0].code, "storage-full");
  assert.match(violations[0].message, /\/scratch/);
});

test("checkStorageHeadroom restricts to the target mount when given a target path", () => {
  const filesystems = [
    { mounted_on: "/data", capacity_percent: 67, avail_bytes: 400 * GiB },
    { mounted_on: "/scratch", capacity_percent: 100, avail_bytes: 0 }
  ];
  // The job writes under /data, so a full /scratch must NOT block it.
  const ok = checkStorageHeadroom(filesystems, { targetPath: "/data/${USER}/experiments/run-1" });
  assert.deepEqual(ok, []);
  // ...but a full target mount blocks.
  const bad = checkStorageHeadroom(filesystems, { targetPath: "/scratch/${USER}/tmp" });
  assert.equal(bad.length, 1);
  assert.equal(bad[0].code, "storage-full");
});

test("checkStorageHeadroom is a no-op when no filesystem availability was observed", () => {
  assert.deepEqual(checkStorageHeadroom([]), []);
  assert.deepEqual(checkStorageHeadroom(undefined), []);
});
