// First-run onboarding for a profile. Before any live submission, a profile must have completed a
// real connection to its account that confirmed access and captured the resource-allocation limits.
// onboardProfile() performs that connection (via quotas.refresh) and writes a persistent marker;
// assertProfileOnboarded() is the hard gate the submit paths call. A pre-existing quota snapshot for
// the profile also satisfies the gate, so accounts connected before onboarding existed aren't blocked.

import fs from "node:fs";
import path from "node:path";
import { clusterFromHostAlias, getProfile } from "../../core/config.js";
import { refreshQuotas } from "../quotas/quotas.js";
import { computeCapacity, type CapacityReport } from "../quotas/capacity.js";
import { assertInsideRuntime, RUNTIME_DIRS } from "../../core/paths.js";
import { assertOnboardingRecord } from "../../core/validation.js";
import type { OnboardingRecord, QuotaRefreshResult, QuotaSnapshot } from "../../core/types.js";

// Typed `: string` (not the `as const` literal) so the `onboardingDir = ONBOARDING_DIR` /
// `quotaDir = QUOTA_DIR` default-parameter sites keep their prior widened-`string` param type;
// RUNTIME_DIRS would otherwise narrow them to a single string-literal type. Values are byte-identical.
const ONBOARDING_DIR: string = RUNTIME_DIRS.onboarding;
const QUOTA_DIR: string = RUNTIME_DIRS.quotas;

function assertSafeProfileId(profileId: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(profileId)) {
    throw new Error(`Unsafe profile_id: ${profileId}`);
  }
}

export function writeOnboardingRecord(record: OnboardingRecord, onboardingDir = ONBOARDING_DIR): string {
  assertOnboardingRecord(record);
  assertSafeProfileId(record.profile_id);
  const dir = assertInsideRuntime(onboardingDir, "Onboarding directory");
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, `${record.profile_id}.json`);
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return outputPath;
}

export function readOnboardingRecord(profileId: string, onboardingDir = ONBOARDING_DIR): OnboardingRecord | null {
  assertSafeProfileId(profileId);
  const dir = assertInsideRuntime(onboardingDir, "Onboarding directory");
  const filePath = path.join(dir, `${profileId}.json`);
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const record = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
    assertOnboardingRecord(record);
    return record;
  } catch {
    return null;
  }
}

// A profile counts as onboarded if it has an onboarding record, or any captured quota snapshot (which
// could only exist after a real connection) — so prior users are not retroactively locked out.
export function isProfileOnboarded(profileId: string, onboardingDir = ONBOARDING_DIR, quotaDir = QUOTA_DIR): boolean {
  if (readOnboardingRecord(profileId, onboardingDir)) {
    return true;
  }
  return hasQuotaSnapshotForProfile(profileId, quotaDir);
}

export function assertProfileOnboarded(profileId: string, onboardingDir?: string, quotaDir?: string): void {
  if (!isProfileOnboarded(profileId, onboardingDir, quotaDir)) {
    throw new Error(
      `Profile ${profileId} has not completed first-run onboarding. Run the onboard tool to connect to the account, ` +
        `confirm live access, and capture its resource-allocation limits before submitting.`
    );
  }
}

export interface OnboardOptions {
  configPath?: string;
  timeoutMs?: number;
  onboardingDir?: string;
  now?: Date;
  // Injectable for tests; defaults to the real live refreshQuotas.
  refresh?: (profileId: string, opts: { timeoutMs?: number }) => Promise<QuotaRefreshResult>;
}

export interface OnboardResult {
  onboarding: OnboardingRecord;
  quota: QuotaRefreshResult;
  capacity: CapacityReport;
}

// Connect to the account, confirm live access (remote identity observed), persist the onboarding
// marker, and report the discovered capacity. Throws — without writing a marker — if the connection
// could not be confirmed, so a failed first connection does not unlock submission.
export async function onboardProfile(input: { profileId: string }, options: OnboardOptions = {}): Promise<OnboardResult> {
  const now = options.now ?? new Date();
  const profile = getProfile(input.profileId, options.configPath);
  const refresh = options.refresh ?? refreshQuotas;
  const quota = await refresh(input.profileId, { timeoutMs: options.timeoutMs });
  const snapshot = quota.snapshot;
  if (!liveAccessConfirmed(snapshot)) {
    throw new Error(
      `Onboarding for ${input.profileId} could not confirm live access (remote identity not observed). ` +
        `Check connectivity with access.doctor and retry; the profile remains not onboarded.`
    );
  }
  const record: OnboardingRecord = {
    profile_id: input.profileId,
    platform: profile.platform,
    onboarded_at: now.toISOString(),
    snapshot_id: snapshot.snapshot_id,
    cluster: clusterFromHostAlias(profile.login.host_alias)
  };
  writeOnboardingRecord(record, options.onboardingDir);
  const capacity = computeCapacity(snapshot, remoteUserFromHostAlias(profile.login.host_alias), [], now);
  return { onboarding: record, quota, capacity };
}

function liveAccessConfirmed(snapshot: QuotaSnapshot): boolean {
  const identity = (snapshot.summary.identity ?? {}) as { remote_user_observed?: boolean };
  return identity.remote_user_observed === true;
}

function hasQuotaSnapshotForProfile(profileId: string, quotaDir: string): boolean {
  let dir: string;
  try {
    dir = assertInsideRuntime(quotaDir, "Quota snapshot directory");
  } catch {
    return false;
  }
  if (!fs.existsSync(dir)) {
    return false;
  }
  for (const entry of fs.readdirSync(dir)) {
    if (!entry.endsWith(".json")) {
      continue;
    }
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(dir, entry), "utf8")) as { snapshot?: { profile_id?: string }; profile_id?: string };
      const recordProfile = raw.snapshot?.profile_id ?? raw.profile_id;
      if (recordProfile === profileId) {
        return true;
      }
    } catch {
      // skip unreadable snapshots
    }
  }
  return false;
}

function remoteUserFromHostAlias(hostAlias: string): string {
  const at = hostAlias.indexOf("@");
  return at >= 0 ? hostAlias.slice(0, at) : hostAlias;
}
