# Skills

These Skills are shared by Codex and Claude Code. They describe workflow and policy, not direct remote execution. This list is the canonical skill roster; other docs (e.g. `docs/architecture-overview.md`, `docs/architecture.md`) should reference it rather than re-list skills.

Skills (14):

Single-step building blocks:

- `plan-experiment`
- `select-profile`
- `hpc-submit-pbs`
- `ihpc-run-background`
- `monitor-and-recover`
- `analyze-artifacts`
- `stage-transfer`

End-to-end orchestrators (compose the building blocks):

- `run-experiment`
- `run-sweep`
- `triage-and-retry`
- `review-approvals`
- `reproduce-run`
- `fleet-status`

Standalone responder:

- `confirm-usage`

When a Skill needs detailed platform facts, use `docs.search` to locate the relevant local documentation snippet, then load the relevant `uts://docs/{docId}` resource or project `docs/` file instead of duplicating long rules in `SKILL.md`. When current official UTS documentation evidence matters and the local VPN is available, use `docs.refresh` only for its fixed source ids, then read `uts://docs-cache/{sourceId}`. Skills must not run direct `curl`, browser scraping, SSH, PBS, iHPC, or rsync commands as substitutes for MCP tools. (One carve-out: first-run **provisioning** — repo clone, Python-env creation, dataset staging onto a clean node — is out of plugin scope and may be done manually out-of-band; it is a documented prerequisite, not a tool being bypassed. See [docs/accounts-and-safety.md](../docs/accounts-and-safety.md).)

If local `.uts-computing` state appears schema-incompatible or unexpectedly old, read `docs/schema-migration-plan.md` and run `state.migrate.plan` first. Apply only through `state.migrate.apply` with a matching plan hash and trusted confirmation token; Skills must not hand-edit runtime state.
