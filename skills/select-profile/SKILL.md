---
name: select-profile
description: Select, validate, and justify one explicit UTS compute account profile. Use when multiple UTS HPC or UTS iHPC accounts are available, when switching accounts, when checking quotas, or before any job submission, iHPC run, transfer, cancellation, or artifact fetch tied to a specific account.
---

# Select a UTS Profile

Every live operation must use exactly one `profile_id`.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools support `profiles.list`, `profiles.validate`, M2a `access.check`, fixed-source `docs.refresh`, `quotas.refresh` for UTS HPC and UTS iHPC profiles, `state.migrate.plan` for local state compatibility checks, and read-only MCP resources such as `uts://profiles`, `uts://profiles/{profileId}/quota-snapshot/latest`, and `uts://docs-cache/{sourceId}`. Resource reads inspect local cached context only; use `quotas.refresh` when live account evidence is needed. Do not use direct shell, SSH, PBS, iHPC, curl, transfer commands, or hand edits to `.uts-computing` as a substitute for a missing MCP tool.

## Workflow

1. List available profiles through the MCP server resource/tool; prefer `uts://profiles` or `profiles.list`.
2. Match the profile to the experiment by platform, project, queue or node-family access, storage paths, and user request.
3. Validate the profile against `schemas/profile.schema.json`.
4. Use `access.check` when VPN or SSH reachability is relevant.
5. Use `quotas.refresh` when live queue, job, group, node, session, or storage evidence is needed.
   - UTS HPC: identity, groups, queues, running jobs, nodes, and storage.
   - UTS iHPC: identity, groups, node availability, sessions, and storage.
6. If cached local state appears schema-incompatible, run `state.migrate.plan` and report blockers before selecting a profile for live work.
7. State why the chosen profile is appropriate.
8. Ask for confirmation before switching profiles after a plan has already been prepared. When requesting approval for the switched plan, pass the original profile as `previousProfileId` so the approval record includes cross-account context.

## Multi-Account Policy

Use multiple accounts for authorization, project separation, and audit clarity. Do not use them as a combined quota pool or to bypass platform fair-use limits.

## References

- `docs/accounts-and-safety.md`
- `docs/fact-registry.md`
- `profiles/profiles.example.yaml`
- `schemas/profile.schema.json`

## Stop Conditions

Stop before live submission if the profile is invalid, stale, missing quota evidence, points to a secret value directly, or would require combining multiple accounts without explicit user approval.
