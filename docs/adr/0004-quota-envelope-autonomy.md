# ADR 0004: Quota-Envelope Autonomy

Status: Accepted (2026-06-16).

## Context

The plugin's purpose is autonomous experiment iteration: the Agent monitors, submits, retries, and sweeps jobs. The original M3 design gated every `jobs.submit` behind a human approval token (`UTS_COMPUTING_APPROVAL_TOKEN`).

In a same-machine deployment where the Agent has shell access, that token is unenforceable — the Agent can read or set the environment variable itself, so the gate is security theatre. It also directly contradicts the autonomy goal: an Agent cannot iterate dozens of jobs if each one needs a human to type a token.

Live investigation of the real CETUS account on 2026-06-16 established that the authoritative resource envelope is queryable per account at login:

- per-queue resource caps (`resources_max.ncpus/mem/walltime`) and per-user concurrency caps (`max_run`/`max_queued`, in PBS `[u:PBS_GENERIC=N]` form) for all 8 queues, all open to the account;
- no service-unit / compute-budget system exists on CETUS — per-user concurrency caps are the only compute bound;
- storage is a shared NFS filesystem with no per-user quota — headroom is filesystem availability.

This means the real safety envelope is not something a human configures; it is the platform's own per-account limits, which the package can query live and operate within.

## Decision

Replace per-submission token approval with autonomous submission gated by live per-account quota-envelope conformance, for `jobs.submit` / `jobs.status` / `jobs.logs` / `jobs.retry`, `transfers.execute`, and `artifacts.fetch(.batch)`. Retain the human confirmation token ONLY for `artifacts.cleanup.execute` (irreversible remote deletion).

The envelope is the authoritative per-account limit set queried live through `quotas.refresh`, never inferred from documentation or static thresholds. A planned job conforms when, against the account's fresh snapshot:

- the target queue is `enabled` and `started`, and the account is permitted by any queue ACL;
- requested resources do not exceed the queue `resources_max` where set (ncpus, mem, walltime, ngpus);
- the account's current running and queued counts in that queue plus the new job stay within the queue's per-user `max_run` / `max_queued`;
- storage headroom is available (where observable).

Non-conformant submissions are refused with the specific violated limit so the Agent can re-plan smaller. Conformant submissions run autonomously, recording the conformance decision and the snapshot id in the run record for audit. The platform scheduler remains the authoritative backstop; conformance makes the Agent a good citizen and an informed planner (it knows real headroom for sweeps).

The hardcoded risk thresholds in `approval-policy.ts` (16 cpu, 64 gb, 24 h, restricted-queue list) are demoted to display-only metadata in `jobs.plan`; they no longer gate.

## Consequences

- The Agent can monitor, submit, retry, and iterate autonomously within the real, account-specific limits — the product goal.
- The one irreversible action (remote data deletion via `artifacts.cleanup.execute`) keeps a genuine human gate.
- Multi-account safety is preserved: conformance is always against the selected profile's fresh snapshot, and switching accounts switches envelopes.
- The full audit trail is retained (plan hash + conformance decision + snapshot id).
- `quotas.refresh` must parse and structure the per-queue and per-user limits it currently discards.
- Conformance is advisory rather than authoritative: the scheduler is the true enforcer, so a stale or incomplete snapshot could let a job through that the scheduler then rejects. This is fail-safe (the platform refuses it) and audited.

## Residual risk (accepted)

The confirmation token retained for the irreversible operations (`artifacts.cleanup.execute`, and likewise `jobs.cancel` and `state.migrate.apply`) is **not a hard trust boundary against an Agent that has shell access on the same machine** — by the same reasoning as the submission token above, the Agent can read or set `UTS_COMPUTING_APPROVAL_TOKEN` itself. We **accept this residual risk**: a genuine out-of-process human confirmation (a separate approver process, a TTY prompt the Agent cannot drive, or a hardware token) is out of scope for the same-machine deployment this package targets.

What actually bounds those operations is therefore **structural**, not the token: `artifacts.cleanup.execute` requires a terminal run plus a scope-bound approval matching the exact manifest hash / ordered artifact ids / `delete_mode` / byte caps, and re-verifies size+checksum remotely before each `os.unlink`; `state.migrate.apply` is additive-only, backs up every file before writing, and re-validates against a freshly recomputed plan hash; `jobs.cancel` is bound to one run's `plan_hash` + quota snapshot through a single-use approval. The token raises the bar against an accidental or naive call; the structural gates bound the blast radius if it is bypassed. If this package is ever deployed where the Agent and the approver are isolated (separate processes or hosts), the token becomes a real boundary with no code change.

## Implementation phases

- Phase 1 (CETUS / PBS submit) — **done**: parse `qstat -Qf` into structured limits; add a conformance module; replace the submit gate with conformance and make `approvalId` optional; record the authorization; tests and docs.
- Phase 2 — **done (2026-06-16)**: `transfers.execute`, `artifacts.fetch`, and `artifacts.fetch.batch` are autonomous — the per-submission token is dropped (these operations are reversible by design), `approvalId` is optional, and the records omit `approval_id` when run autonomously. iHPC supervised start is autonomous via active-cnode conformance (`selectActiveComputeNode`: the fresh snapshot must expose an active compute node for the planned node-family). Storage-headroom conformance (`parseDfAvailable` + `checkStorageHeadroom`) refuses a submit only when the job's target mount is observably out of headroom (≥99% capacity or below a requested floor), via longest-prefix match against the snapshot's `df` filesystems; a full unrelated filesystem never blocks, and it is a no-op where `df` was not observed. The `approval-policy.ts` risk thresholds (16 cpu / 64 gb / 24 h / restricted-queue / GPU) are demoted to advisory display-only metadata on `jobs.plan` (`approval.policy: "advisory"`); they no longer gate. Remote-path redaction across `jobs`/`ihpc-start` was unified onto the profile-derived `maskUserRootPath`.
- Throughout: `artifacts.cleanup.execute` keeps the confirmation token — it is the one irreversible (remote delete) action.

## PBS limit-spec reference (observed 2026-06-16)

Per-user and scoped limits appear as `[u:PBS_GENERIC=N]` (generic per user), `[u:<user>=N]` (user-specific, takes precedence), `[g:<group>=N]` (per group), and `[o:PBS_ALL=N]` (overall). Resource-scoped queued limits appear as `max_queued_res.<resource> = [o:PBS_ALL=N]`. Memory caps are like `32gb`; walltime caps are `HH:MM:SS`.
