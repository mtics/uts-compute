// Tests for the fetchHeldNodes seam — injects a fake CommandExecutor so no real SSH occurs.
// Mirrors the executor-injection pattern used in quotas.test.mjs (fakeIhpcExecutor).

import assert from "node:assert/strict";
import test from "node:test";
import { writeProfileConfig } from "../../helpers/fixtures.mjs";

// ---- fixture profile -----------------------------------------------------------------
// Minimal iHPC profile — only login.host_alias is required by fetchHeldNodes.
const ihpcProfile = {
  profile_id: "uts-ihpc-test",
  platform: "uts-ihpc",
  account_label: "ihpc-test",
  login: {
    host_alias: "uts-ihpc-access",
    username_ref: "UTS_IHPC_TEST_USER",
    ssh_agent: true,
    requires_vpn: true
  },
  defaults: {
    node_family: "mars",
    workspace: "/data/${USER}/experiments",
    scratch: "/scratch/${USER}"
  },
  quota_snapshot: null
};

// Write a single-profile config and return its path, so fetchHeldNodes can resolve the profile.
function profileConfigPath() {
  return writeProfileConfig("held-nodes", [ihpcProfile]);
}

// ---- helper: fake executor -----------------------------------------------------------
// The executor receives ("ssh", [...sshArgs], timeoutMs). The ssh args for a read-only
// iHPC command have the form: [...outerHopFlags, "uts-ihpc-access", "cnode", "mynodes"].
// We locate the host alias in the args and take everything after it as the remote argv.

function makeExecutor(handler) {
  return async (program, args, timeoutMs) => {
    assert.equal(program, "ssh", "fetchHeldNodes should always invoke ssh");
    const hostIdx = args.indexOf("uts-ihpc-access");
    assert.ok(hostIdx >= 0, "host alias 'uts-ihpc-access' must appear in ssh args");
    const remoteArgv = args.slice(hostIdx + 1);
    return handler(remoteArgv, timeoutMs);
  };
}

// ---- tests ---------------------------------------------------------------------------

test("fetchHeldNodes: ok probe parses held node names from fixture stdout", async () => {
  const { fetchHeldNodes } = await import("../../../dist/ops/quotas/held-nodes.js");

  // Validated live fixture for liyou: mars11 + venus2
  const stdout = "Node Family\nmars11 mars\nvenus2 venus\n";

  const executor = makeExecutor((remoteArgv) => {
    assert.deepEqual(remoteArgv, ["cnode", "mynodes"], "must run exactly 'cnode mynodes'");
    return { exitCode: 0, stdout, stderr: "" };
  });

  const result = await fetchHeldNodes("uts-ihpc-test", {
    configPath: profileConfigPath(),
    executor,
    now: new Date("2026-06-29T00:00:00.000Z")
  });

  assert.equal(result.ok, true, "ok should be true when command exits 0");
  assert.ok(result.heldNodes instanceof Set, "heldNodes should be a Set");
  assert.equal(result.heldNodes.size, 2, "should contain 2 nodes");
  assert.ok(result.heldNodes.has("mars11"), "should contain mars11");
  assert.ok(result.heldNodes.has("venus2"), "should contain venus2");
  assert.equal(result.reason, undefined, "no reason on success");
  assert.equal(result.observedAt, "2026-06-29T00:00:00.000Z", "observedAt matches opts.now");
});

test("fetchHeldNodes: ok probe with zhiwli fixture parses 3 nodes", async () => {
  const { fetchHeldNodes } = await import("../../../dist/ops/quotas/held-nodes.js");

  // Validated live fixture for zhiwli: mars4, saturn10, turing2
  const stdout = "Node Family\nmars4 mars\nsaturn10 saturn\nturing2 turing\n";

  const executor = makeExecutor(() => ({ exitCode: 0, stdout, stderr: "" }));

  const result = await fetchHeldNodes("uts-ihpc-test", {
    configPath: profileConfigPath(),
    executor
  });

  assert.equal(result.ok, true);
  assert.equal(result.heldNodes.size, 3);
  assert.ok(result.heldNodes.has("mars4"));
  assert.ok(result.heldNodes.has("saturn10"));
  assert.ok(result.heldNodes.has("turing2"));
});

test("fetchHeldNodes: ok probe with zero held nodes (stdout 'No nodes\\n')", async () => {
  const { fetchHeldNodes } = await import("../../../dist/ops/quotas/held-nodes.js");

  const executor = makeExecutor(() => ({ exitCode: 0, stdout: "No nodes\n", stderr: "" }));

  const result = await fetchHeldNodes("uts-ihpc-test", {
    configPath: profileConfigPath(),
    executor
  });

  assert.equal(result.ok, true, "ok is true — command ran cleanly, user just holds nothing");
  assert.equal(result.heldNodes.size, 0, "empty set when user holds no nodes");
  assert.equal(result.reason, undefined);
});

test("fetchHeldNodes: failed probe (exit 255) returns ok:false, empty set, reason present", async () => {
  const { fetchHeldNodes } = await import("../../../dist/ops/quotas/held-nodes.js");

  const executor = makeExecutor(() => ({
    exitCode: 255,
    stdout: "",
    stderr: "ssh: connect to host uts-ihpc-access port 22: Operation timed out"
  }));

  const result = await fetchHeldNodes("uts-ihpc-test", {
    configPath: profileConfigPath(),
    executor
  });

  assert.equal(result.ok, false, "ok is false on command failure");
  assert.equal(result.heldNodes.size, 0, "heldNodes is empty on failure");
  assert.ok(typeof result.reason === "string" && result.reason.length > 0, "reason is a non-empty string");
});

test("fetchHeldNodes: observedAt is an ISO string even when opts.now is omitted", async () => {
  const { fetchHeldNodes } = await import("../../../dist/ops/quotas/held-nodes.js");

  const executor = makeExecutor(() => ({ exitCode: 0, stdout: "", stderr: "" }));
  const before = new Date().toISOString();

  const result = await fetchHeldNodes("uts-ihpc-test", {
    configPath: profileConfigPath(),
    executor
  });

  const after = new Date().toISOString();
  assert.ok(result.observedAt >= before && result.observedAt <= after, "observedAt is a current ISO timestamp");
});

test("parseIhpcActiveNodes: exported from held-nodes, parses correctly", async () => {
  const { parseIhpcActiveNodes } = await import("../../../dist/ops/quotas/held-nodes.js");

  const stdout = "Node Family\nmars11 mars\nvenus2 venus\nno nodes currently\n";
  const nodes = parseIhpcActiveNodes(stdout);

  assert.equal(nodes.length, 2);
  assert.equal(nodes[0].node, "mars11");
  assert.equal(nodes[0].family, "mars");
  assert.equal(nodes[1].node, "venus2");
  assert.equal(nodes[1].family, "venus");
});
