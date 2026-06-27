import assert from "node:assert/strict";
import test from "node:test";
import { classifyRemoteFailure, NETWORK_DROP_HINT } from "../../dist/lib/net-errors.js";

// A clean success: exit 0, real stdout. Never network-unreachable; kind "ok".
test("exit 0 with output classifies as ok", () => {
  const c = classifyRemoteFailure({ exitCode: 0, stdout: "job is running", stderr: "" });
  assert.equal(c.kind, "ok");
  assert.equal(c.network_unreachable, false);
  assert.equal(c.hint, undefined);
});

// A timeout (the runProcess SIGTERM path) is a network-drop symptom and carries the VPN hint.
test("timedOut classifies as timeout + network_unreachable with VPN hint", () => {
  const c = classifyRemoteFailure({ exitCode: null, stdout: "", stderr: "", timedOut: true });
  assert.equal(c.kind, "timeout");
  assert.equal(c.network_unreachable, true);
  assert.ok(c.hint && /VPN/i.test(c.hint), "hint should mention the VPN");
  assert.ok(/access\.doctor --export-ssh/.test(c.hint), "hint should mention the manual fallback");
  assert.equal(c.hint, NETWORK_DROP_HINT);
});

// SSH's own connect-failure stderr banners. All are network-unreachable.
test("ssh transport stderr banners classify as unreachable + VPN hint", () => {
  const banners = [
    "ssh: connect to host hpc-host01 port 22: Operation timed out",
    "ssh: connect to host hpc-host01 port 22: Network is unreachable",
    "ssh: connect to host hpc-host01 port 22: No route to host",
    "ssh: connect to host hpc-host01 port 22: Connection timed out",
    "Connection timed out",
    "Network is unreachable",
    "No route to host"
  ];
  for (const stderr of banners) {
    const c = classifyRemoteFailure({ exitCode: 255, stdout: "", stderr });
    assert.equal(c.network_unreachable, true, `expected unreachable for: ${stderr}`);
    assert.equal(c.kind, "unreachable", `expected kind unreachable for: ${stderr}`);
    assert.equal(c.hint, NETWORK_DROP_HINT, `expected VPN hint for: ${stderr}`);
  }
});

// Case-insensitivity (real macOS ssh emits mixed case).
test("network banners match case-insensitively", () => {
  const c = classifyRemoteFailure({ exitCode: 255, stdout: "", stderr: "OPERATION TIMED OUT" });
  assert.equal(c.network_unreachable, true);
  assert.equal(c.kind, "unreachable");
});

// DNS failure is its own kind but still a network-drop symptom (the VPN provides the resolver route).
test("could not resolve hostname classifies as dns + network_unreachable", () => {
  for (const stderr of [
    "ssh: Could not resolve hostname hpc-host01: nodename nor servname provided, or not known",
    "Could not resolve hostname hpc-host01: Name or service not known",
    "Name or service not known"
  ]) {
    const c = classifyRemoteFailure({ exitCode: 255, stdout: "", stderr });
    assert.equal(c.kind, "dns", `expected dns for: ${stderr}`);
    assert.equal(c.network_unreachable, true, `expected unreachable for: ${stderr}`);
    assert.equal(c.hint, NETWORK_DROP_HINT);
  }
});

// An auth failure means the network reached sshd — NOT a VPN drop. No hint.
test("permission denied classifies as auth, not network_unreachable", () => {
  for (const stderr of [
    "Permission denied (publickey).",
    "Host key verification failed."
  ]) {
    const c = classifyRemoteFailure({ exitCode: 255, stdout: "", stderr });
    assert.equal(c.kind, "auth", `expected auth for: ${stderr}`);
    assert.equal(c.network_unreachable, false, `auth must not be network_unreachable: ${stderr}`);
    assert.equal(c.hint, undefined);
  }
});

// Connection refused: the host answered (TCP RST) — reached, not a VPN drop. Treated as auth-ish/refused
// transport, NOT network-unreachable (a refused port means routing worked).
test("connection refused is reachable (not a VPN-down hint)", () => {
  const c = classifyRemoteFailure({ exitCode: 255, stdout: "", stderr: "ssh: connect to host h port 22: Connection refused" });
  assert.equal(c.network_unreachable, false);
  assert.ok(c.hint === undefined);
});

// The CRITICAL misclassification guard: a REAL remote tool ran and exited non-zero for app reasons
// (substantive stdout/stderr, NOT a network banner). It must be "remote", never network-unreachable.
test("a remote tool's own non-zero exit with substantive output is remote, not network", () => {
  const c = classifyRemoteFailure({
    exitCode: 1,
    stdout: "",
    stderr: "qstat: Unknown Job Id 12345.hpc-head01"
  });
  assert.equal(c.kind, "remote");
  assert.equal(c.network_unreachable, false);
  assert.equal(c.hint, undefined);
});

test("a remote tool exit with real stdout is remote, not network", () => {
  const c = classifyRemoteFailure({
    exitCode: 2,
    stdout: "df: /no/such/path: No such file or directory",
    stderr: ""
  });
  assert.equal(c.kind, "remote");
  assert.equal(c.network_unreachable, false);
});

// exit 255 with EMPTY stderr is the bare ssh transport failure (no banner captured) — treat as a
// network-unreachable symptom, not a remote app error (a remote tool that exits 255 still leaves output).
test("exit 255 with empty stderr/stdout classifies as unreachable", () => {
  const c = classifyRemoteFailure({ exitCode: 255, stdout: "", stderr: "" });
  assert.equal(c.kind, "unreachable");
  assert.equal(c.network_unreachable, true);
  assert.equal(c.hint, NETWORK_DROP_HINT);
});

// A spawn error (exitCode null, not a timeout) — e.g. ssh binary missing or pipe error. The runProcess
// contract puts the error message in stderr. Not network-unreachable unless the message says so.
test("spawn error (null exit, no timeout) with a non-network message is remote", () => {
  const c = classifyRemoteFailure({ exitCode: null, stdout: "", stderr: "spawn ssh ENOENT" });
  assert.equal(c.network_unreachable, false);
  assert.equal(c.kind, "remote");
});
