import assert from "node:assert/strict";
import test from "node:test";
import { runDoctor } from "../../dist/ops/access/doctor.js";

const NOW = new Date("2026-06-15T00:00:00.000Z");
const LOCAL_EPOCH = Math.floor(NOW.getTime() / 1000);

// Mock command executor that satisfies the access.check battery and the doctor's extra probes.
// remoteClockEpoch lets a test inject clock skew; schedulerExit lets a test fail the PBS probe.
function makeExecutor({ remoteClockEpoch = LOCAL_EPOCH, schedulerExit = 0 } = {}) {
  return async (program, args) => {
    if (program === "ssh-keygen") {
      return { exitCode: 0, stdout: "# Host found in known_hosts", stderr: "" };
    }
    if (program !== "ssh") {
      return { exitCode: 1, stdout: "", stderr: `unexpected program ${program}` };
    }
    if (args[0] === "-G") {
      return { exitCode: 0, stdout: "hostname login.example.uts.edu.au\nport 22\nuser someone\nidentityfile ~/.ssh/id\n", stderr: "" };
    }
    const remote = args.join(" ");
    if (remote.includes(" date +%s")) {
      return { exitCode: 0, stdout: `${remoteClockEpoch}\n`, stderr: "" };
    }
    if (remote.includes(" qstat -B")) {
      return { exitCode: schedulerExit, stdout: schedulerExit === 0 ? "Server up" : "", stderr: schedulerExit === 0 ? "" : "qstat: cannot connect" };
    }
    if (remote.endsWith(" id -un")) {
      return { exitCode: 0, stdout: "someone\n", stderr: "" };
    }
    if (remote.endsWith(" true")) {
      return { exitCode: 0, stdout: "", stderr: "" };
    }
    return { exitCode: 1, stdout: "", stderr: `unexpected ssh remote command: ${remote}` };
  };
}

const dnsLookup = async () => ({ address: "10.1.2.3", family: 4 });
const tcpCheck = async () => {};

function baseOptions(overrides = {}) {
  return {
    now: NOW,
    timeoutMs: 5000,
    dnsLookup,
    tcpCheck,
    executor: makeExecutor(),
    ...overrides
  };
}

test("access.doctor reports ok for a healthy uts-hpc profile (connectivity + clock-skew + scheduler)", async () => {
  const result = await runDoctor(baseOptions({ profileId: "uts-hpc-account-a" }));

  assert.equal(result.mode, "read-only");
  assert.equal(result.checked_at, NOW.toISOString());
  assert.equal(result.profile_count, 1);
  assert.equal(result.overall, "ok");

  const report = result.profiles[0];
  assert.equal(report.profile_id, "uts-hpc-account-a");
  assert.equal(report.platform, "uts-hpc");
  assert.equal(report.status, "ok");
  assert.equal(report.access_overall, "passed");

  const clock = report.probes.find((probe) => probe.name === "clock-skew");
  assert.equal(clock.status, "passed");
  const scheduler = report.probes.find((probe) => probe.name === "scheduler");
  assert.equal(scheduler.status, "passed");
});

test("access.doctor warns on clock skew beyond the threshold", async () => {
  const result = await runDoctor(
    baseOptions({ profileId: "uts-hpc-account-a", executor: makeExecutor({ remoteClockEpoch: LOCAL_EPOCH + 600 }) })
  );
  const report = result.profiles[0];
  assert.equal(report.status, "warn");
  assert.equal(result.overall, "warn");
  const clock = report.probes.find((probe) => probe.name === "clock-skew");
  assert.equal(clock.status, "warned");
  assert.match(report.findings.join(" "), /clock differs/i);
});

test("access.doctor fails the profile when the PBS scheduler is unreachable", async () => {
  const result = await runDoctor(
    baseOptions({ profileId: "uts-hpc-account-a", executor: makeExecutor({ schedulerExit: 1 }) })
  );
  const report = result.profiles[0];
  assert.equal(report.status, "fail");
  assert.equal(result.overall, "fail");
  assert.equal(report.probes.find((probe) => probe.name === "scheduler").status, "failed");
});

test("access.doctor skips the scheduler probe for iHPC (no batch scheduler)", async () => {
  const result = await runDoctor(baseOptions({ profileId: "uts-ihpc-account-a" }));
  const report = result.profiles[0];
  assert.equal(report.platform, "uts-ihpc");
  assert.equal(report.status, "ok");
  const scheduler = report.probes.find((probe) => probe.name === "scheduler");
  assert.equal(scheduler.status, "skipped");
  // clock-skew still runs on iHPC
  assert.equal(report.probes.find((probe) => probe.name === "clock-skew").status, "passed");
});

test("access.doctor surfaces the VPN-down network_hint when a VPN-required profile is unreachable", async () => {
  const { NETWORK_DROP_HINT } = await import("../../dist/lib/net-errors.js");
  // VPN down: DNS resolution throws, so the whole connectivity battery reds for a VPN-required profile.
  const result = await runDoctor(
    baseOptions({
      profileId: "uts-hpc-account-a",
      dnsLookup: async () => {
        throw new Error("getaddrinfo ENOTFOUND hpc.research.uts.edu.au");
      },
      tcpCheck: async () => {
        throw new Error("TCP should not run");
      }
    })
  );
  const report = result.profiles[0];
  assert.equal(report.status, "fail");
  assert.equal(result.overall, "fail");
  // The actionable VPN hint shows up in the profile's findings so the operator gets one clear next step.
  assert.ok(
    report.findings.some((finding) => finding === NETWORK_DROP_HINT),
    `expected findings to include the VPN-down hint, got: ${JSON.stringify(report.findings)}`
  );
});

test("access.doctor fans across all configured profiles when no profileId is given", async () => {
  const result = await runDoctor(baseOptions());
  assert.equal(result.profile_count, 4);
  assert.equal(result.overall, "ok");
  assert.deepEqual(
    result.profiles.map((report) => report.profile_id).sort(),
    ["uts-hpc-account-a", "uts-hpc-account-b", "uts-ihpc-account-a", "uts-ihpc-account-b"]
  );
});
