---
name: fleet-status
description: One-shot overview of all active and recent UTS runs across projects and accounts — a status plus resource-usage dashboard grouped by project, with a needs-attention list. Use when the user asks what is running, show all my jobs, fleet/dashboard status, usage across my projects, or wants a standup-style summary of their experiments.
---

# UTS Fleet Status

The cross-project, cross-account dashboard for a researcher juggling many runs. It reconciles live state once and rolls it up by project, so you see everything in flight and what needs attention in one pass. Read-only: the only local change is run-record status reconciliation.

## Workflow

1. **Reconcile live state once.** `jobs.track` (optionally filtered by `project` or `platform`) re-polls every active run that has a remote job id and reconciles each saved run-record to live scheduler/supervisor state in a single bounded sweep — each entry carries the node and a usage summary, and the result includes a `terminal_transitions` digest of runs that just crossed into finished/failed/cancelled (feed those straight to `triage-and-retry`).
2. **Roll up by project.** `projects.list` gives the per-project rollup: total and active run counts, status breakdown, the profiles and platforms each project spans, and last-updated time, most-active first.
3. **Add recent history.** `jobs.history` (filter by `status`, `since`, `project`) surfaces recently finished/failed runs for context.
4. **Usage accounting.** `jobs.usage` for finished/running PBS runs of interest reports core-hours, GPU-hours, and CPU efficiency (null for iHPC).
5. **Optional headroom.** Per onboarded profile, `quotas.refresh` then `quotas.capacity` shows remaining run headroom for planning the next batch.
6. **Present** a compact table — project → run_id → status → node → usage → cluster/account — followed by the per-project rollup and a **needs-attention list**: failed runs, stalled runs (running far past expected walltime), and low-CPU-efficiency runs worth investigating.

## Guardrails

This skill is read-only. Do not cancel, retry, or clean up from here — hand a flagged run to `triage-and-retry` or `monitor-and-recover`, where the action goes through an explicit approval. Do not use direct shell, SSH, PBS, or `qstat` to poll jobs; use `jobs.track` / `jobs.status`.

## References

- `skills/triage-and-retry/SKILL.md` for acting on a flagged run.
- `docs/architecture-overview.md` (monitor phase) for the tools involved.
