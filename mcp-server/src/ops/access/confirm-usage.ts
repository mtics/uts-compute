import { getProfile } from "../../core/config.js";
import { sshOnNode } from "../../core/access.js";
import type { SshOnNodeOptions } from "../../core/access.js";
import { PLATFORM } from "../../core/types.js";

export interface ConfirmUsageResult {
  profile_id: string;
  host_alias: string;
  node: string;
  token: string;
  confirmed: boolean;
  stdout: string;
  stderr: string;
  exit_code: number | null;
  timed_out: boolean;
}

export async function confirmUsageOnNode(
  profileId: string,
  node: string,
  token: string,
  options: SshOnNodeOptions & { configPath?: string } = {}
): Promise<ConfirmUsageResult> {
  const profile = getProfile(profileId, options.configPath);

  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(
      `Profile ${profileId} is platform "${profile.platform}"; confirm_usage is only supported for uts-ihpc profiles`
    );
  }

  // Token must be strictly alphanumeric as issued by the iHPC admin system.
  if (!/^[A-Za-z0-9]{4,32}$/.test(token)) {
    throw new Error("Invalid confirmation token: must be 4–32 alphanumeric characters with no spaces or symbols");
  }

  const result = await sshOnNode(profile.login.host_alias, node, ["confirm_usage", token], options);

  return {
    profile_id: profileId,
    ...result,
    token,
    confirmed: result.exit_code === 0
  };
}
