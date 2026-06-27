# ADR 0005: Standards-First Distribution

## Status

Accepted (2026-06-16). Supersedes the dual-plugin parts of [ADR 0001](0001-shared-mcp-and-skills-package.md) and [ADR 0003](0003-plugin-shim-contract.md): the Codex-specific plugin wrapper is retired.

## Context

ADR 0001/0003 shipped the package as **two** client plugins (`.claude-plugin/` + `.codex-plugin/`), each a thin wrapper over the shared MCP server and Skills. ADR 0003 then had to split the MCP launch config per client because Claude Code and Codex expand different plugin-root variables (`${CLAUDE_PLUGIN_ROOT}` vs `${PLUGIN_ROOT}`) and neither documents the other's substitution inside MCP-server config.

Verification of the 2026 ecosystem (recorded in [fact-registry](../fact-registry.md) F048) showed the per-client *plugin* wrapper is avoidable, because the two layers underneath are genuine open standards both clients already consume:

- **MCP** is an open protocol (Linux-Foundation governed). The `mcpServers` config shape is read near-identically across clients. Codex registers a local stdio MCP server via `~/.codex/config.toml` `[mcp_servers.<name>]` or `codex mcp add … -- node <abs>/dist/index.js` — **independent of any Codex plugin**, yielding all tools. (`developers.openai.com/codex/mcp`)
- **Agent Skills** (`SKILL.md`) was published as an open standard (agentskills.io, 2025-12-18) and is consumed natively by Codex, Cursor, Copilot, Gemini CLI and others. Codex auto-discovers `SKILL.md` folders from `.agents/skills/` (repo root, `$HOME`, `/etc/codex`) with **no manifest and no plugin**. (`developers.openai.com/codex/skills`)

There is, by contrast, **no ratified cross-vendor plugin standard** in 2026; "unified" install pages (Smithery, Cursor links, the MCP registry UI) are per-client snippet/deeplink generators, not a universal installer.

## Decision

Distribute on the open standards; keep exactly one client-specific plugin where it buys real UX.

1. **Claude Code — keep one plugin.** `.claude-plugin/plugin.json` + `marketplace.json` + `.mcp.json` (`${CLAUDE_PLUGIN_ROOT}` launch arg). This preserves `/plugin install` and automatic Skill discovery, both verified working.
2. **Codex — no plugin.** Retire `.codex-plugin/plugin.json` and `.codex.mcp.json`. Codex consumes the package via standards:
   - MCP server: `codex mcp add uts-compute -- node <repo>/mcp-server/dist/index.js` (absolute path — Codex does not document `${VAR}` substitution in MCP config, and an absolute path is CWD-independent anyway).
   - Skills: auto-discovered from `.agents/skills/`, provided in-repo as symlinks to the canonical `skills/` tree.
3. **Everyone else (Cursor, VS Code, Windsurf, …)** uses the same `mcpServers` config + the same `SKILL.md` folders. No per-client packaging is maintained.
4. **Broader reach (open-standard packaging):**
   - Publish the MCP server to the official **MCP registry** via `server.json` (discovery/metadata).
   - Ship an **`.mcpb` bundle** (`manifest.json`, `${__dirname}` launch path, bundled deps) for one-click install in Claude Desktop / Claude Code and as a Connectors-directory base.

The shared implementation (`mcp-server/`, `skills/`, `schemas/`, `templates/`, `profiles/`, `docs/`) stays client-neutral and is the single source of truth.

## Consequences

Benefits:

- One maintained client plugin instead of two; the unverified Codex `${PLUGIN_ROOT}`-in-MCP-config risk disappears (absolute path).
- Codex/Cursor/etc. consume the package through their own standard MCP + Skills mechanisms — no bespoke adaptation per agent.
- `server.json` + `.mcpb` give standards-based discovery and one-click reach without a second plugin.

Tradeoffs:

- Codex onboarding is two standard steps (`codex mcp add …` + skills available under `.agents/skills/`) rather than one bundled plugin install.
- `.agents/skills/` mirrors `skills/` via symlinks; the canonical tree remains `skills/`.
- Registry publish and `.mcpb` packing are release-time steps that need the maintainer's npm/GitHub namespace and the `mcpb` CLI; the manifests and scripts are authored in-repo, the publish is run by the maintainer.
- The client-installed smoke evidence model becomes per-method: Claude Code attests a **plugin** install; Codex attests a **standard MCP-config** install + `.agents/skills` discovery.

## Validation

Before release:

- `npm run validate:plugin` (Claude plugin + `.agents/skills` presence);
- `npm test`;
- Claude Code: `/plugin install` from the local marketplace; `/mcp` connected; `/help` shows the Skills;
- Codex: `codex mcp add` registers the server (tools available) and `.agents/skills/` Skills are discovered;
- capture both client-installed smoke evidence files (plugin method + mcp-config method).
