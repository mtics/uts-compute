// Shared fixture builders for the test suite.
//
// These were copy-pasted verbatim across many test files (the audit colony: tempRuntimeDir in 19
// files, readExample in 14, writeProfileConfig in 4, writeQuotaSnapshot in 5+1-variant, the
// hpcProfile literal in 2). This module is the single home; behavior is byte-identical to the prior
// inline copies.
import fs from "node:fs";
import path from "node:path";

import { repoRoot, examplesDir, runtimeRoot } from "./paths.mjs";

// A unique, collision-resistant scratch directory under the default `.uts-computing` runtime root.
// Matches the prior inline definition exactly: pid + millis + random-hex suffix, recursive mkdir.
export function tempRuntimeDir(prefix) {
  const dir = path.join(runtimeRoot, `${prefix}-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// Load a committed job-spec example from examples/jobs/<name>.
export function readExample(name) {
  return JSON.parse(fs.readFileSync(path.join(examplesDir, "jobs", name), "utf8"));
}

// Load a committed transfer-spec example from examples/transfers/<name>.
export function readTransferExample(name) {
  return JSON.parse(fs.readFileSync(path.join(examplesDir, "transfers", name), "utf8"));
}

// Write a `{ version: 1, profiles }` config file under a fresh temp dir and return its path.
export function writeProfileConfig(label, profiles) {
  const dir = tempRuntimeDir(`test-config-${label}`);
  const file = path.join(dir, "profiles.json");
  fs.writeFileSync(file, `${JSON.stringify({ version: 1, profiles }, null, 2)}\n`, "utf8");
  return file;
}

// Write a fresh quota snapshot under the default `.uts-computing/quotas` runtime dir.
// observedAt is required at every call site that previously inlined this (4-arg form); the
// jobs-track variant passed SEED_NOW.toISOString() and now does so at the call site.
export function writeQuotaSnapshot(snapshotId, profileId, platform, observedAt) {
  const dir = path.join(runtimeRoot, "quotas");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, `${snapshotId}.json`),
    `${JSON.stringify(
      {
        snapshot_id: snapshotId,
        profile_id: profileId,
        platform,
        observed_at: observedAt,
        source: "quotas.refresh",
        freshness: "fresh",
        summary: {
          identity: {
            remote_user_observed: true
          }
        },
        commands: [],
        warnings: []
      },
      null,
      2
    )}\n`,
    "utf8"
  );
}

// The canonical uts-hpc profile fixture, copy-pasted byte-identically into access/quotas tests.
export const hpcProfile = {
  profile_id: "uts-hpc-account-a",
  platform: "uts-hpc",
  account_label: "hpc-a",
  login: {
    host_alias: "uts-hpc",
    username_ref: "UTS_HPC_ACCOUNT_A_USER",
    ssh_agent: true,
    requires_vpn: true
  },
  defaults: {
    queue: "smallq",
    workspace: "/shared/homes/${USER}/experiments",
    scratch: "/scratch/${USER}"
  },
  quota_snapshot: null
};

// A UTS HPC profile whose host_alias carries an explicit `user@` login, so the planner's
// resolveRemoteUser substitutes ${USER} at PLAN time — exactly the real LIVE submit contract (PBS does
// NOT expand ${USER} in -o/-e, so the workdir must already be fully resolved). Tests that exercise the
// live mkdir+qsub path use this profile (via writeProfileConfig + configPath) so the pre-qsub mkdir and
// PBS open the SAME concrete dir, instead of the bundled bare-alias example that leaves ${USER} literal
// (which jobs.submit now FAILS CLOSED on, since that literal path is the zero-log incident's root cause).
export const RESOLVED_HPC_USER = "u00000001";
// The full SSH target token the transport carries (the `user@host` alias). Test executors locate the
// remote argv as everything AFTER this token in the assembled ssh args.
export const RESOLVED_HPC_ALIAS = `${RESOLVED_HPC_USER}@uts-hpc`;
export const resolvedHpcProfile = {
  profile_id: "uts-hpc-account-a",
  platform: "uts-hpc",
  account_label: "hpc-a",
  login: {
    host_alias: RESOLVED_HPC_ALIAS,
    username_ref: "UTS_HPC_ACCOUNT_A_USER",
    ssh_agent: true,
    requires_vpn: true
  },
  defaults: {
    queue: "smallq",
    workspace: "/shared/homes/${USER}/experiments",
    scratch: "/scratch/${USER}"
  },
  quota_snapshot: null
};

// Write a profiles config holding the single resolved-user HPC profile and return its path.
export function writeResolvedHpcConfig(label = "resolved-hpc") {
  return writeProfileConfig(label, [resolvedHpcProfile]);
}

// The concrete (resolved) workdir the planner produces for resolvedHpcProfile + a run id — ${USER}
// substituted to RESOLVED_HPC_USER, matching the profile's workspace root. This is what a real live
// submit always carries; the pre-qsub mkdir and PBS's -o/-e open exactly this path.
export function resolvedHpcWorkdir(runId) {
  return `/shared/homes/${RESOLVED_HPC_USER}/experiments/${runId}`;
}

// Re-export so fixture consumers can anchor their own paths without a second import.
export { repoRoot, examplesDir, runtimeRoot };
