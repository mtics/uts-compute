import assert from "node:assert/strict";
import test from "node:test";
import { sshConfigSnippet } from "../../dist/ops/access/ssh-export.js";

const hpc = {
  profile_id: "uts-hpc-account-a", platform: "uts-hpc",
  account_label: "cetus-a",
  login: { host_alias: "u00000001@login-host.example", username_ref: "UTS_HPC_ACCOUNT_A_USER", identity_file_ref: "UTS_HPC_KEY", requires_vpn: true, ssh_agent: true },
  defaults: {}, quota_snapshot: null
};
const ihpc = {
  profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
  account_label: "ihpc-a",
  login: { host_alias: "ihpc-alias", username_ref: "UTS_IHPC_ACCOUNT_A_USER", requires_vpn: false },
  defaults: {}, quota_snapshot: null
};

test("sshConfigSnippet exports login_host, a config snippet, and env NAMES — no secret values", () => {
  const r = sshConfigSnippet(hpc);
  assert.equal(r.login_host, "login-host.example");
  assert.match(r.ssh_config_snippet, /^Host /m);
  assert.match(r.ssh_config_snippet, /HostName login-host\.example/);
  // username is rendered as the env-var NAME placeholder, NEVER the real username from host_alias
  assert.match(r.ssh_config_snippet, /User \$\{UTS_HPC_ACCOUNT_A_USER\}/);
  assert.equal(r.ssh_config_snippet.includes("u00000001"), false, "must not leak the real username");
  assert.deepEqual(r.required_env_names.sort(), ["UTS_HPC_ACCOUNT_A_USER", "UTS_HPC_KEY"].sort());
  assert.match(r.ssh_config_snippet, /IdentityFile \$\{UTS_HPC_KEY\}/);
  assert.match(r.ssh_config_snippet, /requires VPN/i); // informational comment since requires_vpn
});

test("sshConfigSnippet handles a bare iHPC alias and no identity file", () => {
  const r = sshConfigSnippet(ihpc);
  assert.equal(r.login_host, "ihpc-alias");
  assert.deepEqual(r.required_env_names, ["UTS_IHPC_ACCOUNT_A_USER"]);
  assert.equal(r.ssh_config_snippet.includes("IdentityFile"), false);
});

test("sshConfigSnippet throws on an empty host_alias", () => {
  assert.throws(() => sshConfigSnippet({ ...ihpc, login: { ...ihpc.login, host_alias: "" } }), /host/i);
});
