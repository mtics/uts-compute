---
name: reproduce-run
description: Reproduce or re-run a past UTS run — same profile, template, resources, and git context — optionally tweaking one parameter before resubmitting, honoring the recorded git sha/branch and reproducibility metadata. Use when the user says rerun that experiment, reproduce run X, run it again, or same job but with a changed hyperparameter.
---

# Reproduce a UTS Run

First-class reproducibility for paper-grade auditability. A reproduction is always a NEW run with its own `plan_hash` — it never resubmits the old plan — but it carries the original's profile, resources, git lineage, and project so the result is traceable.

## Workflow

1. **Find the source run.** `jobs.history` (filter by `project`) to locate it, then read `uts://run-records/{runId}` for its **reproducibility block** (git sha/branch/dirty + redacted command), its project + `project_hash`, and its submission context (profile, queue, requested resources).
2. **Reconstruct the spec** from the saved plan (the run-record plus its plan artifact). Apply any user-requested parameter override, and state the override explicitly. Note in the experiment description that this reproduces / derives from the original `run_id`.
3. **Plan fresh.** `jobs.plan` produces a new dry-run (new `run_id`, new `plan_hash`). Confirm the rendered script matches the original except for the declared override.
4. **Capacity.** `quotas.refresh` for the SAME profile, then `quotas.capacity` to confirm the queue still has headroom.
5. **Authorize + submit.** Tier-A autonomous when conformant, otherwise `review-approvals` then `jobs.submit` (see `run-experiment` step 5 for the submit details). On **UTS iHPC** the fresh `quotaSnapshotId` is always required, and an approval-gated iHPC submit needs BOTH the `approvalId` and the fresh `quotaSnapshotId`.
6. **Verify** with `jobs.status`.

## Guardrails

A reproduction is a new run with a new `plan_hash`; never re-submit the original's saved plan_hash. If the original run's git state was **dirty**, surface that the exact code may differ from what is checked in. Carry the original resources over unchanged unless the user explicitly asks to change them — do not silently right-size a reproduction. Do not use direct shell or SSH to copy/rerun the old job.

## References

- `skills/run-experiment/SKILL.md` for the shared submit-and-verify steps.
- `docs/architecture-overview.md` for the reproducibility block and how `plan_hash` excludes git/project metadata.
