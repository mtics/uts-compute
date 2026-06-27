import dns from "node:dns/promises";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import { redactCommand } from "./audit.js";
import { getProfile, redactProfile } from "./config.js";
import { assertSafeSshTarget, errorMessage, normalizeTimeout, safeTimestampOf } from "../lib/shared.js";
import { summarizeRemoteFailure } from "../lib/redact.js";
import { NETWORK_DROP_HINT } from "../lib/net-errors.js";
import { runProcess, type CommandResult } from "../lib/process.js";
import { sshNodeHopFlags, sshOuterHopFlags, sshReadOnlyArgs } from "../lib/ssh.js";
// The SSH/timeout validators (assertSafeSshTarget/normalizeTimeout/sshTimeoutSeconds), the SSH argv
// assemblers (sshReadOnlyArgs/sshJobArgs/sshSupervisorArgs/sshSingleHopArgs), and isSafeRemoteToken
// were historically RE-EXPORTED from here as a compatibility facade after the duplication/layering
// audits relocated them to their canonical homes (lib/shared.ts, lib/ssh.ts, core/ids.ts). The P3
// migration finished routing every consumer (doctor, quotas, ihpc-start, jobs, campaign/start) at
// those real homes directly, removing the ops->core->lib detour for what is really ops->lib, so the
// re-exports are gone. access.ts now imports only what IT uses (sshReadOnlyArgs above, the shared
// validators below) and defines only its own surface (checkAccess, sshOnNode, the executor types).
// Re-export the relocated CommandResult so consumers that still import it from access.ts (artifacts,
// transfer, quotas) keep compiling unchanged — its canonical home is lib/process.ts.
export type { CommandResult } from "../lib/process.js";
import { assertInsideRuntime, RUNTIME_DIRS } from "./paths.js";
import { writeEvidenceJson } from "../lib/evidence.js";
import { assertAccessCheckResult } from "./validation.js";
import type { AccessCheckName, AccessCheckResult, AccessCheckStep, ComputeProfile } from "./types.js";

export type CommandExecutor = (program: string, args: string[], timeoutMs: number) => Promise<CommandResult>;
export type DnsLookup = (host: string) => Promise<{ address: string; family: number }>;
export type TcpCheck = (host: string, port: number, timeoutMs: number) => Promise<void>;

export interface AccessCheckOptions {
  checks?: AccessCheckName[];
  timeoutMs?: number;
  writeEvidence?: boolean;
  configPath?: string;
  executor?: CommandExecutor;
  dnsLookup?: DnsLookup;
  tcpCheck?: TcpCheck;
  now?: Date;
}

interface SshConfig {
  hostname: string;
  port: number;
  has_user: boolean;
  identity_file_count: number;
}

const DEFAULT_CHECKS: AccessCheckName[] = [
  "profile",
  "ssh-config",
  "dns",
  "tcp",
  "host-key",
  "ssh-auth",
  "remote-identity",
  "vpn"
];
// Timeout policy (per-module, deliberate): access is a connectivity probe, so it defaults LOW (5s).
// The 30s cap is shared with the middle modules. This default is policy, not an accident — do not
// flatten it to the 10s default used elsewhere.
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const EVIDENCE_DIR = RUNTIME_DIRS.access;

export async function checkAccess(profileId: string, options: AccessCheckOptions = {}): Promise<AccessCheckResult> {
  const profile = getProfile(profileId, options.configPath);
  return checkAccessForProfile(profile, options);
}

export async function checkAccessForProfile(
  profile: ComputeProfile,
  options: Omit<AccessCheckOptions, "configPath"> = {}
): Promise<AccessCheckResult> {
  assertSafeSshTarget(profile.login.host_alias);

  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const requestedChecks = options.checks ?? DEFAULT_CHECKS;
  const executor = options.executor ?? defaultCommandExecutor;
  const lookup = options.dnsLookup ?? ((host: string) => dns.lookup(host));
  const tcpCheck = options.tcpCheck ?? defaultTcpCheck;
  const observedAt = (options.now ?? new Date()).toISOString();
  const checks: AccessCheckStep[] = [];
  const warnings: string[] = [];
  let sshConfig: SshConfig | undefined;
  // host_alias may carry a `user@` prefix (e.g. u00000004@hpc-host01). DNS/TCP must probe only the
  // HOST part — resolving the whole `user@host` fails ENOTFOUND and falsely reds overall_status even
  // when SSH works. ssh-config (when requested + successful) refines this to the resolved hostname.
  let resolvedHost = profile.login.host_alias.includes("@")
    ? profile.login.host_alias.slice(profile.login.host_alias.lastIndexOf("@") + 1)
    : profile.login.host_alias;
  let port = 22;

  if (profile.login.requires_vpn) {
    warnings.push("Profile requires VPN; failed DNS, TCP, or SSH checks may indicate the UTS VPN is disconnected");
  }

  if (requestedChecks.includes("profile")) {
    checks.push({
      name: "profile",
      status: "passed",
      summary: `Loaded one ${profile.platform} profile`,
      details: {
        redacted_profile: redactProfile(profile)
      }
    });
  } else {
    checks.push({ name: "profile", status: "skipped", summary: "Profile metadata check was not requested" });
  }

  if (requestedChecks.includes("ssh-config")) {
    const step = await runSshConfig(profile.login.host_alias, timeoutMs, executor);
    checks.push(step);
    if (step.status === "passed" && step.details?.ssh_config) {
      sshConfig = step.details.ssh_config as SshConfig;
      resolvedHost = sshConfig.hostname;
      port = sshConfig.port;
    }
  } else {
    checks.push({ name: "ssh-config", status: "skipped", summary: "ssh-config check was not requested" });
  }

  if (requestedChecks.includes("dns")) {
    checks.push(await runDnsCheck(resolvedHost, lookup));
  } else {
    checks.push({ name: "dns", status: "skipped", summary: "DNS check was not requested" });
  }

  const dnsFailed = checks.some((step) => step.name === "dns" && step.status === "failed");
  if (requestedChecks.includes("tcp")) {
    checks.push(
      dnsFailed
        ? { name: "tcp", status: "skipped", summary: "TCP check skipped because DNS failed" }
        : await runTcpCheck(resolvedHost, port, timeoutMs, tcpCheck)
    );
  } else {
    checks.push({ name: "tcp", status: "skipped", summary: "TCP check was not requested" });
  }

  const tcpFailed = checks.some((step) => step.name === "tcp" && step.status === "failed");
  if (requestedChecks.includes("host-key")) {
    checks.push(
      dnsFailed || tcpFailed
        ? { name: "host-key", status: "skipped", summary: "Host-key check skipped because network preflight failed" }
        : await runHostKeyCheck(resolvedHost, timeoutMs, executor)
    );
  } else {
    checks.push({ name: "host-key", status: "skipped", summary: "Host-key check was not requested" });
  }

  if (requestedChecks.includes("ssh-auth")) {
    checks.push(
      dnsFailed || tcpFailed
        ? { name: "ssh-auth", status: "skipped", summary: "SSH auth check skipped because network preflight failed" }
        : await runSshAuthCheck(profile.login.host_alias, timeoutMs, executor)
    );
  } else {
    checks.push({ name: "ssh-auth", status: "skipped", summary: "SSH auth check was not requested" });
  }

  if (requestedChecks.includes("remote-identity")) {
    const authFailed = checks.some((step) => step.name === "ssh-auth" && step.status === "failed");
    checks.push(
      authFailed
        ? { name: "remote-identity", status: "skipped", summary: "Remote identity check skipped because SSH auth failed" }
        : await runRemoteIdentityCheck(profile.login.host_alias, timeoutMs, executor)
    );
  } else {
    checks.push({ name: "remote-identity", status: "skipped", summary: "Remote identity check was not requested" });
  }

  if (requestedChecks.includes("vpn")) {
    checks.push(runVpnInference(profile, checks));
  } else {
    checks.push({ name: "vpn", status: "skipped", summary: "VPN inference was not requested" });
  }

  const result: AccessCheckResult = {
    mode: "read-only",
    profile_id: profile.profile_id,
    platform: profile.platform,
    observed_at: observedAt,
    requires_vpn: profile.login.requires_vpn,
    host_alias: profile.login.host_alias,
    resolved_host: resolvedHost,
    port,
    overall_status: overallStatus(checks),
    checks,
    warnings
  };

  for (const check of result.checks) {
    check.observed_at ??= observedAt;
  }

  // P4 (VPN/network-drop resilience): when a VPN-required profile fails network preflight, the existing
  // VPN inference already reds the `vpn` check; here we add the actionable one-liner (connect the VPN /
  // access.doctor --export-ssh) plus a classified error_kind so an agent gets a clear next step instead of
  // having to decode a wall of red checks. Gated on the SAME VPN-inference signal — a reachable-but-
  // rejected failure (auth / host-key) never reds the `vpn` check, so it correctly gets no hint.
  const networkHint = inferNetworkDropHint(profile, checks);
  if (networkHint) {
    result.error_kind = networkHint.error_kind;
    result.network_hint = networkHint.network_hint;
  }

  assertAccessCheckResult(result);

  if (options.writeEvidence ?? true) {
    result.evidence_path = writeAccessEvidence(result);
  }

  return result;
}

async function runSshConfig(hostAlias: string, timeoutMs: number, executor: CommandExecutor): Promise<AccessCheckStep> {
  return runCommandStep("ssh-config", "ssh", ["-G", hostAlias], timeoutMs, executor, (result) => {
    if (result.exitCode !== 0) {
      return {
        status: "failed",
        summary: summarizeCommandFailure("ssh -G", result),
        details: commandEvidence(result)
      };
    }
    const sshConfig = parseSshConfig(result.stdout, hostAlias);
    return {
      status: "passed",
      summary: `SSH config resolved ${hostAlias} to ${sshConfig.hostname}:${sshConfig.port}`,
      details: {
        ssh_config: sshConfig,
        stdout: redactSshConfigText(result.stdout)
      }
    };
  });
}

async function runDnsCheck(host: string, lookup: DnsLookup): Promise<AccessCheckStep> {
  const started = Date.now();
  try {
    const result = await lookup(host);
    return {
      name: "dns",
      status: "passed",
      summary: `DNS resolved ${host} to ${result.address}`,
      duration_ms: Date.now() - started,
      details: result
    };
  } catch (error) {
    return {
      name: "dns",
      status: "failed",
      summary: `DNS lookup failed for ${host}: ${errorMessage(error)}`,
      duration_ms: Date.now() - started
    };
  }
}

async function runTcpCheck(host: string, port: number, timeoutMs: number, tcpCheck: TcpCheck): Promise<AccessCheckStep> {
  const started = Date.now();
  try {
    await tcpCheck(host, port, timeoutMs);
    return {
      name: "tcp",
      status: "passed",
      summary: `TCP connection to ${host}:${port} succeeded`,
      duration_ms: Date.now() - started,
      details: { host, port }
    };
  } catch (error) {
    return {
      name: "tcp",
      status: "failed",
      summary: `TCP connection to ${host}:${port} failed: ${errorMessage(error)}`,
      duration_ms: Date.now() - started,
      details: { host, port }
    };
  }
}

async function runSshAuthCheck(hostAlias: string, timeoutMs: number, executor: CommandExecutor): Promise<AccessCheckStep> {
  return runCommandStep(
    "ssh-auth",
    "ssh",
    sshReadOnlyArgs(hostAlias, timeoutMs, ["true"]),
    timeoutMs,
    executor,
    (result) =>
      result.exitCode === 0
        ? {
            status: "passed",
            summary: "SSH batch authentication succeeded",
            details: commandEvidence(result)
          }
        : {
            status: "failed",
            summary: summarizeCommandFailure("ssh true", result),
            details: commandEvidence(result)
          }
  );
}

async function runRemoteIdentityCheck(
  hostAlias: string,
  timeoutMs: number,
  executor: CommandExecutor
): Promise<AccessCheckStep> {
  return runCommandStep(
    "remote-identity",
    "ssh",
    sshReadOnlyArgs(hostAlias, timeoutMs, ["id", "-un"]),
    timeoutMs,
    executor,
    (result) =>
      result.exitCode === 0
        ? {
            status: "passed",
            summary: "Remote identity command succeeded",
            details: remoteIdentityEvidence(result)
          }
        : {
            status: "failed",
            summary: summarizeCommandFailure("ssh id -un", result),
            details: commandEvidence(result)
          }
  );
}

async function runHostKeyCheck(host: string, timeoutMs: number, executor: CommandExecutor): Promise<AccessCheckStep> {
  return runCommandStep("host-key", "ssh-keygen", ["-F", host], timeoutMs, executor, (result) =>
    result.exitCode === 0
      ? {
          status: "passed",
          summary: `Known-host entry exists for ${host}`,
          details: commandEvidence(result)
        }
      : {
          status: "failed",
          summary: summarizeCommandFailure("ssh-keygen -F", result),
          details: commandEvidence(result)
        }
  );
}

function runVpnInference(profile: ComputeProfile, checks: AccessCheckStep[]): AccessCheckStep {
  if (!profile.login.requires_vpn) {
    return {
      name: "vpn",
      status: "passed",
      summary: "Profile does not require VPN according to local profile metadata"
    };
  }

  const networkPassed = checks.some(
    (check) => ["dns", "tcp", "ssh-auth", "remote-identity"].includes(check.name) && check.status === "passed"
  );
  const networkFailed = checks.some(
    (check) => ["dns", "tcp", "ssh-auth", "remote-identity"].includes(check.name) && check.status === "failed"
  );
  if (networkPassed && !networkFailed) {
    return {
      name: "vpn",
      status: "passed",
      summary: "VPN-required profile passed network preflight; VPN-dependent access appears available"
    };
  }
  if (networkFailed) {
    return {
      name: "vpn",
      status: "failed",
      summary: "VPN-required profile failed network preflight; verify the UTS VPN before live operations"
    };
  }
  return {
    name: "vpn",
    status: "skipped",
    summary: "VPN could not be inferred because network checks were skipped"
  };
}

// P4: derive the VPN-down hint for the access result. A VPN drop makes the host UNREACHABLE — it shows up
// as a failed DNS (resolver route gone) or a failed TCP connect (no route to the gateway). Crucially we
// do NOT key off ssh-auth/host-key failing: if TCP connected but auth/host-key failed, the host WAS
// reached, so that is a credential/host-key problem, not a VPN drop (the misclassification the field
// report warns against — a wrong VPN hint sends the operator chasing connectivity instead of the real
// bug). Gated on requires_vpn so non-VPN profiles never get the hint. error_kind is "dns" when the dns
// check is the failure, else "unreachable" (TCP could not reach the host).
function inferNetworkDropHint(
  profile: ComputeProfile,
  checks: AccessCheckStep[]
): { error_kind: "unreachable" | "dns"; network_hint: string } | undefined {
  if (!profile.login.requires_vpn) {
    return undefined;
  }
  const dnsFailed = checks.some((check) => check.name === "dns" && check.status === "failed");
  const tcpFailed = checks.some((check) => check.name === "tcp" && check.status === "failed");
  if (!dnsFailed && !tcpFailed) {
    return undefined;
  }
  return { error_kind: dnsFailed ? "dns" : "unreachable", network_hint: NETWORK_DROP_HINT };
}

async function runCommandStep(
  name: AccessCheckName,
  program: string,
  args: string[],
  timeoutMs: number,
  executor: CommandExecutor,
  interpret: (result: CommandResult) => Omit<AccessCheckStep, "name" | "command" | "duration_ms">
): Promise<AccessCheckStep> {
  assertAllowedAccessCommand(program, args);
  const started = Date.now();
  try {
    const result = await executor(program, args, timeoutMs);
    return {
      name,
      command: { program, args },
      duration_ms: Date.now() - started,
      ...interpret(result)
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      summary: `${program} command failed before producing a result: ${errorMessage(error)}`,
      command: { program, args },
      duration_ms: Date.now() - started
    };
  }
}

function assertAllowedAccessCommand(program: string, args: string[]): void {
  if (program === "ssh-keygen" && args.length === 2 && args[0] === "-F") {
    assertSafeHostName(args[1]);
    return;
  }

  if (program !== "ssh") {
    throw new Error(`access.check only allows ssh helper commands, not ${program}`);
  }
  if (args.length === 2 && args[0] === "-G") {
    assertSafeSshTarget(args[1]);
    return;
  }
  if (args[0] !== "-o" || args[1] !== "BatchMode=yes") {
    throw new Error("access.check ssh commands must use BatchMode=yes");
  }
  if (args[2] !== "-o" || args[3] !== "PasswordAuthentication=no") {
    throw new Error("access.check ssh commands must disable password authentication");
  }
  if (args[4] !== "-o" || args[5] !== "KbdInteractiveAuthentication=no") {
    throw new Error("access.check ssh commands must disable keyboard-interactive authentication");
  }
  if (args[6] !== "-o" || args[7] !== "NumberOfPasswordPrompts=0") {
    throw new Error("access.check ssh commands must disable password prompts");
  }
  if (args[8] !== "-o" || args[9] !== "StrictHostKeyChecking=yes") {
    throw new Error("access.check ssh commands must require strict host-key checking");
  }
  if (args[10] !== "-o" || args[11] !== "UpdateHostKeys=no") {
    throw new Error("access.check ssh commands must not update host keys");
  }
  if (!/^-o$/.test(args[12] ?? "") || !/^ConnectTimeout=[1-9][0-9]*$/.test(args[13] ?? "")) {
    throw new Error("access.check ssh commands must set a numeric ConnectTimeout");
  }
  assertSafeSshTarget(args[14] ?? "");
  const remoteCommand = args.slice(15);
  const allowedRemote = [["true"], ["id", "-un"]];
  if (!allowedRemote.some((allowed) => sameArray(allowed, remoteCommand))) {
    throw new Error(`access.check remote command is not allowlisted: ${remoteCommand.join(" ")}`);
  }
}

function assertSafeHostName(host: string): void {
  if (!host || host.startsWith("-") || !/^[A-Za-z0-9._:+-]+$/.test(host)) {
    throw new Error(`Unsafe host name: ${host}`);
  }
}

// The SSH argv assemblers (sshReadOnlyArgs / sshJobArgs / sshSupervisorArgs) and isSafeRemoteToken
// have moved to lib/ssh.ts and ids.ts respectively and are re-exported at the top of this file. The
// deliberate per-hop host-key split they encode (OUTER=yes for the pre-pinned gateway, INNER=accept-new
// TOFU for discovered compute nodes) is documented at their new home in lib/ssh.ts; the supervisor
// inner-hop argv is pinned by tests/access.test.mjs.

export interface SshOnNodeOptions {
  timeoutMs?: number;
  executor?: CommandExecutor;
}

export interface SshOnNodeResult {
  host_alias: string;
  node: string;
  exit_code: number | null;
  stdout: string;
  stderr: string;
  timed_out: boolean;
}

const GATEWAY_CONNECT_S = 20;
const NODE_CONNECT_S = 15;
const DEFAULT_SSH_ON_NODE_TIMEOUT_MS = 45_000;

/**
 * Run a pre-validated command on an iHPC interactive node via a two-hop SSH:
 *   local → login gateway (hostAlias) → node
 *
 * Takes the gateway host alias directly (not a ComputeProfile) — this is pure transport
 * mechanism with no profile/policy dependency; the caller resolves the alias.
 * Callers are responsible for validating remoteArgs before calling this function.
 * When node === hostAlias the inner hop is omitted (gateway-only).
 */
export async function sshOnNode(
  hostAlias: string,
  node: string,
  remoteArgs: string[],
  options: SshOnNodeOptions = {}
): Promise<SshOnNodeResult> {
  assertSafeSshTarget(node);
  const timeoutMs = options.timeoutMs ?? DEFAULT_SSH_ON_NODE_TIMEOUT_MS;
  const executor = options.executor ?? defaultCommandExecutor;

  const outerArgs = [...sshOuterHopFlags(GATEWAY_CONNECT_S), hostAlias];

  const args =
    node === hostAlias
      ? [...outerArgs, ...remoteArgs]
      : [...outerArgs, "ssh", ...sshNodeHopFlags(NODE_CONNECT_S), node, ...remoteArgs];

  const raw = await executor("ssh", args, timeoutMs);

  return {
    host_alias: hostAlias,
    node,
    exit_code: raw.exitCode,
    stdout: raw.stdout.trim(),
    stderr: raw.stderr.trim(),
    timed_out: Boolean(raw.timedOut)
  };
}

function parseSshConfig(stdout: string, fallbackHost: string): SshConfig {
  const values = new Map<string, string[]>();
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.match(/^([a-zA-Z][a-zA-Z0-9_-]*)\s+(.*)$/);
    if (!match) {
      continue;
    }
    const key = match[1].toLowerCase();
    const value = match[2].trim();
    const bucket = values.get(key) ?? [];
    bucket.push(value);
    values.set(key, bucket);
  }

  const portText = values.get("port")?.[0] ?? "22";
  const port = Number(portText);
  return {
    hostname: values.get("hostname")?.[0] ?? fallbackHost,
    port: Number.isInteger(port) && port > 0 ? port : 22,
    has_user: Boolean(values.get("user")?.[0]),
    identity_file_count: values.get("identityfile")?.length ?? 0
  };
}

function commandEvidence(result: CommandResult): Record<string, unknown> {
  return {
    exit_code: result.exitCode,
    timed_out: Boolean(result.timedOut),
    stdout: redactCommand(result.stdout.trim()),
    stderr: redactCommand(result.stderr.trim())
  };
}

function remoteIdentityEvidence(result: CommandResult): Record<string, unknown> {
  return {
    exit_code: result.exitCode,
    timed_out: Boolean(result.timedOut),
    stdout: result.stdout.trim() ? "<redacted-identity>" : "",
    stderr: redactCommand(result.stderr.trim())
  };
}

function redactSshConfigText(stdout: string): string {
  return stdout
    .split(/\r?\n/)
    .filter((line) => !/^(?:user|identityfile)\s+/i.test(line))
    .join("\n")
    .trim();
}

function summarizeCommandFailure(label: string, result: CommandResult): string {
  return summarizeRemoteFailure(result, {
    timedOut: `${label} timed out`,
    failed: (stderr) => `${label} failed: ${stderr}`,
    exited: (exitCode) => `${label} exited with ${String(exitCode)}`
  });
}

function writeAccessEvidence(result: AccessCheckResult): string {
  const evidenceDir = assertInsideRuntime(EVIDENCE_DIR, "Access evidence directory");
  const safeObservedAt = safeTimestampOf(result.observed_at);
  return writeEvidenceJson(
    evidenceDir,
    `access-${result.profile_id}-${safeObservedAt}.json`,
    result,
    "Access evidence"
  );
}

function overallStatus(checks: AccessCheckStep[]): AccessCheckResult["overall_status"] {
  if (checks.some((check) => check.status === "failed")) {
    return "failed";
  }
  if (checks.some((check) => check.status === "skipped")) {
    return "partial";
  }
  return "passed";
}

function sameArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

// Connectivity-probe executor. Delegates to the shared runProcess transport. The unified primitive
// closes the child's stdin (runProcess calls `child.stdin?.end()`), whereas the historical local
// copy never touched stdin; this is harmless because access only runs BatchMode ssh probes that
// read no input. The exit_code/stdout invariance of access.check + access.doctor across this change
// is pinned by a dedicated stdin-lifecycle regression test (tests/access.test.mjs).
export const defaultCommandExecutor: CommandExecutor = runProcess;

export const defaultTcpCheck: TcpCheck = (host, port, timeoutMs) =>
  new Promise((resolve, reject) => {
    const socket = net.createConnection({ host, port });
    const timer = setTimeout(() => {
      socket.destroy(new Error("TCP check timed out"));
    }, timeoutMs);
    socket.once("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve();
    });
    socket.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
  });
