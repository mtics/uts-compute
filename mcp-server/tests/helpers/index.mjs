// Barrel for the shared test-helper colony. Test files may import named helpers from here or from the
// focused modules (paths.mjs / fixtures.mjs / mcp-client.mjs) directly.
export { repoRoot, examplesDir, runtimeRoot } from "./paths.mjs";
export {
  tempRuntimeDir,
  readExample,
  readTransferExample,
  writeProfileConfig,
  writeQuotaSnapshot,
  hpcProfile,
  resolvedHpcProfile,
  writeResolvedHpcConfig,
  resolvedHpcWorkdir,
  RESOLVED_HPC_USER,
  RESOLVED_HPC_ALIAS
} from "./fixtures.mjs";
export { makeWithMcpClient, safeProcessEnv } from "./mcp-client.mjs";
