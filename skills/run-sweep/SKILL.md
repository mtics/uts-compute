---
name: run-sweep
description: Run a hyperparameter sweep on UTS HPC end-to-end — expand a parameter grid into one PBS array job sized to live capacity, submit it, watch the array reconcile, and summarize/rank the metrics. Use when the user says sweep over, grid search, try these configs, or run a hyperparameter search on UTS HPC.
---

# Run a UTS Hyperparameter Sweep (end-to-end)

The sweep orchestrator: a grid becomes one PBS array job (a single `plan_hash`) whose concurrency is auto-fitted to the account's live run headroom, then submitted, watched, and summarized. UTS HPC CPU arrays only.

## Workflow

1. **Capacity first.** `quotas.refresh` for a fresh snapshot, then `quotas.capacity` to see the target queue's per-user run headroom — this is how many array elements can run at once.
2. **Plan the array.** `sweep.plan` with the base command's `{param}` placeholders and the parameter grid. **Pass the fresh `snapshotId`** so `max_concurrent` is automatically capped to the live run headroom (it only lowers, never raises). The result is one `plan_hash` plus the deterministic index→params table.
3. **Authorize + submit.** Tier-A autonomous when the array conforms to the quota envelope, otherwise `review-approvals`; then `jobs.submit`.
4. **Watch the array.** `jobs.track` (filtered by this run/project) reconciles the array's live state in one sweep; `jobs.status` for the aggregate.
5. **Collect.** When elements finish: `artifacts.list` → `artifacts.fetch.batch` (approved, checksum-verified) → `artifacts.summarize` to extract each member's metric.
6. **Rank.** Feed the per-index metric values to `sweep.rank` (with the original `parameters` grid + `mode` min/max) to join them back to configs and get the top-k winners.
7. **Re-run failed members.** If some array elements failed (or the whole array did), re-run with `sweep.retry.plan` — it mints a fresh `run_id` + retry lineage + new `plan_hash` covering **only** the failed members, then `jobs.submit`. The original (terminal) run cannot be re-submitted directly: `jobs.submit` accepts only `planned` runs and refuses a `failed`/`cancelled` one, so do **NOT** hand-reset a run to `planned`. See the `triage-and-retry` Skill for the diagnose-then-retry decision. (For a single non-array job, use `jobs.retry.plan`.)
8. **Optional successive-halving by hand.** Plan a follow-up `sweep.plan` running only those top-k configs at a higher budget. Do not auto-cancel running members — that is an irreversible op needing the human token via `jobs.cancel`.

## When the request doesn't fit (GPU sweep / iHPC sweep)

`sweep.plan` only emits a **CPU PBS array**. When the request falls outside that, don't dead-end — redirect:

- **GPU hyperparameter search.** There is no GPU array path. Submit each config as an individual GPU job via `run-experiment` (or `hpc-submit-pbs`), looping the grid yourself and keeping the number of concurrent submissions within the GPU queue's per-user `max_run` from `quotas.capacity`. Then collect each run's metric and rank with `sweep.rank` exactly as for an array. Tell the user this is N separate jobs, not one array, so cancel/retry is per-run.
- **iHPC sweep.** iHPC has no array/batch primitive. For a *small* search (a handful of configs), run them as individual supervised runs via `ihpc-run-background`, one at a time, respecting the active node session limits, then `analyze-artifacts` + `sweep.rank` over the collected metrics. For anything larger than a handful, recommend moving the sweep to UTS HPC.

## Guardrails

UTS HPC CPU arrays only — no GPU arrays. Size concurrency to `quotas.capacity`; never request beyond the per-user `max_run`. Do not auto-cancel running array elements mid-flight — that is an irreversible op needing the human token via `jobs.cancel` (use `triage-and-retry` for a deliberate cancel). Sweep values are safety-validated; do not bypass `sweep.plan` to build a `case ${PBS_ARRAY_INDEX}` by hand.

## References

- `skills/run-experiment/SKILL.md` for the shared authorize/submit/verify steps.
- `skills/analyze-artifacts/SKILL.md` for the collect-and-summarize sub-steps.
- `skills/triage-and-retry/SKILL.md` for diagnosing failed members and the `sweep.retry.plan` / `jobs.retry.plan` re-run flow.
