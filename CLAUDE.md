# CLAUDE.md

This repository is a shared UTS computing platform package for Claude Code and Codex.

Read first:

1. `docs/README.md`
2. `docs/architecture.md`
3. `docs/accounts-and-safety.md`
4. `docs/implementation-plan.md`

Claude Code should use the same shared assets as Codex:

- Skills under `skills/`
- MCP server under `mcp-server/`
- schemas under `schemas/`
- templates under `templates/`
- local profile examples under `profiles/`

Do not add Claude-only behavior unless it is isolated in `.claude-plugin/` or Claude-specific docs. The core implementation should remain client-neutral.

Secrets policy:

- Do not commit passwords, private keys, MFA secrets, access tokens, or real account identifiers.
- Use `profiles/profiles.example.yaml` as a shape example only.
- Keep real profile files untracked, for example `profiles/profiles.local.yaml`.
