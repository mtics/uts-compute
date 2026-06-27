---
name: triage-and-retry
description: Diagnose a failed, stalled, or wrongly-behaving UTS run and decide a safe retry strategy — classify the failure, branch on its class (wait, fix access, retry with adjusted resources, switch profile, or abandon), then prepare and submit an approved retry. Use when the user says my job failed or crashed, why did it fail, should I retry, or my run is stuck.
---

# Triage and Retry a UTS Run

Closes the gap between diagnosis and action. It reads the failure, classifies it, and chooses a retry strategy that fits the cause — because resubmitting an unchanged spec rarely fixes anything, and a bigger node never fixes a code bug.

## Workflow

1. **Identify** the failed `run_id`, profile, and platform (from `jobs.history` or the user).
2. **Gather evidence.** `jobs.status` for the terminal state, then `jobs.logs` for a bounded stdout/stderr tail. For finished PBS runs, `jobs.usage` shows whether it died near a resource ceiling.
3. **Classify.** `jobs.diagnose` returns the failure class and a safe next action.
4. **Branch on the class:**
   - **access / VPN** → `access.check` / `access.doctor`; fix connectivity. Do **not** retry blindly.
   - **quota** → `quotas.refresh` + `quotas.capacity`; wait for run headroom or switch to another onboarded profile.
   - **resource under-request** → first check `jobs.rightsize` (requested-vs-used resource advice across the project's finished runs) for a data-driven target, then retry with escalated resources: `jobs.retry.plan` with `escalate` (memory_factor / walltime_factor, 1–4×; the submit-time conformance gate still caps it at the queue's `resources_max`).
   - **session-timeout** → escalate walltime and, if the source spec declares a `resumable { checkpoint_path, resume_flag }` contract, pass `resume: true` so the retry continues from its checkpoint instead of restarting.
   - **environment / command / data-path** → **stop and surface to the human.** These are bugs/config issues; a retry with more resources will fail the same way.
5. **Prepare the retry** (only when warranted): `jobs.retry.plan` (writes a **new** `run_id` + `jobs.retry` lineage and a fresh `plan_hash`) → a fresh `quotas.refresh` → `jobs.submit`. A `failed` or `cancelled` run **cannot** be re-submitted directly — `jobs.submit` accepts only `planned` runs and refuses a terminal one, so `jobs.retry.plan` is the supported re-run path (for a PBS-array sweep, use `sweep.retry.plan`, which re-plans only the failed array members). Do **NOT** hand-reset a run to `planned` to force a resubmit; mint a fresh retry plan instead. Per ADR-0004, the retry start is **autonomous** when it conforms to the fresh quota envelope: pass the `quotaSnapshotId` and conformance is the gate — no human `approvals.request`/`approvals.decide` round-trip is required for a reversible retry. Use the `review-approvals` flow only when policy or the user demands an explicit gate. **On UTS iHPC the fresh `quotaSnapshotId` is mandatory regardless** (it is the ban-critical node-pool gate, read from consume-time-fresh held-node evidence) — refresh quotas immediately before the retry submit; if the retry is also approval-gated, pass **BOTH** the `jobs.retry` `approvalId` AND the fresh `quotaSnapshotId` (an approval-only iHPC retry submit hard-fails, because the approval's bound snapshot may be up to 24h stale). For UTS HPC PBS the approval-only retry path is unchanged.
6. **Verify** with `jobs.status`; track further with `fleet-status` or `monitor-and-recover`.

## Guardrails

Do not retry environment/command/data-path failures by simply resubmitting. Do not escalate resources beyond the live quota envelope — the submit-time conformance gate is the real bound. A conformant `jobs.retry` is autonomous under a fresh `quota_snapshot_id`; if you do use an explicit gate, never reuse a submit or cancel approval. `jobs.cancel`, `artifacts.cleanup.execute`, and `state.migrate.apply` still require a human approval token; for an external job, `jobs.adopt` it first, then `jobs.cancel` with that token. Bound the number of automatic retries; if two retries fail the same way, stop and surface. Do not use direct shell, SSH, PBS, or rsync to inspect or restart a job.

## References

- `skills/monitor-and-recover/SKILL.md` for deeper recovery options and stop conditions.
- `docs/failure-playbooks.md` for per-class safe triage steps.
- `docs/adr/0004-quota-envelope-autonomy.md` for the autonomy model: conformant retry/submit/transfer/fetch run autonomously against a fresh quota envelope; only `jobs.cancel`, `artifacts.cleanup.execute`, and `state.migrate.apply` keep a human token.
