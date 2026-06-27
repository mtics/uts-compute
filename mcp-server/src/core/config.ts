import fs from "node:fs";
import path from "node:path";
import YAML from "yaml";
import { assertInsideProject, projectRoot } from "./paths.js";
import { assertProfile, validateProfile } from "./validation.js";
import { PLATFORM } from "./types.js";
import type { ComputeProfile, JobSpec, ProfileConfig, SubmissionContext } from "./types.js";

const DEFAULT_CONFIG = "profiles/profiles.example.yaml";

// The bundled example profiles, resolved from the SERVER's own location (projectRoot is derived from
// the compiled dist path, not the CWD), so the fallback is correct no matter where the host launches
// the server from or which install dir it lives in.
export function bundledExampleConfigPath(): string {
  return path.resolve(projectRoot, DEFAULT_CONFIG);
}

// Resolve the effective profiles-config path (Bug P0). UTS_COMPUTING_CONFIG is honored only when it is
// set, free of any unsubstituted "${...}" token, and points at an existing file; otherwise the server
// falls back to the bundled example (warning to stderr). This keeps both shipping channels alive when
// the host did NOT substitute its path token: the Desktop .mcpb does not substitute ${__dirname} inside
// user_config defaults, and a Code-plugin ${CLAUDE_PLUGIN_ROOT} miss lands here too.
export function defaultConfigPath(): string {
  const env = process.env.UTS_COMPUTING_CONFIG;
  // Unset, empty, or a literal "${...}" (token not substituted by the host) all mean "not provided".
  if (!env || env.includes("${")) {
    if (env && env.includes("${")) {
      process.stderr.write(
        `uts-compute: UTS_COMPUTING_CONFIG="${env}" still contains an unsubstituted token; ` +
          `using the bundled example profiles. Set an absolute path to use real accounts.\n`
      );
    } else {
      // H4/M13: the unset/empty fallback was previously SILENT, so an operator (or agent) could not tell
      // the plugin was running against fake example accounts. Make it loud, like the other two branches.
      process.stderr.write(
        "uts-compute: UTS_COMPUTING_CONFIG is unset; using the bundled example profiles. " +
          "Set an absolute path to use real accounts.\n"
      );
    }
    return bundledExampleConfigPath();
  }
  // path.normalize collapses a doubled separator (a trailing-slash ${CLAUDE_PLUGIN_ROOT}/${__dirname}
  // makes the env value "<root>//profiles/..."), so the resolved path — and the config_status.config_path
  // it feeds the tool envelope — is clean. Same file either way; the OS collapses "//", this is cosmetic.
  const resolved = path.normalize(path.isAbsolute(env) ? env : path.resolve(projectRoot, env));
  if (!fs.existsSync(resolved)) {
    process.stderr.write(
      `uts-compute: UTS_COMPUTING_CONFIG="${env}" was not found; using the bundled example profiles.\n`
    );
    return bundledExampleConfigPath();
  }
  return resolved;
}

// H4/M13 self-disclosure: report, without any IO beyond the path resolution above, whether the server
// is currently operating against the bundled EXAMPLE profiles (fake accounts) versus a real operator
// config. The tool envelope surfaces this so the agent — which reads results, not stderr — can tell the
// difference (e.g. an "example-profile" SSH miss is not a VPN failure to be retried).
export function effectiveConfigStatus(): { using_example_profiles: boolean; config_path: string } {
  const config_path = defaultConfigPath();
  return { using_example_profiles: config_path === bundledExampleConfigPath(), config_path };
}

export function loadProfileConfig(configPath = defaultConfigPath()): ProfileConfig {
  // configPath is operator-supplied (env var / Desktop user_config / explicit test/internal arg), NOT
  // an MCP tool argument, so an absolute path may legitimately point outside the project (a user's own
  // profiles file). Accept absolute paths as-is; confine RELATIVE paths to the project root, preserving
  // the prior traversal guard for the only paths that could be attacker-influenced.
  const resolved = path.isAbsolute(configPath) ? configPath : assertInsideProject(configPath, "Profile config path");
  const parsed = YAML.parse(fs.readFileSync(resolved, "utf8")) as unknown;

  if (!parsed || typeof parsed !== "object") {
    throw new Error(`Profile config is not an object: ${resolved}`);
  }

  const config = parsed as ProfileConfig;
  if (config.version !== 1) {
    throw new Error(`Unsupported profile config version: ${String(config.version)}`);
  }
  if (!Array.isArray(config.profiles)) {
    throw new Error(`Profile config must contain a profiles array: ${resolved}`);
  }

  const seen = new Set<string>();
  for (const profile of config.profiles) {
    assertProfile(profile);
    if (seen.has(profile.profile_id)) {
      throw new Error(`Duplicate profile_id: ${profile.profile_id}`);
    }
    seen.add(profile.profile_id);
  }

  return config;
}

export function listProfiles(configPath?: string): ComputeProfile[] {
  return loadProfileConfig(configPath).profiles;
}

export function getProfile(profileId: string, configPath?: string): ComputeProfile {
  const profile = listProfiles(configPath).find((candidate) => candidate.profile_id === profileId);
  if (!profile) {
    throw new Error(`Unknown profile_id: ${profileId}`);
  }
  return profile;
}

export function validateProfiles(configPath?: string, profileId?: string) {
  const profiles = listProfiles(configPath).filter((profile) => !profileId || profile.profile_id === profileId);
  if (profileId && profiles.length === 0) {
    throw new Error(`Unknown profile_id: ${profileId}`);
  }

  return profiles.map((profile) => ({
    profile_id: profile.profile_id,
    platform: profile.platform,
    redacted_profile: redactProfile(profile),
    ...validateProfile(profile),
    warnings: semanticProfileWarnings(profile)
  }));
}

// The account name shown by profiles.list is the real remote login account, derived from the
// login config rather than a hand-written label: the user part of a `user@host` alias, or a
// bare alias when it is itself the account. The host part stays redacted.
export function profileAccountName(profile: ComputeProfile): string {
  const alias = profile.login.host_alias ?? "";
  if (alias.includes("@")) {
    return alias.slice(0, alias.indexOf("@"));
  }
  return alias || profile.account_label;
}

// The cluster login host from a profile's host_alias: the part after "@" (dropping the username),
// or the whole alias when there is no "@". A hostname/SSH alias, never a credential.
export function clusterFromHostAlias(hostAlias: string): string {
  const alias = hostAlias ?? "";
  const at = alias.indexOf("@");
  return at >= 0 ? alias.slice(at + 1) : alias;
}

// Freeze the secret-free submission context for a run record: the account label, cluster login host,
// queue, requested resources, and (when known) the compute node. Shared by the PBS and iHPC paths.
export function buildSubmissionContext(
  profile: ComputeProfile,
  resources: JobSpec["resources"],
  submittedAt: string,
  node?: string
): SubmissionContext {
  const requested: SubmissionContext["requested"] = {};
  if (resources.ncpus !== undefined) requested.ncpus = resources.ncpus;
  if (resources.memory_gb !== undefined) requested.memory_gb = resources.memory_gb;
  if (resources.walltime !== undefined) requested.walltime = resources.walltime;
  if (resources.ngpus !== undefined) requested.ngpus = resources.ngpus;
  return {
    account_label: profile.account_label,
    cluster: clusterFromHostAlias(profile.login.host_alias),
    ...(resources.queue ? { queue: resources.queue } : {}),
    ...(node ? { node } : {}),
    requested,
    submitted_at: submittedAt
  };
}

// Snapshot freshness window. Mirrors FRESH_MINUTES in ops/quotas/capacity.ts and the conformance
// gate's ≤15-minute rule: a snapshot older than this is reported stale and must be refreshed before
// it can gate a live submission.
const QUOTA_FRESH_WINDOW_MS = 15 * 60 * 1000;

function snapshotFreshness(observedAt: string | undefined, now: Date): "fresh" | "stale" | "missing" {
  if (!observedAt) return "missing";
  const observedMs = Date.parse(observedAt);
  if (!Number.isFinite(observedMs)) return "missing";
  return now.getTime() - observedMs <= QUOTA_FRESH_WINDOW_MS ? "fresh" : "stale";
}

// `latestSnapshot` is the most recent persisted quota snapshot for this profile (read from the store
// by the caller); when omitted, the embedded profile field is used. Freshness is derived from the
// snapshot's age so profiles.list reflects what quotas.refresh actually persisted, rather than always
// reporting "missing".
export function redactProfile(
  profile: ComputeProfile,
  latestSnapshot?: Record<string, unknown> | null,
  now: Date = new Date()
) {
  const snapshot = (latestSnapshot ?? (profile.quota_snapshot as Record<string, unknown> | null | undefined) ?? null) as
    | Record<string, unknown>
    | null;
  const observedAt = snapshot && typeof snapshot.observed_at === "string" ? snapshot.observed_at : undefined;
  return {
    profile_id: profile.profile_id,
    platform: profile.platform,
    account: profileAccountName(profile),
    login: {
      username_ref: profile.login.username_ref,
      has_host_alias: Boolean(profile.login.host_alias),
      ssh_agent: Boolean(profile.login.ssh_agent),
      requires_vpn: profile.login.requires_vpn,
      has_identity_file_ref: Boolean(profile.login.identity_file_ref),
      has_keychain_ref: Boolean(profile.login.keychain_ref)
    },
    defaults: {
      queue: profile.defaults.queue,
      node_family: profile.defaults.node_family,
      // Attribution labels are SURFACED, not redacted: the campaign ledger's purpose is disclosure,
      // and these are non-secret labels (like account_label), never a real account id.
      owner: profile.defaults.owner,
      allocation: profile.defaults.allocation,
      has_workspace: Boolean(profile.defaults.workspace),
      has_scratch: Boolean(profile.defaults.scratch),
      has_project: Boolean(profile.defaults.project),
      // node_scheduler: disclose presence + runner (a non-secret mode label like 'uv'). The field was
      // reduced to just `runner` post-internalization, so there are no node-path sub-options to redact.
      has_node_scheduler: Boolean(profile.defaults.node_scheduler),
      node_scheduler_runner: profile.defaults.node_scheduler?.runner ?? "console"
    },
    quota_snapshot: observedAt
      ? {
          observed_at: observedAt,
          source: typeof snapshot?.source === "string" ? snapshot.source : undefined,
          freshness: snapshotFreshness(observedAt, now),
          has_summary: Boolean(snapshot?.summary)
        }
      : { freshness: "missing" }
  };
}

function semanticProfileWarnings(profile: ComputeProfile): string[] {
  const warnings: string[] = [];
  if (profile.platform === PLATFORM.HPC && !profile.defaults.queue) {
    warnings.push("UTS HPC profile has no default queue; jobs must specify resources.queue");
  }
  if (profile.platform === PLATFORM.IHPC && !profile.defaults.node_family) {
    warnings.push("UTS iHPC profile has no default node_family; jobs must specify resources.node_family");
  }
  if (!profile.defaults.workspace && !profile.defaults.scratch) {
    warnings.push("Profile has no workspace or scratch root for path policy checks");
  }
  if (profile.quota_snapshot && containsSensitiveKey(profile.quota_snapshot)) {
    warnings.push("quota_snapshot contains sensitive-looking keys; list output is redacted");
  }
  return warnings;
}

function containsSensitiveKey(value: unknown): boolean {
  if (!value || typeof value !== "object") {
    return false;
  }

  return Object.keys(value).some((key) => /password|token|secret|private|credential|mfa|otp/i.test(key));
}

const DEFAULT_USER_ROOT_PREFIXES = ["/data/", "/scratch/", "/shared/homes/"];

// Mount prefixes (the path segment before ${USER}) for each root the profile declares,
// so remote-path redaction masks the username under any profile-declared mount, not just
// the three hardcoded defaults.
export function userRootPrefixes(profile: ComputeProfile): string[] {
  const declared = [profile.defaults.workspace, profile.defaults.scratch, profile.defaults.project];
  const prefixes = new Set<string>();
  for (const root of declared) {
    if (typeof root !== "string") {
      continue;
    }
    const marker = root.indexOf("${USER}");
    if (marker > 0) {
      prefixes.add(root.slice(0, marker));
    }
  }
  return [...prefixes];
}

// Replace the user segment that follows a known mount prefix with <user>. The longest matching
// prefix wins so a derived prefix like /data/labx/ is never mis-masked by the shorter /data/ default.
export function maskUserRootPath(value: string, extraPrefixes: string[] = []): string {
  const prefixes = [...new Set([...extraPrefixes, ...DEFAULT_USER_ROOT_PREFIXES])].sort((a, b) => b.length - a.length);
  for (const prefix of prefixes) {
    if (!value.startsWith(prefix)) {
      continue;
    }
    const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const masked = value.replace(
      new RegExp(`^${escaped}(?:\\$\\{USER\\}|[A-Za-z0-9._-]+)(/|$)`),
      (_match, tail) => `${prefix}<user>${tail}`
    );
    if (masked !== value) {
      return masked;
    }
  }
  return value;
}
