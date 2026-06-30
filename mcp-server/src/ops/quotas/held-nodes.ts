// Read-only live-discovery seam: fetches the set of iHPC compute nodes an account currently holds
// by running `cnode mynodes` on the account's login host. No approval gate; no side-effects.
//
// Also the canonical home for parseIhpcActiveNodes (moved from quotas.ts so there is exactly one
// parser; quotas.ts re-imports it from here).

import { type CommandExecutor, defaultCommandExecutor, type CommandResult } from "../../core/access.js";
import { getProfile } from "../../core/config.js";
import { normalizeTimeout } from "../../lib/shared.js";
import { sshReadOnlyArgs } from "../../lib/ssh.js";
import { isSafeRemoteJobId } from "../../core/ids.js";
import { inferNodeFamily } from "./quota-limits.js";

// Timeout policy: mirrors the quotas module (same probe class — a single SSH read-only command).
const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 30_000;

export interface HeldNodesResult {
  /** true = cnode mynodes succeeded; heldNodes is authoritative (may be empty = holds nothing) */
  ok: boolean;
  /** node names the account currently holds */
  heldNodes: Set<string>;
  /** ISO 8601 timestamp of when the probe ran */
  observedAt: string;
  /** present only when ok === false: short failure summary */
  reason?: string;
}

export async function fetchHeldNodes(
  profileId: string,
  opts?: {
    configPath?: string;
    executor?: CommandExecutor;
    timeoutMs?: number;
    now?: Date;
  }
): Promise<HeldNodesResult> {
  const profile = getProfile(profileId, opts?.configPath);
  const timeoutMs = normalizeTimeout(opts?.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor: CommandExecutor = opts?.executor ?? defaultCommandExecutor;
  const observedAt = (opts?.now ?? new Date()).toISOString();

  const remoteArgv = ["cnode", "mynodes"];
  const args = sshReadOnlyArgs(profile.login.host_alias, timeoutMs, remoteArgv);

  let result: CommandResult;
  try {
    result = await executor("ssh", args, timeoutMs);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, heldNodes: new Set(), observedAt, reason: `executor threw: ${msg}` };
  }

  if (result.exitCode !== 0) {
    const detail = result.stderr.trim() || `exit ${String(result.exitCode ?? "unknown")}`;
    return {
      ok: false,
      heldNodes: new Set(),
      observedAt,
      reason: `cnode mynodes failed: ${detail}`
    };
  }

  const nodes = parseIhpcActiveNodes(result.stdout);
  return {
    ok: true,
    heldNodes: new Set(nodes.map((n) => n.node)),
    observedAt
  };
}

/**
 * Parse the stdout of `cnode mynodes` into validated node entries.
 *
 * Canonical home (moved here from quotas.ts); quotas.ts re-imports from here.
 * Filters the column-header line (`Node …`), empty lines, and `no …` sentinel lines.
 * Validates each candidate node name with `isSafeRemoteJobId` (the same guard used for PBS job ids
 * and iHPC node names throughout the plugin) and infers the node family from its name prefix.
 *
 * Validated live fixtures:
 *   - liyou:  "mars11 mars\nvenus2 venus\n"  → [{node:"mars11",family:"mars"},{node:"venus2",family:"venus"}]
 *   - zhiwli: "mars4 mars\nsaturn10 saturn\nturing2 turing\n" → 3 entries
 */
export function parseIhpcActiveNodes(stdout: string): Array<{ node: string; family?: string }> {
  return stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !/^no\b/i.test(line) && !/^node\b/i.test(line))
    .map((line) => line.split(/\s+/)[0])
    .filter((node) => isSafeRemoteJobId(node))
    .map((node) => ({
      node,
      ...(inferNodeFamily(node) ? { family: inferNodeFamily(node) } : {})
    }));
}
