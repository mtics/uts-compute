# ADR 0003: Plugin Shim Contract

## Status

Accepted, then **partially superseded by [ADR 0005](0005-standards-first-distribution.md)** (2026-06-16): the Codex plugin wrapper (`.codex-plugin/`, `.codex.mcp.json`) and the per-client MCP-config split are retired — Codex now uses the standard MCP config + `.agents/skills`. The Claude Code plugin (`.claude-plugin/` + `.mcp.json` with `${CLAUDE_PLUGIN_ROOT}`) described here remains in force.

## Context

The project must work for both Codex and Claude Code. Official plugin documentation for both clients expects component paths such as `skills` and `mcpServers` to use plugin-root-relative paths beginning with `./`.

The repository root is the plugin root. The `.codex-plugin/` and `.claude-plugin/` directories contain manifests only; they are not separate implementations.

## Decision

Use thin client-specific manifests:

- `.codex-plugin/plugin.json`
- `.claude-plugin/plugin.json`

Both manifests reference the shared Skills tree from the repository root:

- shared Skills: `./skills/`

Each manifest references a **client-specific MCP config**, because the two clients expand different plugin-root variables and neither documents `${VAR}` substitution of the other's variable inside MCP-server configs:

- `.claude-plugin/plugin.json` → `./.mcp.json` (Claude Code; launch arg uses `${CLAUDE_PLUGIN_ROOT}`);
- `.codex-plugin/plugin.json` → `./.codex.mcp.json` (Codex; launch arg uses `${PLUGIN_ROOT}`).

Both configs are otherwise identical: the same `{ mcpServers: { "uts-compute": { type: "stdio", command: "node", … } } }` shape launching the same `mcp-server/dist/index.js`. The launch arg is built from each client's plugin-root variable — `args: ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"]` for Claude, `args: ["${PLUGIN_ROOT}/mcp-server/dist/index.js"]` for Codex — so `node` finds the entrypoint regardless of the client's working directory. (A bare relative `mcp-server/dist/index.js` only resolves if the client launches with the plugin root as CWD, which neither client guarantees.) The `env.UTS_COMPUTING_CONFIG` value stays plugin-root-relative because the server resolves it against its own location (`import.meta.url`), not CWD.

The shared implementation remains client-neutral:

- `mcp-server/`
- `schemas/`
- `profiles/`
- `templates/`
- `docs/`

The MCP server must be built before plugin use so that `mcp-server/dist/index.js` exists. Client-specific behavior belongs only in manifest files and these per-client MCP configs.

Shared Skill directories may contain optional `agents/openai.yaml` metadata when it only describes OpenAI/Codex-facing display prompts for that Skill. This is treated as Skill metadata, not a second implementation. It must not contain tool logic, credentials, alternate MCP server definitions, or platform-specific command behavior.

## Consequences

Benefits:

- avoids duplicate Skill trees;
- avoids divergent MCP implementations;
- keeps Codex and Claude Code behavior aligned;
- makes path validation easier to test.

Tradeoffs:

- packaging validation must be run separately for each client;
- the MCP config exists in two near-identical copies (`.mcp.json` and `.codex.mcp.json`), differing only in the plugin-root variable; `validate:plugin` checks each against its expected variable so they cannot silently drift;
- Codex's `${PLUGIN_ROOT}` substitution inside MCP-server config is not yet documented by OpenAI (only confirmed for hook commands), so the Codex launch path is validated structurally here but must be confirmed once in a real installed-Codex smoke before release.

Resolution of the earlier env-var tradeoff: rather than bet a single shared `.mcp.json` on cross-client variable substitution, each client uses its own documented variable in its own config. This removed the bare-relative launch path, which was proven to fail when the client's CWD is not the plugin root.

## Validation

Before release:

- run plugin validation for the Codex manifest (`./skills/` and `./.codex.mcp.json` resolve);
- validate that Claude Code resolves `./skills/` and `./.mcp.json`;
- run `npm run validate:plugin`;
- run `npm test`;
- launch the MCP server from the plugin root via each client's `${…PLUGIN_ROOT}` launch arg;
- confirm a new client thread can discover the Skills and dry-run MCP tools;
- capture installed-client smoke evidence in both Codex and Claude Code (confirms Codex `${PLUGIN_ROOT}` expansion in MCP config).
