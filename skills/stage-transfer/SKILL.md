---
name: stage-transfer
description: Plan and execute fixed-file UTS data transfers through the shared MCP server. Use when the user needs to stage datasets or download larger run outputs and the transfer is too large for manifest artifact fetch.
---

# Stage a UTS Transfer

Use this Skill for larger fixed-file transfers. It is not a generic rsync or remote browsing workflow.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools support `transfers.plan` for saved transfer plans, `transfers.execute` for approved fixed-file rsync execution, sanitized transfer resources such as `uts://transfers/{runId}/state`, `state.migrate.plan` for local state compatibility checks, and `state.migrate.apply` for confirmed additive schema-version migrations. Execution accepts only `runId`, `approvalId`, and timeout; the MCP server reads the saved plan, verifies `plan_hash`, checks an operation-specific `transfers.execute` approval, preflights the exact file list, verifies helper metadata against the saved file order, byte accounting, and checksum policy, consumes approval, and runs fixed rsync argv with `--files-from=-`. For checksum-eligible files at or below the server fixed transfer checksum cap, downloads verify remote preflight SHA-256 against the local destination after rsync, and uploads verify local preflight SHA-256 against a fixed remote post-check helper. Oversized files record `checksum_status: "skipped-large"` plus `checksum_policy` and are not content-hash verified. Downloads also verify local destination files after rsync success and before writing execution evidence. The implementation does not support user-supplied rsync flags, arbitrary SSH options, `--delete`, `--remove-source-files`, arbitrary checksum commands, arbitrary local destinations, broad directory recursion without a fixed list, or remote cleanup.

## Workflow

1. Identify the selected profile, transfer direction, source root, destination root, exact relative file list, and total byte budget.
2. Use `quotas.refresh` first when storage or account context may be stale. If saved transfer state appears schema-incompatible, run `state.migrate.plan` and stop on blockers.
3. Call `transfers.plan` with explicit `files` and `max_total_bytes`.
4. Request a `transfers.execute` approval bound to the saved `plan_hash` and a fresh `quota_snapshot_id`. The approval `resource_summary` must include direction, source, destination, ordered files, and `max_total_bytes`.
5. Execute only with `transfers.execute` using `runId` and `approvalId`.
6. Read `uts://transfers/{runId}/state` for sanitized post-execution context when available; do not open raw transfer state files directly.
7. Preserve the execution evidence path and report transferred file count, total bytes, source/destination policy, `checksum_status`/SHA-256 where present, `skipped-large` limits where present, and anything not attempted. If execution fails after rsync because download verification, upload remote post-check, or checksum comparison failed, report that no successful execution evidence was written and do not reuse the consumed approval.

## Guardrails

Do not call direct shell, SSH, or rsync. Do not transfer paths outside profile workspace/scratch/project roots. Do not invent file lists from globs. Do not use this Skill for cleanup or deletion.

## References

- `docs/accounts-and-safety.md`
- `docs/architecture.md`
- `docs/validation-checklist.md`
- `schemas/transfer-plan.schema.json`
