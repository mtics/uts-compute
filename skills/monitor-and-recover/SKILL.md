---
name: monitor-and-recover
description: Diagnose planned or recorded UTS HPC/iHPC runs, and monitor or recover live runs only when matching MCP tools exist. Use when a run is queued, stalled, failed, producing unexpected logs, consuming resources too long, or needs a safe retry or cancellation decision.
---

# UTS Monitor And Recover

Prefer diagnosis before retrying.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools can inspect local planned/submitted run records, dry-run outputs, UTS HPC/iHPC quota snapshots, and approval records through MCP resources, refresh quota/session context through `quotas.refresh`, submit approved UTS HPC PBS jobs and start approved UTS iHPC supervised runs through `jobs.submit`, query UTS HPC PBS or UTS iHPC supervisor status through `jobs.status`, re-poll and reconcile every active run at once through `jobs.track`, roll runs up per project through `projects.list` (every run is auto-tagged at plan time with a git-derived project plus a `project_hash`, and `jobs.track`/`jobs.history` accept a `project` filter), fetch bounded PBS or iHPC supervisor log tails through `jobs.logs`, cancel explicit PBS jobs or iHPC supervised runs through `jobs.cancel`, create local retry plans through `jobs.retry.plan`, list and fetch declared artifacts through `artifacts.list` and approved artifact fetch tools, execute approved fixed-file transfers through `transfers.plan`/`transfers.execute`, summarize local allowlisted metric artifacts through `artifacts.summarize`, create dry-run cleanup plans through `artifacts.cleanup.plan`, execute scoped approved artifact cleanup through `artifacts.cleanup.execute`, inspect local state compatibility through `state.migrate.plan`, apply confirmed additive schema-version migrations through `state.migrate.apply`, and create M3e operation-specific approval records for retries or cross-account switches. UTS HPC retry-derived submissions and UTS iHPC supervised retry starts require fresh quota evidence plus a matching `jobs.retry` approval; broad directory transfer without a fixed file list, arbitrary remote path browsing, arbitrary log/text summarization, raw-path cleanup, directory cleanup, glob cleanup, and recursive cleanup are not supported. If a required live tool is unavailable, stop and report which later milestone is needed. Do not use direct shell, SSH, PBS, iHPC, rsync, transfer commands, or hand edits to `.uts-computing` as a substitute for a missing MCP tool.

## Workflow

1. Identify the run id, profile id, platform, and remote job or process id.
2. Inspect local run records through `uts://run-records` / `uts://run-records/{runId}` and rendered dry-run scripts when available. If local state looks schema-incompatible, run `state.migrate.plan` and stop on blockers before recovery work. For UTS HPC PBS submitted runs or UTS iHPC supervised runs, fetch current status through `jobs.status`. When several runs are in flight, `jobs.track` reconciles every active run to live status in one read-only sweep (it skips terminal and not-yet-submitted runs).
3. Collect local audit events and cached quota snapshots first. For submitted/supervised runs, collect status and bounded stdout/stderr through `jobs.status` and `jobs.logs`. For a failed run, `jobs.diagnose` classifies the failure with the safe next action, and `jobs.usage` reports finished-run core/GPU-hour and CPU-efficiency accounting. `jobs.rightsize` turns a project's recorded usage into a requested-vs-used resource recommendation, so a retry can ask for a saner size instead of guessing.
4. Classify the failure:
   - access or VPN issue;
   - queue or quota issue;
   - resource under-request;
   - environment or module issue;
   - command failure;
   - data or artifact path issue;
   - session timeout or inactivity.
5. If partial outputs matter, use `artifacts.list` first and fetch only selected file artifacts after matching artifact approval. For larger fixed-file output sets, use `stage-transfer` with a fixed file list and `transfers.execute` approval. Use `artifacts.summarize` for local metrics once files are fetched.
6. Propose a recovery action with cost and risk:
   - wait;
   - fetch more logs;
   - adjust resource request (size it with `jobs.rightsize`);
   - retry with same profile;
   - switch platform or profile with approval;
   - cancel explicit job id;
   - collect partial artifacts.
7. Ask for confirmation before cancellation, retry, account switch, GPU use, larger resources, or artifact fetches. For live cancel, create and approve a fresh operation-specific `jobs.cancel` approval record rather than reusing a submit approval. For artifact fetch, create and approve a fresh operation-specific `artifacts.fetch` approval record. For retry planning, use `jobs.retry.plan` (or `sweep.retry.plan` for a PBS-array sweep's failed members) instead of editing job specs or hand-resetting a run to `planned` — `jobs.submit` accepts only `planned` runs and refuses a `failed`/`cancelled` one, and `jobs.retry.plan` mints a fresh `run_id` + retry lineage + new `plan_hash`. Then review quota evidence and create a fresh operation-specific `jobs.retry` approval before UTS HPC retry submission or UTS iHPC supervised retry start. A **UTS iHPC** retry submit ALWAYS needs a fresh `quotaSnapshotId` for the ban-critical node-pool gate (refresh quotas immediately before submit and use the returned `snapshot_id`); when the retry is approval-gated, pass **BOTH** the `jobs.retry` `approvalId` AND the fresh `quotaSnapshotId` — the iHPC `approvalId` alone hard-fails because its bound snapshot may be up to 24h stale. UTS HPC PBS retries keep the approval-only path.

## References

- `docs/accounts-and-safety.md`
- `docs/research-basis.md`
- `docs/fact-registry.md`
- `schemas/run-record.schema.json`

## Stop Conditions

Do not cancel broad sets of jobs. Do not retry blindly. Do not change accounts or increase resources without explaining why and getting approval.
