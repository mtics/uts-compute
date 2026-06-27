# Distribution

This package distributes on open standards (see [adr/0005-standards-first-distribution.md](adr/0005-standards-first-distribution.md)). There are four surfaces; the shared MCP server and Skills are the single source of truth for all of them.

| Surface | How users get it | Maintained artifact |
|---|---|---|
| Claude Code | `/plugin install` from the local/Git marketplace | `.claude-plugin/` + `marketplace.json` + `.mcp.json` |
| Codex (+ Cursor, VS Code, …) | standard MCP config + `SKILL.md` discovery | shared `mcp-server/` + `.agents/skills/` |
| Claude Desktop / one-click | install a `.mcpb` bundle | `manifest.json` (+ `.mcpbignore`) |
| MCP registry (discovery) | `server.json` published under `io.github.mtics/…` | `server.json` |

## Claude Code plugin

```text
/plugin marketplace add /absolute/path/to/uts-compute
/plugin install uts-compute@mtics-plugins
```

Verify with `/mcp` (server connected) and `/help` (the 14 Skills). See [plugin-setup.md](plugin-setup.md).

## Codex (and other standard MCP clients)

No plugin. Register the MCP server and rely on `.agents/skills/` discovery:

```sh
codex mcp add uts-compute -- node "$(pwd)/mcp-server/dist/index.js"
```

Cursor / VS Code: add the same `node <abs>/mcp-server/dist/index.js` stdio server to their `mcpServers` config. All read the same `SKILL.md` folders.

## `.mcpb` bundle (one-click for Claude Desktop / Claude Code)

`manifest.json` (manifest_version `0.3`) declares a Node server launched via `${__dirname}/mcp-server/dist/index.js`, so the bundle is location-independent. `.mcpbignore` keeps only the runtime files (dist, node_modules, templates, schemas, example profiles).

```sh
npm install                 # ensure node_modules (bundled into the .mcpb)
npm run build               # produce mcp-server/dist
npm run validate:mcpb       # mcpb validate manifest.json
npm run pack:mcpb           # mcpb pack . -> uts-compute.mcpb
```

(`pack:mcpb` / `validate:mcpb` run the `@anthropic-ai/mcpb` CLI via `npx`.) Install the resulting `uts-compute.mcpb` by double-clicking it in Claude Desktop, or via Claude Code's extension install. At install the user is prompted for the optional **UTS profiles file** (`UTS_COMPUTING_CONFIG`); it defaults to the bundled `profiles/profiles.example.yaml`.

The packed `*.mcpb` is a build artifact and is git-ignored.

## MCP registry

`server.json` (schema `2025-12-11`) describes the server for the official registry, distributed as the `.mcpb` from a GitHub release. Publishing is a maintainer step (needs the `mtics` GitHub identity):

```sh
# 1. Pack and attach uts-compute.mcpb to a GitHub release whose tag matches server.json's
#    version (currently v0.1.5) — it must equal the tag in packages[0].identifier's release URL.
# 2. Fill server.json packages[0].fileSha256:
shasum -a 256 uts-compute.mcpb
# 3. Publish:
npm install -g @modelcontextprotocol/registry   # provides mcp-publisher
mcp-publisher login github                        # proves ownership of io.github.mtics/*
mcp-publisher publish                             # reads ./server.json
```

> The exact registry-CLI binary name (`mcp-publisher`) should be confirmed against the registry repo's current publishing quickstart before a real publish.

## Secrets

Never bundle or commit `profiles/profiles.local.yaml`, credentials, tokens, `.uts-computing/`, or generated evidence. The `.mcpb` ships only `profiles/profiles.example.yaml`; real accounts are supplied at install time via the user-config prompt.
