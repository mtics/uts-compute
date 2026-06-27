# AGENTS.md

This project builds a cross-client agent package for UTS HPC and UTS iHPC.

Use these project rules:

- Treat `docs/fact-registry.md` and `docs/research-basis.md` as the source of truth for platform facts and verification status.
- Treat `docs/accounts-and-safety.md` as mandatory policy for multi-account usage, quotas, approvals, and destructive operations.
- Keep Skills concise. Put detailed platform facts in `docs/` or future MCP resources instead of duplicating them in every `SKILL.md`.
- Put real execution behind the MCP server. Do not add generic unrestricted remote shell tools.
- Never store secrets in repo files. Profiles may reference SSH config aliases, keychain entries, or environment variable names only.
- When adding implementation code, keep UTS HPC and UTS iHPC behind platform adapters.

When changing files, preserve compatibility with both Codex and Claude Code unless a document explicitly scopes the change to one client.
