import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { hpcProfile, runtimeRoot } from "../helpers/index.mjs";

const ihpcProfile = {
  ...hpcProfile,
  profile_id: "uts-ihpc-account-a",
  platform: "uts-ihpc",
  login: {
    host_alias: "uts-ihpc-access",
    username_ref: "UTS_IHPC_ACCOUNT_A_USER",
    ssh_agent: true,
    requires_vpn: true
  },
  defaults: {
    node_family: "mars",
    workspace: "/data/${USER}/experiments",
    scratch: "/scratch/${USER}"
  }
};

function fakeHpcExecutor(calls) {
  return async (program, args) => {
    calls.push({ program, args });
    const remote = args.slice(args.indexOf("uts-hpc") + 1);

    if (remote.length === 1 && remote[0] === "whoami") {
      return { exitCode: 0, stdout: "abc123\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "id") {
      return { exitCode: 0, stdout: "uid=1000(abc123) gid=1000(research)\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "groups") {
      return { exitCode: 0, stdout: "research hpcusers\n", stderr: "" };
    }
    if (remote.length === 2 && remote[0] === "qstat" && remote[1] === "-Q") {
      return {
        exitCode: 0,
        stdout: "Queue Max Memory Max Time Queued Run\n----- ---------- -------- ------ ---\nworkq -- -- 0 1\nsmallq 32gb 08:00:00 0 0\n",
        stderr: ""
      };
    }
    if (remote.length === 2 && remote[0] === "qstat" && remote[1] === "-Qf") {
      return { exitCode: 0, stdout: "Queue: workq\n    resources_max.walltime = 200:00:00\n", stderr: "" };
    }
    if (remote.length === 3 && remote[0] === "qstat" && remote[1] === "-u") {
      return {
        exitCode: 0,
        stdout: "1234.hpc somejob abc123 00:01:00 R workq\n5678.hpc other abc123 00:00:00 Q smallq\n",
        stderr: ""
      };
    }
    if (remote.length === 4 && remote.join(" ") === "pbsnodes -F json -a") {
      return {
        exitCode: 0,
        stdout: JSON.stringify({
          nodes: {
            node001: { state: "free" },
            node002: { state: "job-busy" }
          }
        }),
        stderr: ""
      };
    }
    if (remote.length === 2 && remote.join(" ") === "quota -s") {
      return { exitCode: 0, stdout: "Disk quotas for user abc123\n", stderr: "" };
    }
    if (remote.length === 3 && remote[0] === "df" && remote[1] === "-hP") {
      return { exitCode: 0, stdout: `Filesystem Size Used Avail Use% Mounted on\nstorage 1T 10G 990G 1% ${remote[2]}\n`, stderr: "" };
    }

    throw new Error(`Unexpected command: ${program} ${args.join(" ")}`);
  };
}

function fakeIhpcExecutor(calls) {
  return async (program, args) => {
    calls.push({ program, args });
    const remote = args.slice(args.indexOf("uts-ihpc-access") + 1);

    if (remote.length === 1 && remote[0] === "whoami") {
      return { exitCode: 0, stdout: "zid987\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "id") {
      return { exitCode: 0, stdout: "uid=2000(zid987) gid=2000(research)\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "groups") {
      return { exitCode: 0, stdout: "research ihpc gpuuser\n", stderr: "" };
    }
    if (remote.length === 2 && remote.join(" ") === "cnode avail") {
      return { exitCode: 0, stdout: "mars001 free\nmercury002 busy\nvenus003 free\n", stderr: "" };
    }
    if (remote.length === 2 && remote.join(" ") === "cnode all") {
      return { exitCode: 0, stdout: "mars001\nmercury002\nvenus003\njupiter001\n", stderr: "" };
    }
    if (remote.length === 2 && remote.join(" ") === "cnode mynodes") {
      return { exitCode: 0, stdout: "mars001 running\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "sessiontime") {
      return { exitCode: 0, stdout: "Remaining session time: 01:30:00\n", stderr: "" };
    }
    if (remote.length === 1 && remote[0] === "projvolu") {
      return { exitCode: 0, stdout: "project volume for zid987: 10G used\n", stderr: "" };
    }
    if (remote.length === 3 && remote[0] === "df" && remote[1] === "-hP") {
      return { exitCode: 0, stdout: `Filesystem Size Used Avail Use% Mounted on\nstorage 1T 10G 990G 1% ${remote[2]}\n`, stderr: "" };
    }
    if (remote.length === 4 && remote[0] === "du" && remote[1] === "-s" && remote[2] === "-h") {
      return { exitCode: 0, stdout: `10G\t${remote[3]}\n`, stderr: "" };
    }

    throw new Error(`Unexpected command: ${program} ${args.join(" ")}`);
  };
}

test("quotas.refresh surfaces a network_hint + error_kind when every SSH probe is VPN-down", async () => {
  const { refreshHpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const { NETWORK_DROP_HINT } = await import("../../dist/lib/net-errors.js");

  // VPN dropped: every ssh probe fails with the connect-timeout banner (exit 255). The snapshot is still
  // produced (each command is recorded as failed) but the operator now gets one clear next step.
  const vpnDown = async () => ({
    exitCode: 255,
    stdout: "",
    stderr: "ssh: connect to host hpc-host01 port 22: Operation timed out"
  });
  const result = await refreshHpcQuotasForProfile(hpcProfile, {
    executor: vpnDown,
    writeEvidence: false,
    now: new Date("2026-06-15T00:00:00.000Z")
  });

  assert.equal(result.network_hint, NETWORK_DROP_HINT);
  assert.equal(result.error_kind, "unreachable");
  // Every recorded command still failed — the hint is additive, not a replacement for the evidence.
  assert.equal(result.snapshot.commands.every((c) => c.status !== "passed"), true);
});

test("quotas.refresh does NOT cry VPN-down on a PARTIAL failure (some probes OK, one network-fails)", async () => {
  const { refreshHpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");

  // The reachability guard: the VPN is actually UP. Most probes succeed (exit 0 with real-ish stdout), but
  // ONE allowlisted command transiently fails with a network-unreachable signature (exit 255, connect-
  // timeout banner). Because at least one probe came back exit 0, the host was demonstrably reachable, so a
  // lone unreachable-looking failure is an app/transient error — NOT a VPN drop. aggregateNetworkDrop must
  // bail to undefined the instant any classification is "ok", so the result carries no VPN hint.
  const base = fakeHpcExecutor([]);
  const partialFail = async (program, args, timeoutMs) => {
    const remote = args.slice(args.indexOf("uts-hpc") + 1);
    // pbsnodes is one command among ~10; the identity/queue probes around it still succeed.
    if (remote[0] === "pbsnodes") {
      return {
        exitCode: 255,
        stdout: "",
        stderr: "ssh: connect to host hpc-host01 port 22: Operation timed out"
      };
    }
    return base(program, args, timeoutMs);
  };

  const result = await refreshHpcQuotasForProfile(hpcProfile, {
    executor: partialFail,
    writeEvidence: false,
    now: new Date("2026-06-15T00:00:00.000Z")
  });

  // The load-bearing assertions: a successful probe proves reachability, so NO VPN cry. If the guard
  // regressed to "any unreachable command => VPN down", network_hint/error_kind would be populated here and
  // these would fail.
  assert.equal(result.network_hint, undefined, "a reachable host (some probes passed) is not a VPN drop");
  assert.equal(result.error_kind, undefined, "no error_kind on a partial failure with a successful probe");
  // Sanity: the snapshot still records BOTH a passed probe and the one failed probe — the guard fires
  // precisely because a passed command coexists with the network-fail, not because nothing failed.
  assert.equal(result.snapshot.commands.some((c) => c.status === "passed"), true);
  assert.equal(result.snapshot.commands.some((c) => c.status === "failed"), true);
});

test("quotas.refresh sets no network_hint when the probes ran (healthy refresh)", async () => {
  const { refreshHpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const result = await refreshHpcQuotasForProfile(hpcProfile, {
    executor: fakeHpcExecutor([]),
    writeEvidence: false,
    now: new Date("2026-06-15T00:00:00.000Z")
  });
  assert.equal(result.network_hint, undefined);
  assert.equal(result.error_kind, undefined);
});

test("quotas.refresh captures UTS HPC read-only quota evidence with mocked SSH commands", async () => {
  const { refreshHpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];

  const result = await refreshHpcQuotasForProfile(hpcProfile, {
    executor: fakeHpcExecutor(calls),
    now: new Date("2026-06-15T00:00:00.000Z")
  });

  assert.equal(result.mode, "read-only");
  assert.equal(result.snapshot.profile_id, "uts-hpc-account-a");
  assert.equal(result.snapshot.platform, "uts-hpc");
  assert.equal(result.snapshot.freshness, "fresh");
  assert.equal(result.snapshot.commands.length, 10);
  assert.equal(result.snapshot.summary.identity.remote_user_observed, true);
  assert.deepEqual(result.snapshot.summary.identity.groups, ["research", "hpcusers"]);
  assert.deepEqual(result.snapshot.summary.queues.queue_names, ["smallq", "workq"]);
  assert.equal(result.snapshot.summary.running_work.job_count, 2);
  assert.equal(result.snapshot.summary.node_families.node_count, 2);
  assert.equal(result.snapshot.summary.storage.quota_observed, true);
  assert.equal(result.snapshot.summary.storage.filesystem_count, 2);
  assert.ok(result.evidence_path.startsWith(path.join(runtimeRoot, "quotas")));
  assert.equal(fs.existsSync(result.evidence_path), true);

  const evidenceText = fs.readFileSync(result.evidence_path, "utf8");
  assert.doesNotMatch(evidenceText, /abc123/);
  assert.match(evidenceText, /<redacted-remote-user>/);
  assert.equal(calls.every((call) => call.program === "ssh"), true);
  assert.equal(calls.some((call) => call.args.includes("qsub") || call.args.includes("cnode") || call.args.includes("rsync")), false);
  assert.equal(calls.some((call) => call.args.includes("PasswordAuthentication=no")), true);
  assert.equal(calls.some((call) => call.args.includes("KbdInteractiveAuthentication=no")), true);
});

test("quotas.refresh captures UTS iHPC read-only node session and storage evidence", async () => {
  const { refreshIhpcQuotasForProfile, refreshQuotas } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];

  const result = await refreshIhpcQuotasForProfile(ihpcProfile, {
    executor: fakeIhpcExecutor(calls),
    now: new Date("2026-06-15T00:00:00.000Z")
  });

  assert.equal(result.mode, "read-only");
  assert.equal(result.snapshot.profile_id, "uts-ihpc-account-a");
  assert.equal(result.snapshot.platform, "uts-ihpc");
  assert.equal(result.snapshot.summary.identity.remote_user_observed, true);
  assert.equal(result.snapshot.summary.queues.observed, false);
  assert.deepEqual(result.snapshot.summary.node_families.available_families, ["mars", "mercury", "venus"]);
  assert.deepEqual(result.snapshot.summary.node_families.all_families, ["jupiter", "mars", "mercury", "venus"]);
  assert.equal(result.snapshot.summary.sessions.sessiontime_observed, true);
  assert.equal(result.snapshot.summary.running_work.active_session_count, 1);
  assert.equal(result.snapshot.summary.storage.project_volume_observed, true);
  assert.equal(result.snapshot.summary.storage.filesystem_count, 2);
  assert.equal(result.snapshot.summary.storage.usage_count, 2);
  assert.ok(result.evidence_path.startsWith(path.join(runtimeRoot, "quotas")));
  assert.equal(fs.existsSync(result.evidence_path), true);

  const evidenceText = fs.readFileSync(result.evidence_path, "utf8");
  assert.doesNotMatch(evidenceText, /zid987/);
  assert.match(evidenceText, /<redacted-remote-user>/);
  assert.equal(calls.every((call) => call.program === "ssh"), true);
  assert.equal(
    calls.some((call) => call.args.includes("qstat") || call.args.includes("pbsnodes") || call.args.includes("qsub")),
    false
  );

  const dispatchResult = await refreshQuotas("uts-ihpc-account-a", {
    executor: fakeIhpcExecutor([]),
    writeEvidence: false
  });
  assert.equal(dispatchResult.snapshot.platform, "uts-ihpc");
});

test("quotas.refresh skips unsafe iHPC storage roots before command execution", async () => {
  const { refreshIhpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];
  const unsafeStorageProfile = {
    ...ihpcProfile,
    defaults: {
      workspace: "/data/${USER}/safe",
      scratch: "/scratch/${USER}/bad;touch",
      project: "/project/../bad"
    }
  };

  const result = await refreshIhpcQuotasForProfile(unsafeStorageProfile, {
    executor: fakeIhpcExecutor(calls),
    writeEvidence: false
  });

  const args = calls.flatMap((call) => call.args);
  assert.equal(args.some((arg) => arg.includes(";") || arg.includes("..")), false);
  assert.equal(result.snapshot.summary.storage.filesystem_count, 1);
  assert.equal(result.snapshot.summary.storage.usage_count, 1);
});

test("quotas.refresh records optional iHPC probe failures without aborting the snapshot", async () => {
  const { refreshIhpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];
  const executor = async (program, args, timeoutMs) => {
    const remote = args.slice(args.indexOf("uts-ihpc-access") + 1);
    if (remote.length === 1 && remote[0] === "sessiontime") {
      calls.push({ program, args });
      return { exitCode: 127, stdout: "", stderr: "sessiontime: command not found\n" };
    }
    if (remote.length === 1 && remote[0] === "projvolu") {
      calls.push({ program, args });
      return { exitCode: 1, stdout: "", stderr: "projvolu unavailable\n" };
    }
    return fakeIhpcExecutor(calls)(program, args, timeoutMs);
  };

  const result = await refreshIhpcQuotasForProfile(ihpcProfile, {
    executor,
    writeEvidence: false
  });

  assert.equal(result.snapshot.freshness, "fresh");
  assert.equal(result.snapshot.summary.sessions.sessiontime_observed, false);
  assert.equal(result.snapshot.summary.storage.project_volume_observed, false);
  assert.equal(result.snapshot.summary.storage.failed_count, 1);
  assert.equal(result.snapshot.commands.find((command) => command.id === "sessions.sessiontime").status, "failed");
  assert.equal(result.snapshot.commands.find((command) => command.id === "storage.projvolu").status, "failed");
});

test("quotas.refresh rejects non-HPC profiles before command execution", async () => {
  const { refreshHpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];

  await assert.rejects(
    () =>
      refreshHpcQuotasForProfile(ihpcProfile, {
        executor: fakeHpcExecutor(calls),
        writeEvidence: false
      }),
    /requires an uts-hpc profile/
  );
  assert.equal(calls.length, 0);
});

test("quotas.refresh rejects unsafe iHPC host aliases before command execution", async () => {
  const { refreshIhpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];
  const unsafeProfile = {
    ...ihpcProfile,
    login: {
      ...ihpcProfile.login,
      host_alias: "uts-ihpc-access;touch-bad"
    }
  };

  await assert.rejects(
    () =>
      refreshIhpcQuotasForProfile(unsafeProfile, {
        executor: fakeIhpcExecutor(calls),
        writeEvidence: false
      }),
    /Unsafe SSH host alias/
  );
  assert.equal(calls.length, 0);
});

test("quotas.refresh rejects unsafe HPC host aliases before command execution", async () => {
  const { refreshHpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const calls = [];
  const unsafeProfile = {
    ...hpcProfile,
    login: {
      ...hpcProfile.login,
      host_alias: "uts-hpc;touch-bad"
    }
  };

  await assert.rejects(
    () =>
      refreshHpcQuotasForProfile(unsafeProfile, {
        executor: fakeHpcExecutor(calls),
        writeEvidence: false
      }),
    /Unsafe SSH host alias/
  );
  assert.equal(calls.length, 0);
});

// Reproduces the iHPC session-count misparse: the real `cnode mynodes` reply leads with a multi-line
// welcome banner whose lines start with "*". A user who holds zero nodes must report 0 active
// sessions, not a count of the banner lines.
function ihpcExecutorWithMynodes(calls, mynodesStdout) {
  const base = fakeIhpcExecutor(calls);
  return async (program, args) => {
    const remote = args.slice(args.indexOf("uts-ihpc-access") + 1);
    if (remote.length === 2 && remote.join(" ") === "cnode mynodes") {
      calls.push({ program, args });
      return { exitCode: 0, stdout: mynodesStdout, stderr: "" };
    }
    return base(program, args);
  };
}

test("quotas.refresh active_session_count counts held nodes, not the iHPC welcome banner", async () => {
  const { refreshIhpcQuotasForProfile } = await import("../../dist/ops/quotas/quotas.js");
  const bannerOnlyMynodes = [
    " ",
    "*******************************************************",
    "*               Welcome to the iHPC                   *",
    "*                                                     *",
    "*    To connect to a node use the ssh command         *",
    "*    (eg. ssh mars6).                                 *",
    "*                                                     *",
    "*******************************************************",
    " ",
    "   Node   Index\t Connect  %CPU\t %Mem\t %GPU\t %GPU Mem   User(s)  ",
    ""
  ].join("\n");

  const result = await refreshIhpcQuotasForProfile(ihpcProfile, {
    executor: ihpcExecutorWithMynodes([], bannerOnlyMynodes),
    now: new Date("2026-06-15T00:00:00.000Z")
  });

  assert.equal(result.snapshot.summary.running_work.active_session_count, 0);
  assert.deepEqual(result.snapshot.summary.sessions.active_nodes, []);
});
