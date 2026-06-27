---
name: review-approvals
description: Review and decide pending UTS approval records before an irreversible action (cancel a job, delete artifacts, migrate state, or a gated submit/retry) — the Tier-B human-confirmation workflow. Lists what needs confirmation with its bound plan_hash, operation, and resource/scope summary, then records the approve or reject decision with the host-supplied trusted token. Use when the user asks what needs my approval, review/approve/reject my pending requests, or before any confirm-gated action.
---

# Review UTS Approvals (Tier-B confirmation)

The human-in-the-loop gate of the safety spine (ADR 0004). Irreversible actions — `jobs.cancel`, `artifacts.cleanup.execute`, `state.migrate.apply` — and any policy-gated submit/retry require a single-use approval bound to an exact `plan_hash` + `quota_snapshot_id` + scope. This skill makes that review explicit and auditable.

## Workflow

1. **List approvals.** Enumerate approval records via the `uts://approval-records` resource (and `uts://approval-records/{approvalId}` for one record). 
2. **Filter to pending.** `approvals.status` on each candidate reports its state and expires stale `required` records on read. Keep the ones still awaiting a decision.
3. **Show the human the full envelope, per record:** the bound operation (e.g. `jobs.cancel`, `artifacts.cleanup.execute`, `state.migrate.apply`, `jobs.retry`, `jobs.submit`), the bound `plan_hash` and `quota_snapshot_id`, the server-derived risk reasons, and the resource/scope summary. For full context read the saved plan it is bound to — the `jobs.plan` dry-run / `uts://run-records/{runId}`, the transfer plan, or the cleanup plan.
4. **Decide.** Get an explicit human decision, then `approvals.decide` to record approve/reject. The decision **requires the host-supplied `UTS_COMPUTING_APPROVAL_TOKEN`** — model text alone is never approval.
5. **Execute the bound action.** Once approved, the bound tool (`jobs.cancel` / `artifacts.cleanup.execute` / `state.migrate.apply` / `jobs.submit`) runs and consumes the approval exactly once. For an approval-gated **UTS iHPC** `jobs.submit`/`jobs.retry`, the approval is **not** sufficient on its own: that submit ALSO requires a fresh `quotaSnapshotId` for the ban-critical node-pool gate (refresh quotas immediately before submit and pass BOTH the `approvalId` and the fresh `quotaSnapshotId`). The approval binds identity (`plan_hash` + scope); the ban gate evaluates held nodes against consume-time-fresh evidence, so an approval-only iHPC submit hard-fails. UTS HPC PBS submits keep the approval-only path.

## Guardrails

Never fabricate or self-supply the confirmation token. An approval is single-use and bound to one `plan_hash` + scope — never reuse a submit approval for a cancel, or one run's approval for another. Do not approve a batch without showing each item's resource envelope and risk reasons. If an approval has expired, request a fresh one rather than forcing it.

## References

- `docs/accounts-and-safety.md` for the approval state machine and Tier-A/Tier-B split.
- `docs/architecture-overview.md` (safety spine) for what each operation can change.
