// Pure, secret-free SSH-config export (H5). Lets a human reach the cluster when the plugin can't
// (VPN down/offline). Emits env-var NAMES and the login host only — never any secret value, key,
// password, or the real remote username (which may be embedded in host_alias as user@host).
import { clusterFromHostAlias } from "../../core/config.js";
import type { ComputeProfile } from "../../core/types.js";

export interface SshExportResult {
  login_host: string;
  ssh_config_snippet: string;
  required_env_names: string[];
}

export function sshConfigSnippet(profile: ComputeProfile): SshExportResult {
  const login = profile.login;
  const login_host = clusterFromHostAlias(login.host_alias);
  if (!login_host) {
    throw new Error(`Profile ${profile.profile_id} has no resolvable login host_alias`);
  }
  const required_env_names = [login.username_ref];
  const lines: string[] = [];
  if (login.requires_vpn) {
    lines.push("# NOTE: requires VPN connection to reach this host");
  }
  lines.push(`Host ${profile.profile_id}`);
  lines.push(`  HostName ${login_host}`);
  // username_ref is the env-var NAME holding the username; the operator substitutes its value.
  lines.push(`  User \${${login.username_ref}}   # replace with the value of $${login.username_ref}`);
  if (login.identity_file_ref) {
    required_env_names.push(login.identity_file_ref);
    lines.push(`  IdentityFile \${${login.identity_file_ref}}   # path held by $${login.identity_file_ref}`);
  }
  if (login.ssh_agent) {
    lines.push("  AddKeysToAgent yes");
  }
  if (login.keychain_ref) {
    // No standard ~/.ssh/config keychain directive — surface the env NAME as a comment, don't invent one.
    required_env_names.push(login.keychain_ref);
    lines.push(`  # macOS keychain: set $${login.keychain_ref} externally (e.g. via ssh-add --apple-use-keychain)`);
  }
  return { login_host, ssh_config_snippet: lines.join("\n"), required_env_names };
}
