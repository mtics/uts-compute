import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { hpcProfile, runtimeRoot } from "../helpers/index.mjs";

function fakeExecutor(calls, sshAuthExitCode = 0) {
  return async (program, args) => {
    calls.push({ program, args });

    if (program === "ssh" && args[0] === "-G") {
      return {
        exitCode: 0,
        stdout: "hostname hpc.research.uts.edu.au\nuser abc123\nport 22\nidentityfile ~/.ssh/id_ed25519\n",
        stderr: ""
      };
    }
    if (program === "ssh-keygen" && args[0] === "-F") {
      return { exitCode: 0, stdout: "# Host hpc.research.uts.edu.au found\n", stderr: "" };
    }
    if (args.at(-1) === "true") {
      return { exitCode: sshAuthExitCode, stdout: "", stderr: sshAuthExitCode === 0 ? "" : "Permission denied" };
    }
    if (args.at(-2) === "id" && args.at(-1) === "-un") {
      return { exitCode: 0, stdout: "abc123\n", stderr: "" };
    }

    throw new Error(`Unexpected command: ${program} ${args.join(" ")}`);
  };
}

test("access.check resolves only the host part of a user@host alias for DNS (no false-negative)", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");
  const profile = { ...hpcProfile, login: { ...hpcProfile.login, host_alias: "u00000004@hpc-host01" } };
  let dnsHost;
  await checkAccessForProfile(profile, {
    executor: fakeExecutor([]),
    dnsLookup: async (host) => {
      dnsHost = host;
      return { address: "10.0.0.1", family: 4 };
    },
    tcpCheck: async () => {},
    writeEvidence: false,
    checks: ["dns"]
  });
  // DNS must receive the HOST part only — resolving `user@host` verbatim fails ENOTFOUND and falsely
  // reds overall_status even when SSH itself works.
  assert.equal(dnsHost, "hpc-host01");
});

test("access.check runs read-only preflight with mocked DNS, TCP, and SSH evidence", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");
  const calls = [];

  const result = await checkAccessForProfile(hpcProfile, {
    executor: fakeExecutor(calls),
    dnsLookup: async (host) => {
      assert.equal(host, "hpc.research.uts.edu.au");
      return { address: "10.0.0.1", family: 4 };
    },
    tcpCheck: async (host, port) => {
      assert.equal(host, "hpc.research.uts.edu.au");
      assert.equal(port, 22);
    },
    now: new Date("2026-06-15T00:00:00.000Z")
  });

  assert.equal(result.mode, "read-only");
  assert.equal(result.profile_id, "uts-hpc-account-a");
  assert.equal(result.resolved_host, "hpc.research.uts.edu.au");
  assert.equal(result.port, 22);
  assert.equal(result.overall_status, "passed");
  assert.deepEqual(
    result.checks.map((check) => `${check.name}:${check.status}`),
    [
      "profile:passed",
      "ssh-config:passed",
      "dns:passed",
      "tcp:passed",
      "host-key:passed",
      "ssh-auth:passed",
      "remote-identity:passed",
      "vpn:passed"
    ]
  );
  assert.equal(result.checks.find((check) => check.name === "profile").status, "passed");
  assert.equal(result.checks.every((check) => check.observed_at === "2026-06-15T00:00:00.000Z"), true);
  assert.ok(result.evidence_path.startsWith(path.join(runtimeRoot, "access")));
  assert.equal(fs.existsSync(result.evidence_path), true);
  const evidenceText = fs.readFileSync(result.evidence_path, "utf8");
  assert.doesNotMatch(evidenceText, /~\/\.ssh\/id_ed25519/);
  assert.doesNotMatch(evidenceText, /abc123/);
  assert.match(evidenceText, /<redacted-identity>/);
  assert.equal(calls.every((call) => ["ssh", "ssh-keygen"].includes(call.program)), true);
});

test("access.check rejects unsafe ssh host aliases before command execution", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");
  const calls = [];
  const unsafeProfile = {
    ...hpcProfile,
    login: {
      ...hpcProfile.login,
      host_alias: "-oProxyCommand=sh"
    }
  };

  await assert.rejects(
    () =>
      checkAccessForProfile(unsafeProfile, {
        executor: fakeExecutor(calls),
        writeEvidence: false
      }),
    /Unsafe SSH host alias/
  );
  assert.equal(calls.length, 0);
});

test("access.check fails unknown profile before any probe", async () => {
  const { checkAccess } = await import("../../dist/core/access.js");
  const calls = [];

  await assert.rejects(
    () =>
      checkAccess("missing-profile", {
        executor: fakeExecutor(calls),
        writeEvidence: false
      }),
    /Unknown profile_id/
  );
  assert.equal(calls.length, 0);
});

test("access.check skips remote identity when batch SSH auth fails", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");
  const calls = [];

  const result = await checkAccessForProfile(hpcProfile, {
    executor: fakeExecutor(calls, 255),
    dnsLookup: async () => ({ address: "10.0.0.1", family: 4 }),
    tcpCheck: async () => {},
    writeEvidence: false
  });

  assert.equal(result.overall_status, "failed");
  assert.equal(result.checks.find((check) => check.name === "ssh-auth").status, "failed");
  assert.equal(result.checks.find((check) => check.name === "remote-identity").status, "skipped");
  assert.equal(calls.some((call) => call.args.at(-2) === "id" && call.args.at(-1) === "-un"), false);
});

test("access.check short-circuits network-dependent probes after DNS failure", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");
  const calls = [];

  const result = await checkAccessForProfile(hpcProfile, {
    executor: fakeExecutor(calls),
    dnsLookup: async () => {
      throw new Error("VPN DNS unavailable");
    },
    tcpCheck: async () => {
      throw new Error("TCP should not run");
    },
    writeEvidence: false
  });

  assert.equal(result.overall_status, "failed");
  assert.equal(result.checks.find((check) => check.name === "dns").status, "failed");
  assert.equal(result.checks.find((check) => check.name === "tcp").status, "skipped");
  assert.equal(result.checks.find((check) => check.name === "host-key").status, "skipped");
  assert.equal(result.checks.find((check) => check.name === "ssh-auth").status, "skipped");
  assert.equal(calls.some((call) => call.program === "ssh-keygen"), false);
});

// P4: when a VPN-required profile fails network preflight, access.check surfaces an actionable
// network_hint (VPN-down + the access.doctor --export-ssh manual fallback) and error_kind so an agent
// doesn't have to decode a pile of red checks. A reachable-but-rejected failure (auth) must NOT get one.
test("access.check surfaces a network_hint when a VPN-required profile fails network preflight", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");
  const { NETWORK_DROP_HINT } = await import("../../dist/lib/net-errors.js");

  const result = await checkAccessForProfile(hpcProfile, {
    executor: fakeExecutor([]),
    dnsLookup: async () => {
      throw new Error("getaddrinfo ENOTFOUND hpc.research.uts.edu.au");
    },
    tcpCheck: async () => {},
    writeEvidence: false
  });

  assert.equal(result.overall_status, "failed");
  assert.equal(result.requires_vpn, true);
  assert.equal(result.network_hint, NETWORK_DROP_HINT);
  assert.equal(result.error_kind, "dns");
});

test("access.check omits the network_hint when SSH auth fails (host reachable, not a VPN drop)", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");

  const result = await checkAccessForProfile(hpcProfile, {
    executor: fakeExecutor([], 255), // ssh true -> Permission denied
    dnsLookup: async () => ({ address: "10.0.0.1", family: 4 }),
    tcpCheck: async () => {},
    writeEvidence: false
  });

  assert.equal(result.overall_status, "failed");
  assert.equal(result.network_hint, undefined);
  assert.equal(result.error_kind, undefined);
});

test("access.check sets no network_hint on a fully healthy profile", async () => {
  const { checkAccessForProfile } = await import("../../dist/core/access.js");

  const result = await checkAccessForProfile(hpcProfile, {
    executor: fakeExecutor([]),
    dnsLookup: async () => ({ address: "10.0.0.1", family: 4 }),
    tcpCheck: async () => {},
    writeEvidence: false
  });

  assert.equal(result.overall_status, "passed");
  assert.equal(result.network_hint, undefined);
  assert.equal(result.error_kind, undefined);
});

// --- Regression: real defaultCommandExecutor stdin-lifecycle invariance (Step 3 / dedup) ---
//
// Step 3 routes access's connectivity-probe executor through the unified lib/process.runProcess,
// which closes the child's stdin (`child.stdin?.end()`). The historical access executor NEVER
// touched stdin. These tests exercise the REAL (unmocked) defaultCommandExecutor against a real
// `ssh`/`ssh-keygen` shim that — exactly like BatchMode ssh — reads no stdin, and assert the
// exit_code/stdout it produces are unchanged by the added stdin close. If the close ever broke a
// no-stdin probe (e.g. EPIPE killing the child), exit_code would flip to null here.

function writeFakeBin(dir) {
  // `ssh` shim: dispatches on -G / remote command exactly like the mocked fakeExecutor above.
  const sshShim = `#!/usr/bin/env node
const a = process.argv.slice(2);
function out(s) { process.stdout.write(s); }
function err(s) { process.stderr.write(s); }
if (a[0] === "-G") {
  out("hostname hpc.research.uts.edu.au\\nuser abc123\\nport 22\\nidentityfile ~/.ssh/id_ed25519\\n");
  process.exit(0);
}
const remote = a.join(" ");
if (remote.endsWith(" true")) { process.exit(0); }
if (remote.endsWith(" id -un")) { out("abc123\\n"); process.exit(0); }
if (remote.includes(" date +%s")) { out(String(Math.floor(Date.now() / 1000)) + "\\n"); process.exit(0); }
if (remote.includes(" qstat -B")) { out("Server up\\n"); process.exit(0); }
err("unexpected ssh remote: " + remote + "\\n");
process.exit(7);
`;
  const keygenShim = `#!/usr/bin/env node
const a = process.argv.slice(2);
if (a[0] === "-F") { process.stdout.write("# Host hpc.research.uts.edu.au found\\n"); process.exit(0); }
process.stderr.write("unexpected ssh-keygen\\n");
process.exit(7);
`;
  const sshPath = path.join(dir, "ssh");
  const keygenPath = path.join(dir, "ssh-keygen");
  fs.writeFileSync(sshPath, sshShim, { mode: 0o755 });
  fs.writeFileSync(keygenPath, keygenShim, { mode: 0o755 });
}

test("Step 3: real defaultCommandExecutor closes no-stdin child without changing exit_code/stdout", async () => {
  const { defaultCommandExecutor } = await import("../../dist/core/access.js");
  // A command that reads nothing from stdin — the BatchMode-ssh shape access relies on. The
  // unified runProcess now calls child.stdin?.end(); this must not corrupt exit_code/stdout.
  const result = await defaultCommandExecutor(
    process.execPath,
    ["-e", "process.stdout.write('ready\\n'); process.exit(0)"],
    5000
  );
  assert.equal(result.exitCode, 0);
  assert.equal(result.stdout, "ready\n");
  assert.equal(result.stderr, "");
  assert.equal(Boolean(result.timedOut), false);
});

test("Step 3: real defaultCommandExecutor still SIGTERMs on timeout and flags timed_out", async () => {
  const { defaultCommandExecutor } = await import("../../dist/core/access.js");
  const result = await defaultCommandExecutor(
    process.execPath,
    ["-e", "setTimeout(() => {}, 10000)"],
    150
  );
  assert.equal(result.timedOut, true);
  assert.equal(result.exitCode, null);
});

test("Step 3: access.check + access.doctor produce unchanged evidence with the REAL executor over no-stdin ssh probes", async () => {
  const { checkAccessForProfile, defaultCommandExecutor } = await import("../../dist/core/access.js");
  const { runDoctor } = await import("../../dist/ops/access/doctor.js");

  const binDir = fs.mkdtempSync(path.join(os.tmpdir(), "uts-fakebin-"));
  writeFakeBin(binDir);
  const savedPath = process.env.PATH;
  process.env.PATH = `${binDir}${path.delimiter}${savedPath}`;
  const now = new Date("2026-06-15T00:00:00.000Z");

  try {
    // access.check end-to-end through the REAL executor (spawns the ssh/ssh-keygen shims).
    const access = await checkAccessForProfile(hpcProfile, {
      executor: defaultCommandExecutor,
      dnsLookup: async () => ({ address: "10.0.0.1", family: 4 }),
      tcpCheck: async () => {},
      writeEvidence: false,
      now
    });

    assert.equal(access.mode, "read-only");
    assert.equal(access.overall_status, "passed");

    // ssh-config (`ssh -G`) — passed branch records the parsed config + redacted stdout.
    const sshConfig = access.checks.find((c) => c.name === "ssh-config");
    assert.equal(sshConfig.status, "passed");
    assert.equal(sshConfig.details.ssh_config.hostname, "hpc.research.uts.edu.au");

    // host-key (`ssh-keygen -F`) — commandEvidence with exit_code 0 from the no-stdin child.
    const hostKey = access.checks.find((c) => c.name === "host-key");
    assert.equal(hostKey.status, "passed");
    assert.equal(hostKey.details.exit_code, 0);
    assert.equal(hostKey.details.timed_out, false);

    // ssh-auth (`ssh ... true`) — BatchMode ssh reads no stdin; exit_code/stdout must be unchanged.
    const sshAuth = access.checks.find((c) => c.name === "ssh-auth");
    assert.equal(sshAuth.status, "passed");
    assert.equal(sshAuth.details.exit_code, 0);
    assert.equal(sshAuth.details.stdout, "");
    assert.equal(sshAuth.details.timed_out, false);

    // remote-identity (`ssh ... id -un`) — exit_code 0; stdout is redacted to a fixed marker.
    const identity = access.checks.find((c) => c.name === "remote-identity");
    assert.equal(identity.status, "passed");
    assert.equal(identity.details.exit_code, 0);
    assert.equal(identity.details.stdout, "<redacted-identity>");

    // access.doctor adds live clock-skew + scheduler probes — also no-stdin ssh spawns.
    const doctor = await runDoctor({
      profileId: "uts-hpc-account-a",
      executor: defaultCommandExecutor,
      dnsLookup: async () => ({ address: "10.0.0.1", family: 4 }),
      tcpCheck: async () => {},
      now
    });

    const profileReport = doctor.profiles.find((p) => p.profile_id === "uts-hpc-account-a");
    assert.ok(profileReport, "doctor report includes the hpc profile");
    const scheduler = profileReport.probes.find((p) => p.name === "scheduler");
    assert.equal(scheduler.status, "passed");
  } finally {
    process.env.PATH = savedPath;
    fs.rmSync(binDir, { recursive: true, force: true });
  }
});

test("access normalizeTimeout enforces the per-module 5000 default and 30000 cap", async () => {
  // normalizeTimeout(timeoutMs, {default, max}) lives in lib/shared (the P3 migration retired the
  // core/access re-export facade); the access connectivity-probe policy (5000 default / 30000 cap) is
  // passed by access's own call sites. This pins that the access bounds behave as expected.
  const { normalizeTimeout } = await import("../../dist/lib/shared.js");
  const accessBounds = { default: 5000, max: 30000 };

  // Default is the connectivity-probe value (5000), NOT the 10000 used by the middle modules.
  assert.equal(normalizeTimeout(undefined, accessBounds), 5000);

  // Accepts values inside [1000, 30000].
  assert.equal(normalizeTimeout(1000, accessBounds), 1000);
  assert.equal(normalizeTimeout(30000, accessBounds), 30000);

  // Rejects anything above the 30s cap (the bound that must NOT be widened to transfer's 600000).
  assert.throws(() => normalizeTimeout(30001, accessBounds), /timeoutMs must be an integer between 1000 and 30000/);
  assert.throws(() => normalizeTimeout(600000, accessBounds), /timeoutMs must be an integer between 1000 and 30000/);
  assert.throws(() => normalizeTimeout(999, accessBounds), /timeoutMs must be an integer between 1000 and 30000/);
  assert.throws(() => normalizeTimeout(1500.5, accessBounds), /timeoutMs must be an integer between 1000 and 30000/);
});

// ---------------------------------------------------------------------------------------------------
// Supervisor two-hop SSH host-key policy. Before this pin existed the gateway->node INNER hop carried
// NO StrictHostKeyChecking option at all (it inherited ssh's interactive default — a silent, untested
// gap), while sshOnNode's inner hop already used accept-new. This test pins the deliberate policy:
//   - OUTER hop (local -> gateway): StrictHostKeyChecking=yes (the gateway alias is pre-pinned).
//   - INNER hop (gateway -> node):  StrictHostKeyChecking=accept-new (nodes are discovered, TOFU).
// Without this assertion the inner-hop hardening drift is invisible to CI.
// ---------------------------------------------------------------------------------------------------
test("sshSupervisorArgs hardens the gateway->node inner hop with StrictHostKeyChecking=accept-new", async () => {
  // sshSupervisorArgs lives in lib/ssh (the P3 migration retired the core/access re-export facade).
  const { sshSupervisorArgs } = await import("../../dist/lib/ssh.js");
  const spec = "eyJraW5kIjoic3VwZXJ2aXNvciJ9"; // base64url-safe (matches the argv-encoding guard)
  const args = sshSupervisorArgs("uts-ihpc-access", "mars001", 10000, spec);

  // Locate the inner ssh: the first "ssh" token AFTER the gateway alias (the gateway alias terminates
  // the outer hop's options block). Everything before it is the outer hop, everything after is inner.
  const gatewayIndex = args.indexOf("uts-ihpc-access");
  assert.ok(gatewayIndex >= 0, "gateway host alias must appear in the argv");
  const innerSshIndex = args.indexOf("ssh", gatewayIndex + 1);
  assert.ok(innerSshIndex > gatewayIndex, "an inner ssh hop must follow the gateway alias");

  const outerHop = args.slice(0, innerSshIndex);
  const innerHop = args.slice(innerSshIndex);

  // OUTER hop: strict, exactly =yes (the pre-pinned gateway), never accept-new.
  assert.ok(
    outerHop.includes("StrictHostKeyChecking=yes"),
    "outer hop (local->gateway) must keep StrictHostKeyChecking=yes"
  );
  assert.equal(
    outerHop.includes("StrictHostKeyChecking=accept-new"),
    false,
    "outer hop must NOT relax to accept-new"
  );

  // INNER hop: must carry accept-new, passed as a paired -o option immediately before the node, and
  // must NOT be unset (the prior drift) nor =yes (which breaks first contact to discovered nodes).
  const innerHostKeyIndex = innerHop.indexOf("StrictHostKeyChecking=accept-new");
  assert.ok(innerHostKeyIndex > 0, "inner hop (gateway->node) must set StrictHostKeyChecking=accept-new");
  assert.equal(innerHop[innerHostKeyIndex - 1], "-o", "the inner host-key policy must be a paired -o option");
  assert.equal(
    innerHop.includes("StrictHostKeyChecking=yes"),
    false,
    "inner hop must NOT use =yes (would break TOFU first contact to discovered nodes)"
  );

  // The hardening sits between the inner ssh and the node, and the remote shape is unchanged.
  const nodeIndex = innerHop.indexOf("mars001");
  assert.ok(nodeIndex > innerHostKeyIndex, "the node must follow the inner host-key option");
  assert.deepEqual(innerHop.slice(nodeIndex), ["mars001", "python3", "-", spec]);
  assert.equal(args.at(-4), "mars001");
  assert.equal(args.at(-3), "python3");
  assert.equal(args.at(-2), "-");
  assert.equal(args.at(-1), spec);
});
