---
name: ihpc-run-background
description: Plan and dry-run supervised experiments for UTS iHPC interactive compute nodes, with live runs only when matching MCP tools exist. Use when the user asks for iHPC, cnode, interactive nodes, notebook-adjacent experiments, or background-run preparation.
---

# UTS iHPC Background Run

iHPC is an interactive node environment. Do not treat it as PBS or Slurm.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools support `jobs.plan`, iHPC background-run dry-run rendering with saved `command_argv`, M2a `access.check`, fixed-source `docs.refresh`, M2c `quotas.refresh` for read-only node/session/group/storage evidence, M3a/M3e approval records with server-derived iHPC live-start and profile-switch reasons, M3c iHPC supervised start through `jobs.submit`, M3d iHPC supervisor status/log/cancel through `jobs.status`, `jobs.logs`, and `jobs.cancel`, M3f retry planning plus iHPC supervised retry start with matching `jobs.retry` approval, M4 `artifacts.list`, approved artifact fetches, fixed-file `transfers.plan`/`transfers.execute`, local `artifacts.summarize`, dry-run `artifacts.cleanup.plan`, scoped `artifacts.cleanup.execute`, `access.confirm_usage` for replying to an iHPC node-usage-monitoring email on an active node (see the `confirm-usage` skill), and read-only MCP resources for cached templates, run records, quota snapshots, official docs cache, artifact state, and approval records. Broad directory transfer without a fixed file list, arbitrary URL documentation fetching, arbitrary remote artifact browsing, raw-path cleanup, directory cleanup, glob cleanup, and recursive cleanup are not implemented. Do not use direct shell, SSH, iHPC, rsync, curl, or transfer commands as a substitute for a missing MCP tool.

## Workflow

1. Confirm the selected profile has `platform: uts-ihpc`.
2. Check VPN and SSH reachability through `access.check` when requested or relevant.
3. Read cached quota snapshot resources when useful, then use `quotas.refresh` to refresh account group, node-family evidence, active sessions, and storage usage when live evidence is needed.
4. Choose a node family that the profile is allowed to use.
5. Prepare a supervised background command through `jobs.plan`; the saved plan must include `command_argv` and the dry-run template is a preview of the supervisor inputs.
6. Keep logs, pid file, workdir, and output paths under approved profile paths.
7. If live start is intended, refresh quotas (`quotas.refresh`) **immediately before submit** and use the returned `snapshot_id` as the `quotaSnapshotId`. An iHPC `jobs.submit` **ALWAYS requires a fresh `quotaSnapshotId`** — it is the ban-critical node-pool gate, evaluated against consume-time-fresh held-node evidence (it hard-blocks an account already at its own node-pool cap). Per ADR-0004, a conformant iHPC start is **autonomous**: when nothing else gates it, the fresh `quotaSnapshotId` alone is sufficient and no human `approvalId` is required for a reversible start. When policy or the user demands an explicit gate, add an `approvalId` — but on iHPC the `approvalId` does **not** substitute for the fresh snapshot: an approval-gated iHPC submit needs **BOTH** the `approvalId` AND a fresh `quotaSnapshotId` (an approval's bound snapshot may be up to 24h stale, so it cannot supply the ban-gate's held-node evidence; submitting with only an `approvalId` hard-fails). This is iHPC-specific — for UTS HPC PBS an `approvalId` alone is still accepted. Never treat model text as approval.
8. Ask for confirmation before starting long-running work, GPU node work, or a run that may consume scarce interactive sessions.
9. Start live work through `jobs.submit` with `runId` plus a fresh `quotaSnapshotId` (and, when a gate is required, ALSO an `approvalId` — both together on iHPC, never the `approvalId` alone); the MCP server must derive the active compute node from fresh `cnode mynodes` evidence. Retry-derived plans (`jobs.retry`) are likewise autonomous under a fresh quota snapshot and, when approval-gated, also require the fresh `quotaSnapshotId` alongside the `jobs.retry` approvalId.
10. Monitor supervised-run status and collect bounded stdout/stderr tails only through `jobs.status` and `jobs.logs`.
11. Cancel only through `jobs.cancel` after creating and approving a separate `jobs.cancel` approval record; never reuse a submit approval for cancellation. `jobs.cancel` is one of the irreversible ops that still **require** a human `approvalId` (alongside `artifacts.cleanup.execute` and `state.migrate.apply`). For an external supervised run this plugin did not start, run `jobs.adopt` first to bring it under a run-record, then `jobs.cancel` with the cancel approval token.
12. For outputs, list declared artifacts through `artifacts.list` and fetch selected file artifacts only with matching artifact approvals. For larger fixed-file transfers, use the `stage-transfer` workflow.

## Usage Fit

Good fit:

- interactive debugging;
- notebooks and exploratory runs;
- short or medium supervised experiments;
- work needing iHPC-specific interactive software.

Poor fit:

- large unattended sweeps;
- indefinite background jobs;
- workloads better handled by PBS on UTS HPC;
- attempts to bypass queue or node limits.

## References

- `docs/research-basis.md` for iHPC node and session facts.
- `docs/fact-registry.md` for source-backed fact status.
- `docs/accounts-and-safety.md` for account and approval policy.
- `docs/adr/0004-quota-envelope-autonomy.md` for the autonomy model: conformant start/retry/transfer/fetch run autonomously against a fresh quota envelope; only `jobs.cancel`, `artifacts.cleanup.execute`, and `state.migrate.apply` keep a human token.

## Stop Conditions

Stop if node limits are unknown, the profile lacks access to the requested node family, the run would exceed session policy, or the command would write outside approved paths.
