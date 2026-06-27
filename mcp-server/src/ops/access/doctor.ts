// Live read-only health check across one or all UTS compute profiles. Composes the access.check
// connectivity battery (VPN/DNS/TCP/SSH/host-key/auth/identity) and adds two live probes it lacks:
// remote clock-skew and PBS scheduler reachability. Aggregates an ok/warn/fail report with
// next-step findings. Contacts UTS systems over SSH; makes no changes and writes no evidence.

import {
  checkAccessForProfile,
  defaultCommandExecutor,
  type CommandExecutor,
  type DnsLookup,
  type TcpCheck
} from "../../core/access.js";
import { errorMessage, normalizeTimeout } from "../../lib/shared.js";
import { sshReadOnlyArgs } from "../../lib/ssh.js";
import { getProfile, listProfiles } from "../../core/config.js";
import { PLATFORM } from "../../core/types.js";
import type { AccessCheckResult, ComputeProfile, Platform } from "../../core/types.js";

export interface DoctorOptions {
  profileId?: string;
  timeoutMs?: number;
  configPath?: string;
  executor?: CommandExecutor;
  dnsLookup?: DnsLookup;
  tcpCheck?: TcpCheck;
  now?: Date;
  clockSkewWarnSeconds?: number;
}

type ProbeStatus = "passed" | "warned" | "failed" | "skipped";
type ReportStatus = "ok" | "warn" | "fail";

export interface DoctorProbe {
  name: string;
  status: ProbeStatus;
  summary: string;
}

export interface DoctorProfileReport {
  profile_id: string;
  platform: Platform;
  status: ReportStatus;
  access_overall: AccessCheckResult["overall_status"];
  probes: DoctorProbe[];
  findings: string[];
}

export interface DoctorResult {
  mode: "read-only";
  checked_at: string;
  overall: ReportStatus;
  profile_count: number;
  profiles: DoctorProfileReport[];
}

// Timeout policy: doctor composes access.check, so it mirrors access's connectivity-probe window
// (low 5s default, shared 30s cap) deliberately — keep these in lock-step with access.ts's consts.
const DEFAULT_TIMEOUT_MS = 5000;
const MAX_TIMEOUT_MS = 30000;
const DEFAULT_CLOCK_SKEW_WARN_SECONDS = 120;

export async function runDoctor(options: DoctorOptions = {}): Promise<DoctorResult> {
  const profiles = options.profileId
    ? [getProfile(options.profileId, options.configPath)]
    : listProfiles(options.configPath);
  const checkedAt = (options.now ?? new Date()).toISOString();

  const reports: DoctorProfileReport[] = [];
  for (const profile of profiles) {
    try {
      reports.push(await doctorForProfile(profile, options));
    } catch (error) {
      // One unhealthy/misconfigured profile must not abort the whole sweep.
      reports.push({
        profile_id: profile.profile_id,
        platform: profile.platform,
        status: "fail",
        access_overall: "failed",
        probes: [],
        findings: [`Doctor could not complete for this profile: ${errorMessage(error)}`]
      });
    }
  }

  return {
    mode: "read-only",
    checked_at: checkedAt,
    overall: rollupOverall(reports.map((report) => report.status)),
    profile_count: reports.length,
    profiles: reports
  };
}

async function doctorForProfile(profile: ComputeProfile, options: DoctorOptions): Promise<DoctorProfileReport> {
  const timeoutMs = normalizeTimeout(options.timeoutMs, { default: DEFAULT_TIMEOUT_MS, max: MAX_TIMEOUT_MS });
  const executor = options.executor ?? defaultCommandExecutor;
  const probes: DoctorProbe[] = [];
  const findings: string[] = [];

  // 1. Connectivity battery — reuse access.check (already redacted; no evidence file here).
  const access = await checkAccessForProfile(profile, {
    timeoutMs,
    executor,
    dnsLookup: options.dnsLookup,
    tcpCheck: options.tcpCheck,
    now: options.now,
    writeEvidence: false
  });
  for (const check of access.checks) {
    probes.push({ name: `access:${check.name}`, status: accessStatusToProbe(check.status), summary: check.summary });
  }
  if (access.overall_status === "failed") {
    findings.push("Connectivity preflight failed; verify the UTS VPN/SSH before live operations (run access.check for detail).");
  }
  // P4: when access.check inferred a VPN-down network drop, surface its actionable hint verbatim so the
  // operator gets the one clear next step (connect the VPN / access.doctor --export-ssh) in the doctor
  // report, not just buried in the access result.
  if (access.network_hint) {
    findings.push(access.network_hint);
  }
  const sshAuthOk = access.checks.some((check) => check.name === "ssh-auth" && check.status === "passed");

  // 2. Clock skew (remote date vs local) — needs working SSH auth.
  probes.push(
    sshAuthOk
      ? await clockSkewProbe(profile, timeoutMs, executor, options)
      : { name: "clock-skew", status: "skipped", summary: "Clock-skew skipped because SSH auth did not pass" }
  );

  // 3. Scheduler reachability — PBS only; iHPC has no batch scheduler.
  if (profile.platform === PLATFORM.HPC) {
    probes.push(
      sshAuthOk
        ? await schedulerProbe(profile, timeoutMs, executor)
        : { name: "scheduler", status: "skipped", summary: "Scheduler probe skipped because SSH auth did not pass" }
    );
  } else {
    probes.push({ name: "scheduler", status: "skipped", summary: "iHPC uses interactive supervised runs, not a batch scheduler" });
  }

  for (const probe of probes) {
    if (probe.status === "warned") {
      findings.push(probe.summary);
    } else if (probe.status === "failed" && !probe.name.startsWith("access:")) {
      findings.push(probe.summary);
    }
  }

  return {
    profile_id: profile.profile_id,
    platform: profile.platform,
    status: rollupProfileStatus(access.overall_status, probes),
    access_overall: access.overall_status,
    probes,
    findings
  };
}

async function clockSkewProbe(
  profile: ComputeProfile,
  timeoutMs: number,
  executor: CommandExecutor,
  options: DoctorOptions
): Promise<DoctorProbe> {
  const warnSeconds = options.clockSkewWarnSeconds ?? DEFAULT_CLOCK_SKEW_WARN_SECONDS;
  const localEpoch = Math.floor((options.now ?? new Date()).getTime() / 1000);
  try {
    const result = await executor("ssh", sshReadOnlyArgs(profile.login.host_alias, timeoutMs, ["date", "+%s"]), timeoutMs);
    const remoteEpoch = Number.parseInt(result.stdout.trim(), 10);
    if (result.exitCode !== 0 || !Number.isFinite(remoteEpoch)) {
      return { name: "clock-skew", status: "failed", summary: "Could not read the remote clock (ssh date failed)" };
    }
    const skew = Math.abs(remoteEpoch - localEpoch);
    return skew > warnSeconds
      ? { name: "clock-skew", status: "warned", summary: `Remote clock differs from local by ~${skew}s (> ${warnSeconds}s); check timezone/NTP` }
      : { name: "clock-skew", status: "passed", summary: `Remote clock within ${skew}s of local` };
  } catch (error) {
    return { name: "clock-skew", status: "failed", summary: `Clock-skew probe failed: ${errorMessage(error)}` };
  }
}

async function schedulerProbe(profile: ComputeProfile, timeoutMs: number, executor: CommandExecutor): Promise<DoctorProbe> {
  try {
    const result = await executor("ssh", sshReadOnlyArgs(profile.login.host_alias, timeoutMs, ["qstat", "-B"]), timeoutMs);
    return result.exitCode === 0
      ? { name: "scheduler", status: "passed", summary: "PBS server reachable (qstat -B succeeded)" }
      : { name: "scheduler", status: "failed", summary: "PBS server did not respond to qstat -B" };
  } catch (error) {
    return { name: "scheduler", status: "failed", summary: `Scheduler probe failed: ${errorMessage(error)}` };
  }
}

function accessStatusToProbe(status: "passed" | "failed" | "skipped"): ProbeStatus {
  return status;
}

function rollupProfileStatus(accessOverall: AccessCheckResult["overall_status"], probes: DoctorProbe[]): ReportStatus {
  const extra = probes.filter((probe) => !probe.name.startsWith("access:"));
  if (accessOverall === "failed" || extra.some((probe) => probe.status === "failed")) {
    return "fail";
  }
  if (accessOverall === "partial" || extra.some((probe) => probe.status === "warned")) {
    return "warn";
  }
  return "ok";
}

function rollupOverall(statuses: ReportStatus[]): ReportStatus {
  if (statuses.includes("fail")) {
    return "fail";
  }
  if (statuses.includes("warn")) {
    return "warn";
  }
  return "ok";
}
