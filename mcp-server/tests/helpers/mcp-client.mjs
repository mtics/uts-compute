// Shared stdio MCP-client harness for the real-server test files (mcp-protocol, tool-registration).
//
// Both files stood up an identical StdioClientTransport against mcp-server/dist/index.js with the
// same safeProcessEnv() string-only env filter, differing only in: the client name, whether a
// per-call env override is supported, and each file's own relocated UTS_COMPUTING_HOME. This module
// owns the transport plumbing; callers bind their own home + client name (and opt into env overrides)
// so each prior behavior is preserved exactly.
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { repoRoot } from "./paths.mjs";

// Only string-valued env entries survive — StdioClientTransport rejects non-string values that can
// leak in from the parent process env.
export function safeProcessEnv() {
  return Object.fromEntries(Object.entries(process.env).filter((entry) => typeof entry[1] === "string"));
}

// Build a `withMcpClient(fn, env?)` bound to a specific relocated runtime home and client name.
// - home:       value for UTS_COMPUTING_HOME (relocates the server's `.uts-computing`).
// - clientName: the MCP Client `name` (kept per-file for transcript clarity).
// The returned function connects a fresh stdio client, runs `fn(client)`, and always closes it.
// The optional second arg merges extra env on top of the base (used by mcp-protocol's per-call env).
export function makeWithMcpClient({ home, clientName, clientVersion = "0.1.0" }) {
  return async function withMcpClient(fn, env = undefined) {
    const client = new Client({ name: clientName, version: clientVersion });
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["mcp-server/dist/index.js"],
      cwd: repoRoot,
      env: { ...safeProcessEnv(), UTS_COMPUTING_HOME: home, ...(env ?? {}) },
      stderr: "pipe"
    });

    await client.connect(transport);
    try {
      return await fn(client);
    } finally {
      await client.close();
    }
  };
}
