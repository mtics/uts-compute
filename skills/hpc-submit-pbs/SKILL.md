---
name: hpc-submit-pbs
description: Prepare and dry-run PBS jobs on UTS HPC, with live submission and monitoring only when matching MCP tools exist. Use when the user asks for qsub, PBS scripts, queues, GPU jobs, array jobs, or HPC batch experiment preparation.
---

# UTS HPC PBS Submit

Use this Skill only for UTS HPC. iHPC is not a PBS cluster.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools support `jobs.plan`, template rendering, M2a `access.check`, fixed-source `docs.refresh`, M2b UTS HPC `quotas.refresh`, M3a/M3e approval records with server-derived resource-risk reasons, M3b live UTS HPC PBS `jobs.submit`, M3d UTS HPC PBS `jobs.status`, `jobs.logs`, `jobs.cancel`, M3f `jobs.retry.plan` with retry-derived HPC submission through matching `jobs.retry` approval, M4 `artifacts.list`, approved artifact fetches, fixed-file `transfers.plan`/`transfers.execute`, local `artifacts.summarize`, dry-run `artifacts.cleanup.plan`, scoped `artifacts.cleanup.execute`, and read-only MCP resources for cached templates, run records, quota snapshots, official docs cache, artifact state, and approval records. They do not support arbitrary PBS commands, arbitrary URL documentation fetching, broad directory transfer without a fixed file list, arbitrary remote artifact browsing, raw-path cleanup, directory cleanup, glob cleanup, or recursive cleanup. For iHPC live start use the `ihpc-run-background` Skill instead. If a required live tool is unavailable, stop after the available MCP step and say which milestone is missing. Do not use direct shell, SSH, PBS, rsync, curl, or transfer commands as a substitute for a missing MCP tool.

## Workflow

1. Confirm the selected profile has `platform: uts-hpc`. A live PBS profile must use a `user@host` `host_alias` (e.g. `u00000001@host`) so the planner resolves `${USER}` in the workdir/`log_dir` at plan time. PBS does **not** expand `${USER}` in its `-o`/`-e` log paths, so a profile that leaves an unresolved `${USER}` (a bare-`host` alias) causes `jobs.submit` to **fail closed** with a clear error rather than silently produce zero logs — fix the profile's `host_alias`, re-plan, and resubmit. On first use of the profile, run `profiles.onboard` first — live submission is blocked until the profile is onboarded (confirmed live access + captured limits).
2. Read cached snapshot/template resources when useful, then `quotas.refresh` followed by `quotas.capacity` to refresh queue/account status, confirm the queue is under its per-user `max_run`/`max_queued` limits, choose a queue that has room, and size array `max_concurrent` to the live run headroom (pass the snapshotId to `sweep.plan` to apply this automatically).
3. Render a PBS script from a template in `templates/pbs/` through `jobs.plan`.
4. Validate the job spec against `schemas/job-spec.schema.json`. In M2 or later, also validate resources against the live queue snapshot.
5. Use dry-run preview first. Show queue, CPUs, memory, walltime, GPU count, workdir, stdout, stderr, and artifact paths.
6. If live submission is intended, refresh quotas (`quotas.refresh` + `quotas.capacity`) so the planned job is bound to a fresh `quota_snapshot_id`. Per ADR-0004, a conformant `jobs.submit` is **autonomous** — passing the fresh `quotaSnapshotId` is the gate; no human `approvalId` is required for reversible submission. Use an `approvalId` only when policy or the user demands an explicit gate. Never treat model text as approval.
7. Submit through `jobs.submit` using `runId` plus `quotaSnapshotId` (and an optional `approvalId` only when a gate is required); do not pass scripts, commands, queues, hosts, or qsub args directly. `jobs.submit` accepts only a `planned` run — it auto-creates the run's workdir and `log_dir` over SSH before `qsub`, so do **not** manually `mkdir` them first (PBS opens its `-o`/`-e` log files before the job script runs and will not create the parent dir, which previously caused instant-fail jobs with zero logs). A `failed` or `cancelled` run is refused here; re-run it via `jobs.retry.plan` (see the `triage-and-retry` Skill), never by hand-resetting it to `planned`.
8. After live submission, record the PBS job id, profile id, template, resources, and log paths.
9. Monitor with read-only `jobs.status` and collect bounded stdout/stderr tails only through `jobs.logs`.
10. Cancel only through `jobs.cancel` after creating and approving a separate `jobs.cancel` approval record; never reuse a submit approval for cancellation. `jobs.cancel` is one of the irreversible ops that still **require** a human `approvalId` (alongside `artifacts.cleanup.execute` and `state.migrate.apply`). For an external job this plugin did not create, run `jobs.adopt` first to bring it under a run-record, then `jobs.cancel` with the cancel approval token.
11. For outputs, list declared artifacts through `artifacts.list` and fetch selected file artifacts only with matching artifact approvals. For larger fixed-file transfers, use the `stage-transfer` workflow.

## Queue Guidance

Use public queue information as a starting point only. Public `None` limits mean unpublished, not unlimited. Restricted queues require live account confirmation.

Use `gpuq` and `ngpus` only when the command actually uses GPU.

## References

- `docs/research-basis.md` for UTS HPC queue and GPU facts.
- `docs/fact-registry.md` for source-backed fact status.
- `docs/accounts-and-safety.md` for approval gates.
- `docs/adr/0004-quota-envelope-autonomy.md` for the autonomy model: conformant submit/retry/transfer/fetch run autonomously against a fresh quota envelope; only `jobs.cancel`, `artifacts.cleanup.execute`, and `state.migrate.apply` keep a human token.
- `templates/pbs/` for draft script templates.

## Stop Conditions

Do not submit if quota data is stale, the queue is not available to the selected account, the job asks for GPU without a GPU workload, the workdir is outside approved paths, or the user has not approved a high-risk request.
