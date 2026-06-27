---
name: plan-experiment
description: Plan experiments for UTS HPC or UTS iHPC before any compute work is submitted. Use when the user asks to run, schedule, benchmark, sweep, reproduce, or prepare an experiment on UTS research computing, especially when platform choice, account profile, resource estimates, quota checks, artifacts, or safety approvals are needed.
---

# Plan a UTS Experiment

Use this Skill before live compute actions.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools support local dry-run planning with deterministic `plan_hash`, M2a `access.check`, read-only `docs.search` over allowlisted local docs, fixed-source official docs cache refresh with `docs.refresh`, `quotas.refresh` for UTS HPC and UTS iHPC profiles, M3a/M3e approval records with server-derived risk reasons, M3b UTS HPC PBS `jobs.submit`, M3c UTS iHPC supervised start through `jobs.submit`, M3d UTS HPC PBS and UTS iHPC supervised-run `jobs.status`, `jobs.logs`, `jobs.cancel`, M3f `jobs.retry.plan` with UTS HPC retry submission and UTS iHPC supervised retry start through matching `jobs.retry` approval, M4 `artifacts.list`, approved artifact fetches, fixed-file `transfers.plan`/`transfers.execute`, local `artifacts.summarize`, dry-run `artifacts.cleanup.plan`, scoped `artifacts.cleanup.execute`, and read-only MCP resources for profiles, templates, quota snapshots, run records, local docs, fixed-source docs cache, artifact state, and approval records. Resource reads are cached/local context only; use `quotas.refresh` when live account limits matter. If the plan requires arbitrary remote artifact browsing, arbitrary URL documentation fetching, arbitrary log/text artifact summarization, broad directory transfer without a fixed file list, raw-path cleanup, directory cleanup, glob cleanup, or recursive cleanup, stop and report which later milestone is needed. Do not use direct shell, SSH, PBS, iHPC, rsync, curl, or transfer commands as a substitute for a missing MCP tool.

## Workflow

1. Restate the experiment goal, expected command, inputs, outputs, and success metric.
2. Choose a platform:
   - UTS HPC for PBS batch jobs, larger sweeps, GPU batch jobs, and queued work.
   - UTS iHPC for interactive debugging, notebook-style work, short supervised sessions, and tasks that need interactive nodes.
3. Apply the `select-profile` workflow to choose exactly one profile. **On first use of a profile, run `profiles.onboard`** — it connects to the account, confirms live access, captures the resource-allocation limits, and records the onboarding marker. Live submission is blocked until a profile is onboarded.
4. Read `uts://profiles/{profileId}/quota-snapshot/latest` for cached context when useful. Use `access.check` if reachability matters. Before deciding resources and parallelism, `quotas.refresh` then `quotas.capacity` to see which queue has room, the per-queue run/queued headroom, and how many jobs you can run in parallel now (this also sizes a sweep's `max_concurrent`).
5. Produce a job spec with:
   - `profile_id`;
   - platform;
   - queue or iHPC node family;
   - `ncpus`, memory, walltime, and GPU count when applicable;
   - workdir, inputs, outputs, and artifact paths;
   - approval reasons.
6. Prefer dry-run rendering before submission. For a hyperparameter sweep over a UTS HPC CPU job, use `sweep.plan` with a base command containing `{param}` placeholders and a parameter grid; it expands to one PBS array plan (single `plan_hash`) plus the index->params table.
7. For live work, create or inspect an approval record bound to the exact `plan_hash` and fresh `quota_snapshot_id`; include `previousProfileId` when switching profiles after planning. Approval decisions require the trusted local confirmation path; do not self-approve as the model.
8. Plan outputs deliberately so `artifacts.list` can later derive artifact candidates from saved `workdir` plus declared `outputs`; avoid broad output directories unless they are genuinely needed.
9. Ask for explicit confirmation for GPU, long walltime, high memory, large arrays, cross-account changes, retries, artifact fetches, or large transfers.

## References

Read these when details are needed:

- `docs/research-basis.md` for platform facts.
- `docs/fact-registry.md` for source-backed fact status.
- `docs/accounts-and-safety.md` for account and approval policy.
- `docs/architecture.md` for MCP tool boundaries.
- `schemas/job-spec.schema.json` for the expected job spec shape.

## Guardrails

Do not infer missing quotas from public documentation. Do not distribute one experiment across multiple accounts unless the user explicitly approves a legitimate reason. Do not submit live work until the selected profile has been onboarded (`profiles.onboard`) and has a fresh quota snapshot. Size parallelism to the live `quotas.capacity` headroom rather than guessing; do not exceed the per-user `max_run` for the queue.
