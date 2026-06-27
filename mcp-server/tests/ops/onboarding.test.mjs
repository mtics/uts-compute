import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import {
  assertProfileOnboarded,
  isProfileOnboarded,
  writeOnboardingRecord,
  onboardProfile
} from "../../dist/ops/profiles/onboarding.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

function pbsSnapshot(overrides = {}) {
  return {
    snapshot_id: "ob-snap",
    profile_id: "uts-hpc-account-a",
    platform: "uts-hpc",
    observed_at: "2026-06-15T00:00:00.000Z",
    source: "quotas.refresh",
    freshness: "fresh",
    summary: {
      identity: { remote_user_observed: true },
      queues: {
        queue_limits: [{ name: "smallq", enabled: true, started: true, resources_max: {}, max_run: { perUserGeneric: 5 } }]
      },
      running_work: { by_queue: { smallq: { running: 1, queued: 0 } } },
      storage: { filesystems: [] }
    },
    commands: [],
    warnings: [],
    ...overrides
  };
}

test("assertProfileOnboarded throws when there is no record and no snapshot", () => {
  const onboardingDir = tempRuntimeDir("ob-empty");
  const quotaDir = tempRuntimeDir("ob-empty-q");
  assert.throws(() => assertProfileOnboarded("uts-hpc-account-a", onboardingDir, quotaDir), /onboard/i);
});

test("a written onboarding record satisfies the gate", () => {
  const onboardingDir = tempRuntimeDir("ob-rec");
  const quotaDir = tempRuntimeDir("ob-rec-q");
  writeOnboardingRecord(
    {
      profile_id: "uts-hpc-account-a",
      platform: "uts-hpc",
      onboarded_at: "2026-06-15T00:00:00.000Z",
      snapshot_id: "snap-1",
      cluster: "cetus"
    },
    onboardingDir
  );
  assert.equal(isProfileOnboarded("uts-hpc-account-a", onboardingDir, quotaDir), true);
});

test("an existing quota snapshot satisfies the gate (back-compat with prior connections)", () => {
  const onboardingDir = tempRuntimeDir("ob-snap-only");
  const quotaDir = tempRuntimeDir("ob-snap-only-q");
  fs.writeFileSync(path.join(quotaDir, "snap-x.json"), `${JSON.stringify(pbsSnapshot({ snapshot_id: "snap-x" }), null, 2)}\n`, "utf8");
  assert.equal(isProfileOnboarded("uts-hpc-account-a", onboardingDir, quotaDir), true);
  assert.equal(isProfileOnboarded("uts-hpc-account-b", onboardingDir, quotaDir), false);
});

test("onboard connects, writes the onboarding record, and reports discovered limits", async () => {
  const onboardingDir = tempRuntimeDir("ob-tool");
  const result = await onboardProfile(
    { profileId: "uts-hpc-account-a" },
    {
      onboardingDir,
      now: new Date("2026-06-15T00:05:00.000Z"),
      refresh: async () => ({ mode: "read-only", snapshot: pbsSnapshot() })
    }
  );
  assert.equal(result.onboarding.profile_id, "uts-hpc-account-a");
  assert.equal(result.onboarding.snapshot_id, "ob-snap");
  assert.equal(result.capacity.best_queue, "smallq");
  assert.equal(result.capacity.recommended_parallel, 4);
  assert.equal(isProfileOnboarded("uts-hpc-account-a", onboardingDir, tempRuntimeDir("ob-tool-empty-q")), true);
});

test("onboard refuses to mark onboarded when the live identity was not observed", async () => {
  const onboardingDir = tempRuntimeDir("ob-fail");
  await assert.rejects(
    () =>
      onboardProfile(
        { profileId: "uts-hpc-account-a" },
        {
          onboardingDir,
          refresh: async () => ({
            mode: "read-only",
            snapshot: pbsSnapshot({ summary: { identity: { remote_user_observed: false } } })
          })
        }
      ),
    /access|identity|onboard/i
  );
  assert.equal(isProfileOnboarded("uts-hpc-account-a", onboardingDir, tempRuntimeDir("ob-fail-q")), false);
});
