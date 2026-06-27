# Plugin Setup

This package distributes on open standards: one shared stdio MCP server and one shared `SKILL.md` Skills tree. Only Claude Code gets a thin plugin wrapper; Codex and other agents consume the same MCP server and Skills through their own standard mechanisms (see [ADR 0005](adr/0005-standards-first-distribution.md)).

## Shared Root

The repository root is the plugin root. The single source of truth is client-neutral:

- shared Skills: `./skills/` (canonical), mirrored as symlinks under `./.agents/skills/` so Codex and other `agentskills.io`-compatible agents auto-discover them;
- shared MCP server: `mcp-server/dist/index.js`.

Distribution surfaces:

- **Claude Code** — thin plugin at `.claude-plugin/plugin.json` (+ `marketplace.json`) pointing to `./skills/` and `./.mcp.json` (launch arg `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js`).
- **Codex** — no plugin: register the MCP server via `codex mcp add` / `~/.codex/config.toml`, and let Codex auto-discover Skills from `.agents/skills/`.
- **Other agents (Cursor, VS Code, …)** — add the MCP server via their standard `mcpServers` config; read the same `SKILL.md` folders.

Do not copy Skills or MCP server code into client-specific directories.

## Build And Validate

Run from the repository root:

```sh
npm install
npm run build
npm test
npm run validate:plugin
npm run smoke:plugin:host-neutral
npm run client-smoke:prompt
```

`npm test` runs a `pretest` hook (`node scripts/clean-scratch.mjs && npm run lint`): it clears the gitignored `.uts-computing/` test scratch so per-run temp dirs and fixtures don't accumulate, then runs the `lint-no-dup-lib-defs` guard (which fails if any module re-defines a name `src/lib/` already exports). Run `npm run clean:scratch` manually if you bypass `npm test` (e.g. `node --test mcp-server/tests/<layer>/<one>.test.mjs`, where `<layer>` is one of `core`/`lib`/`ops`/`integration`).

`npm run validate:plugin` checks that:

- the Claude manifest uses plugin-root-relative `./skills/` and `./.mcp.json`;
- the `.claude-plugin/` directory contains only `plugin.json` and `marketplace.json`;
- `.mcp.json` launches `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js` through `node`, and its env config path is plugin-root-relative (not absolute or parent-traversing);
- all shared Skills have `name` and `description` frontmatter;
- optional `skills/*/agents/openai.yaml` files contain only display/prompt metadata;
- every `skills/<name>` is mirrored under `.agents/skills/<name>` (so Codex and other agents can discover it);
- the built MCP entrypoint exists before plugin testing;
- the host-neutral smoke script, client-smoke prompt script, client-smoke evidence validator, and evidence schema are present.

`npm run smoke:plugin:host-neutral` performs a direct MCP stdio plugin smoke test by reading `.mcp.json`, launching the shared stdio MCP server from that configuration, listing core tools/resources/prompts, running `profiles.list`, `templates.list`, `state.migrate.plan`, fetching one safe prompt, and rendering one dry-run `jobs.plan`. It always uses `profiles/profiles.example.yaml` only for that child process and does not modify plugin manifests.

## Local Profiles

Create a local profile file that is not committed:

```sh
cp profiles/profiles.example.yaml profiles/profiles.local.yaml
```

Edit `profiles/profiles.local.yaml` with local profile ids and SSH host aliases. Do not store passwords, private keys, MFA secrets, tokens, or cleartext credentials.

## Codex

Codex does not use a plugin wrapper. It consumes the package through standards:

1. **MCP server** — register the shared stdio server (absolute path is CWD-independent and avoids Codex's undocumented `${VAR}` substitution in MCP config):

   ```sh
   codex mcp add uts-compute -- node "$(pwd)/mcp-server/dist/index.js"
   ```

   or the `~/.codex/config.toml` equivalent:

   ```toml
   [mcp_servers.uts-compute]
   command = "node"
   args = ["/absolute/path/to/mcp-server/dist/index.js"]
   [mcp_servers.uts-compute.env]
   UTS_COMPUTING_CONFIG = "profiles/profiles.local.yaml"
   ```

   (The server resolves a relative `UTS_COMPUTING_CONFIG` against its own location, so the relative form is safe.)

2. **Skills** — Codex auto-discovers `SKILL.md` folders from `.agents/skills/`. Opening the repo root as a Codex project surfaces the 14 mirrored Skills with no manifest; to use them globally, symlink them under `~/.agents/skills/`.

See [ADR 0005](adr/0005-standards-first-distribution.md) for why Codex gets no plugin wrapper.

## Claude Code

Claude Code should load the plugin from the repository root and read `.claude-plugin/plugin.json`. The Claude manifest is a thin wrapper around shared `skills/` and the Claude MCP config `./.mcp.json`, which launches `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js`.

## Smoke Test

Before installation in either client, run the host-neutral direct MCP stdio smoke:

```sh
npm run smoke:plugin:host-neutral
```

This smoke always uses `profiles/profiles.example.yaml` in a temporary plugin root. It must not read `profiles/profiles.local.yaml`.

Then generate fixed prompts for real installed-client smoke evidence:

```sh
npm run client-smoke:prompt
```

Inside each installed client, use the generated prompt to confirm:

1. confirm the UTS Skills are discoverable;
2. call `profiles.list` and check that host aliases and secret refs are redacted;
3. call `templates.list`;
4. read `uts://docs/schema-migration-plan` or the local `docs/schema-migration-plan.md`;
5. call `state.migrate.plan` and confirm it reports `mode: "dry-run"` plus `writes_planned: false`;
6. run a dry-run `jobs.plan` using `examples/jobs/hpc-cpu.json`;
7. do not run live `access.check`, `quotas.refresh`, `jobs.submit`, `artifacts.fetch`, `transfers.execute`, or `state.migrate.apply` until VPN, profiles, approval policy, and migration rollback expectations are deliberately configured.

Validate the completed evidence files:

```sh
npm run client-smoke:validate -- --require-both evidence/codex.json evidence/claude-code.json
```

Direct MCP stdio smoke output is not valid Codex or Claude Code installed-client evidence.

## Release Boundary

Before sharing this plugin:

- keep `.claude-plugin/` thin (only `plugin.json` + `marketplace.json`) and `.agents/skills/` as symlinks to `skills/`;
- commit source, schemas, templates, docs, and Skills;
- do not commit `.uts-computing/`, `profiles/profiles.local.yaml`, credentials, generated evidence, or fetched artifacts;
- run the full validation commands above.
