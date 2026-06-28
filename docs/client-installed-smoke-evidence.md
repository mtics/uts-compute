# Client-Installed Smoke Evidence

This release gate captures proof that the shared plugin works inside real Codex and Claude Code hosts.

It is separate from `npm run smoke:plugin:host-neutral`. The host-neutral smoke launches the packaged MCP server directly over stdio from a temporary plugin root. Client-installed smoke must be observed inside the actual client after the plugin is installed.

## Commands

Generate fixed prompts and evidence templates:

```sh
npm run client-smoke:prompt
```

Generate a prompt for one client:

```sh
npm run client-smoke:prompt -- --client codex --out evidence/codex-prompt.json
npm run client-smoke:prompt -- --client claude-code --out evidence/claude-code-prompt.json
```

Validate completed evidence files:

```sh
npm run client-smoke:validate -- --require-both evidence/codex.json evidence/claude-code.json
```

The validator also checks the current plugin package, including the Claude plugin manifest, `.mcp.json`, shared Skills, the `.agents/skills/` mirror, the built MCP entrypoint, the host-neutral smoke script, and the client-smoke evidence schema/scripts.

Do not commit evidence files unless a separate release process explicitly asks for redacted release artifacts.

## Required Client Checks

Each client evidence file must confirm:

- the UTS Skills are discoverable in the installed client;
- the shared MCP server is visible through the installed plugin;
- core tools include `profiles.list`, `templates.list`, `state.migrate.plan`, and `jobs.plan`;
- core resources include `profiles`, `templates`, and `docs`;
- `profiles.list` returns at least one redacted profile summary without host aliases or secret refs;
- `templates.list` includes `pbs-cpu`;
- docs context can be read from `uts://docs/schema-migration-plan`, `docs.search`, or local docs;
- `state.migrate.plan` returns `mode: "dry-run"`, `writes_planned: false`, and a 64-character hex `plan_hash`;
- `jobs.plan` renders a dry-run plan from `examples/jobs/hpc-cpu.json` with a `client-smoke-*` run id and a 64-character hex `plan_hash`.

## Forbidden During This Smoke

Do not call:

- `access.check`;
- `quotas.refresh`;
- `docs.refresh`;
- `jobs.submit`, `jobs.status`, `jobs.logs`, or `jobs.cancel`;
- `artifacts.fetch`, `artifacts.fetch.batch`, or `artifacts.cleanup.execute`;
- `transfers.execute`;
- `state.migrate.apply`;
- `approvals.decide`.

Do not run direct shell, SSH, PBS, iHPC, rsync, curl, VPN probes, or UTS remote commands as substitutes for MCP tools.

Do not include real profile configuration, account identifiers, host aliases, credentials, tokens, private keys, absolute local paths, raw scripts, stdout/stderr dumps, fetched artifacts, or local `.uts-computing` contents in evidence.

## Evidence Shape

Evidence must match `schemas/client-smoke-evidence.schema.json`.

One file corresponds to one client-installed smoke run. The release gate requires one `client: "codex"` file and one `client: "claude-code"` file, each recording its `install_method` (ADR 0005):

- the Claude Code file uses `install_method: "plugin"` and references `.claude-plugin/plugin.json`, `./.mcp.json`, `skills_path: "./skills/"`, and the `${CLAUDE_PLUGIN_ROOT}` launch arg;
- the Codex file uses `install_method: "mcp-config"`, records `mcp_registration` (e.g. `codex mcp add …`), `skills_path: ".agents/skills/"`, and an absolute `node …/mcp-server/dist/index.js` launch arg (no plugin-root variable).

Both confirm the same shared MCP server and the same 15 Skills.

The evidence is intentionally a structured summary, not a transcript. It records booleans, counts, ids, dry-run modes, and hashes only.

Generated templates contain placeholder hashes and run ids. They are prompts for data entry, not passing evidence. The validator rejects unfilled placeholders such as all-zero `plan_hash` values or `client-smoke-*-replace-me` run ids.
