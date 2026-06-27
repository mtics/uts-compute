---
name: run-experiment
description: Take a UTS experiment all the way from intent to a verified running job — the end-to-end safe-submit recipe that composes onboarding, a capacity check, dry-run planning, authorization, live submission, and post-submit verification. Use when the user says run, submit, launch, or kick off an experiment/job on UTS HPC or iHPC and wants it actually started (not just planned).
---

# Run a UTS Experiment (end-to-end)

The orchestrator recipe that turns a planned experiment into a verified live run. It composes the single-step skills (`plan-experiment`, `select-profile`, `hpc-submit-pbs`, `ihpc-run-background`) and the safety tools into one repeatable flow. For a hyperparameter sweep use `run-sweep`; to reproduce a past run use `reproduce-run`.

## Workflow

1. **Select + onboard.** Use `select-profile` to pick exactly one profile. **On first use of that profile, run `profiles.onboard`** — it connects, confirms live access, and captures the account's limits. Live submission is blocked until a profile is onboarded.
2. **Plan (dry-run).** Use `plan-experiment` to produce a validated job spec, then `jobs.plan` to render the script and write a planned run-record with a deterministic `plan_hash`. Review the dry-run output (queue, resources, workdir, log paths) before going live.
3. **Check capacity.** `quotas.refresh` for a fresh snapshot, then `quotas.capacity` to confirm the queue is under its per-user limits and to size resources/parallelism to the live run headroom.
4. **Authorize.** Tier-A reversible submission is autonomous when it conforms to the fresh quota envelope (pass the `quota_snapshot_id`). When policy or the user requires an explicit gate, use the `review-approvals` flow: `approvals.request` then a human `approvals.decide` with the trusted token. Never self-approve as the model.
5. **Submit.** `jobs.submit` with `runId`. For **UTS HPC PBS**, pass `approvalId` or `quotaSnapshotId` (either gates the submit). For **UTS iHPC**, a fresh `quotaSnapshotId` is **ALWAYS required** (the ban-critical node-pool gate reads consume-time-fresh held-node evidence) — refresh quotas immediately before submit (`quotas.refresh` → use the returned `snapshot_id`); if the submit is also approval-gated, pass **BOTH** the `approvalId` AND the fresh `quotaSnapshotId` (the iHPC `approvalId` never substitutes for the snapshot — an approval-only iHPC submit hard-fails). Never pass scripts, commands, queues, hosts, or qsub args directly — only the saved plan is submitted.
6. **Verify.** Immediately call `jobs.status` to confirm the job is queued/running and the `remote_job_id` was captured. **Do not report success without this verification step.** The run is auto-grouped by its git-derived project and its submission context (account/cluster/queue/node/requested) is frozen into the run-record.
7. **Hand off monitoring.** Note the `run_id`; track it later with `fleet-status` (many runs) or `monitor-and-recover` (one run that needs attention).

## Guardrails

Do not submit live work until the profile is onboarded and has a fresh quota snapshot. Do not exceed the `quotas.capacity` run headroom. Do not self-approve; the confirmation token comes from the host, never from model text. Do not use direct shell, SSH, PBS, iHPC, rsync, or qsub as a substitute for these MCP tools.

## References

- `skills/plan-experiment/SKILL.md`, `skills/select-profile/SKILL.md` for the planning sub-steps.
- `docs/accounts-and-safety.md` for the approval/autonomy policy (ADR 0004).
- `docs/architecture-overview.md` for the safety-gated lifecycle.
