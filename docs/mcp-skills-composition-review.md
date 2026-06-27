# MCP And Skills Composition Review

Last updated: 2026-06-18, Australia/Sydney.

## Purpose

This review records how this project should build and combine MCP, Skills, and plugin shims for UTS HPC and UTS iHPC. It consolidates official documentation research and the parallel agent audit of the current plan.

## Research Basis

Primary sources reviewed:

- OpenAI Codex Skills: https://developers.openai.com/codex/skills
- OpenAI Codex Plugins: https://developers.openai.com/codex/plugins
- OpenAI Codex plugin build guide: https://developers.openai.com/codex/plugins/build
- Claude Code Skills: https://code.claude.com/docs/en/skills
- Claude Code Plugins reference: https://code.claude.com/docs/en/plugins-reference
- MCP Tools specification: https://modelcontextprotocol.io/specification/2025-06-18/server/tools
- MCP Resources specification: https://modelcontextprotocol.io/specification/2025-06-18/server/resources
- MCP Prompts specification: https://modelcontextprotocol.io/specification/2025-06-18/server/prompts
- Agent Skills format: https://agentskills.io/home

Key conclusions:

- Skills are best for procedural knowledge, lightweight orchestration, and progressive disclosure. Their descriptions must be precise because clients use them for automatic loading.
- MCP tools are best for actions, live state, validation, security boundaries, and audit. Tool servers must validate inputs, enforce access control, sanitize outputs, and distinguish execution errors from protocol errors.
- MCP resources are best for reusable context that agents should inspect before acting, such as queue snapshots, profile summaries, template catalogs, cached UTS documentation, and recent run records.
- MCP prompts are useful for reusable user-invoked workflows, but should not replace Skills. This package now exposes guided prompt entry points for experiment planning, run triage, artifact collection, fixed-file transfer staging, and installed-client smoke evidence.
- Plugins are distribution wrappers. Codex and Claude Code can share Skills and MCP, while keeping only manifest and setup differences in client-specific shims.

## Design Rule

Use this boundary:

| Layer | Owns | Should not own |
| --- | --- | --- |
| Skill | workflow, decision policy, stop conditions, approval prompts, tool order | SSH, PBS, iHPC commands, transfer execution, secret handling |
| MCP tool | validated action, live query, dry-run rendering, state mutation, audit | broad procedural advice, hidden account switching |
| MCP resource | cached or current context selected by the host or agent | actions or side effects |
| MCP prompt | reusable guided workflow entry point | hidden automation or authorization |
| Plugin shim | client discovery and packaging metadata | platform-specific business logic |

The elegant composition is:

1. A Skill is triggered by user intent.
2. The Skill selects one profile and one workflow.
3. The Skill calls MCP tools in a documented sequence.
4. MCP tools return structured, redacted, auditable results.
5. The Skill interprets results and asks for approval when policy requires it.
6. MCP tools execute only approved, allowlisted operations.
7. MCP resources preserve reusable context for later turns and clients.

## Current Implemented State

Implemented MCP tools (38), grouped by domain:

- Profiles: `profiles.list`, `profiles.validate`, `profiles.onboard`, `projects.list`
- Access: `access.check`, `access.doctor`, `access.confirm_usage`
- Docs: `docs.search`, `docs.refresh`
- Quotas: `quotas.refresh`, `quotas.capacity`
- Jobs: `jobs.plan`, `jobs.submit`, `jobs.status`, `jobs.track`, `jobs.logs`, `jobs.usage`, `jobs.cancel`, `jobs.diagnose`, `jobs.history`, `jobs.retry.plan`, `jobs.rightsize`
- Approvals: `approvals.request`, `approvals.status`, `approvals.decide`
- Artifacts: `artifacts.list`, `artifacts.fetch`, `artifacts.fetch.batch`, `artifacts.summarize`, `artifacts.cleanup.plan`, `artifacts.cleanup.execute`
- Transfers: `transfers.plan`, `transfers.execute`
- Sweep: `sweep.plan`, `sweep.rank`
- State: `state.migrate.plan`, `state.migrate.apply`
- Templates: `templates.list`

Implemented MCP prompts:

- `plan-experiment`
- `triage-run`
- `collect-artifacts`
- `stage-transfer`
- `client-smoke-evidence`

M1 dry-run tools are local-only. They must not use SSH, `qsub`, `qstat`, `pbsnodes`, `cnode`, `rsync`, VPN probes, or UTS remote hosts.

M2a `access.check` is implemented as read-only preflight. It is profile-scoped, writes redacted evidence under `.uts-computing/access`, and only allows DNS/TCP/local SSH inspection plus strictly allowlisted SSH remote identity/noop checks. It must not run scheduler, quota, storage, transfer, or workload commands.

M2b/M2c `quotas.refresh` is implemented for UTS HPC and UTS iHPC profiles. It is profile-scoped, writes redacted evidence under `.uts-computing/quotas`, and only allows fixed read-only SSH remote argv for platform-specific identity, group, queue/node, session/job, and storage evidence.

M2d MCP resources are implemented for redacted profiles, dry-run templates, quota snapshots, run records, and allowlisted local documentation. Runtime-backed resource templates only read `.uts-computing/quotas/*.json` and `.uts-computing/runs/*.json`; documentation and template resources are allowlisted by id.

M3a approval state is implemented for local approval records. `jobs.plan` now emits deterministic `plan_hash` values and run records mirror the approval binding. `approvals.request` creates required approval records bound to `plan_hash` plus `quota_snapshot_id`; `approvals.status` reads and expires them; `approvals.decide` requires a trusted local confirmation token before recording approval or rejection.

M3b UTS HPC PBS submission is implemented as a narrow live action. `jobs.submit` consumes a saved plan artifact plus an approved, unconsumed approval record, recomputes the plan hash, and submits only through `ssh <profile-host> qsub` with the saved script on stdin. It does not accept model-supplied scripts, qsub flags, SSH hosts, or remote commands.

M3c UTS iHPC supervised start is implemented as the iHPC branch of `jobs.submit`. It requires saved `command_argv`, a fresh matching iHPC quota snapshot with active `cnode mynodes` compute-node evidence, and a fixed Python supervisor sent over stdin through `ssh <profile-host> ssh <active-cnode> python3 -`. It does not execute `bash -lc`, `nohup`, shell redirection, or model-supplied host/node/path/command values.

M3d is implemented as narrow platform-specific monitoring and cancellation actions. For UTS HPC PBS, `jobs.status` queries only the recorded PBS job id with `qstat -f`, `jobs.logs` tails only saved plan-derived stdout/stderr paths with a byte bound, and `jobs.cancel` runs only `qdel <recorded-job-id>` after consuming a separate `jobs.cancel` approval. For UTS iHPC, the same tool names use only persisted supervisor pid/node/log metadata and fixed Python helpers through `ssh <profile-host> ssh <ihpc-compute-node> python3 - <supervisor-spec>` for status, bounded logs, and approved process-group cancellation. Approval ids include the operation to prevent submit/cancel approval collisions.

M3e approval-policy hardening is implemented as shared server-side policy rather than Skill-only guidance. `jobs.plan` and `approvals.request` share the same plan-risk reasons for GPU, restricted/special queue, high CPU, high memory, long walltime, array jobs, high array concurrency, and iHPC supervised starts. `approvals.request` derives those reasons from saved plan artifacts when available, adds operation-specific submit/cancel/retry/transfer reasons, and records cross-account switch context through optional `previousProfileId`.

M3f retry planning is implemented as a local-only workflow. `jobs.retry.plan` accepts only `sourceRunId`, `retryRunId`, and an optional redacted reason, creates a fresh plan/run record with `retry_of` lineage, and marks the plan as `approval_operation: "jobs.retry"`. UTS HPC retry submission and UTS iHPC supervised retry start are allowed only after fresh quota evidence, matching retry lineage, and a matching `jobs.retry` approval.

M4 first-slice artifact handling is implemented as a narrow manifest workflow. `artifacts.list` derives remote candidates only from saved plan `workdir` and declared `outputs`, writes a local manifest plus `manifest_hash`, and uses remote `realpath` checks to reject symlink escapes. `artifacts.fetch` accepts only a manifest `artifactId`, a matching `artifacts.fetch` approval id, and byte/time bounds; it verifies SHA-256 against remote and manifest checksums, writes evidence, appends a run event, and consumes approval. `artifacts.fetch.batch` accepts only explicit manifest ids plus the latest `manifest_hash`, requires a matching `artifacts.fetch.batch` approval scoped to those ids and byte limits, rejects manifest-total overruns before command execution, and consumes approval before remote fetch commands. `artifacts.summarize` and `artifacts.cleanup.plan` operate on local state only; summary extraction is limited to metric-like JSON/JSONL/NDJSON/CSV/TSV filenames whose safe stem tokens include metric/result/summary/eval/score terms, with size, symlink, row, column, secret-filename, and secret-key bounds. `artifacts.cleanup.execute` is implemented only for terminal runs, latest manifest hash, explicit manifest file ids, captured SHA-256 and size evidence, exact `artifacts.cleanup.execute` approval scope, and unlink-regular-files-only helpers. The implementation deliberately does not support arbitrary remote paths, directory rsync, user-supplied SSH options, arbitrary log/text summarization, raw-path cleanup, directory cleanup, glob cleanup, or recursive cleanup.

M4 artifact state now has dedicated schemas for manifests, single/batch fetch evidence, summaries, cleanup plans, and cleanup execution records. MCP resources expose `uts://artifacts`, `uts://artifacts/{runId}/state`, `uts://artifacts/{runId}/manifest`, `uts://artifacts/{runId}/cleanup-plans`, and `uts://artifacts/{runId}/cleanup-executions` as sanitized context only: they allowlist fields, redact path-like evidence, realpath-check state files inside `.uts-computing/artifacts`, reject symlink evidence files, and do not expose fetched file content, raw cleanup helper args, or raw artifact browsing.

M4 fixed-file transfer execution is implemented as a saved-plan workflow. `transfers.plan` persists a deterministic plan hash, explicit relative file list, and total byte budget. `transfers.execute` accepts only `runId`, `approvalId`, and timeout; it verifies the saved plan and `transfers.execute` approval resource scope, preflights the exact file list, verifies that helper metadata exactly matches the saved file list, byte accounting, and checksum policy, consumes approval, and runs fixed `rsync` argv with `--files-from=-`. For checksum-eligible files at or below the fixed transfer checksum cap, downloads compare remote preflight SHA-256 with the local destination after rsync, and uploads compare local preflight SHA-256 with a fixed remote post-check helper. Oversized files record `skipped-large` plus `checksum_policy`, not a content-hash verification claim. It deliberately does not support arbitrary transfer execution, model-provided rsync flags, SSH options, delete/remove flags, arbitrary checksum commands, globs, filters, or broad directory recursion.

MCP tool results now use a consistent JSON envelope in both text content and `structuredContent`. Successful tool calls return `ok: true`, expected business failures return `ok: false` with top-level `isError: true`, and every registered tool advertises a conservative output schema requiring `ok`. This preserves compatibility with text-only clients while letting clients that support structured output consume the same payload directly.

Recent hardening:

- MCP tool inputs no longer accept model-controlled `configPath`, `auditDir`, or `writeAudit`.
- Local config paths must stay inside the project root.
- Audit output must stay inside `.uts-computing`.
- Secret redaction covers common `password`, `token`, `api_key`, MFA, and URL credential forms.
- Plugin manifest paths now use plugin-root-relative `./...` paths.
- Skills now declare the current implemented capability boundary and stop when later tools are unavailable.

## Planned Improvements

Completed M2 hardening:

- `access.check` now covers VPN/DNS/TCP/SSH preflight with redacted local evidence.
- `quotas.refresh` now supports UTS HPC and UTS iHPC with argv-level remote command allowlists. It does not expose generic shell execution.
- `docs.refresh` now refreshes only fixed official UTS documentation sources into schema-validated local cache records and exposes `uts://docs-cache/{sourceId}` without arbitrary URL/path/header/profile/proxy inputs.
- `docs.search` now searches only allowlisted local docs and returns bounded snippets plus `uts://docs/{docId}` references without live URL fetches or arbitrary path input.
- Live read-only snapshots now include `observed_at`, source commands, freshness, and redacted raw evidence paths.
- MCP resources now expose reusable context without live side effects.
- M3a approval records now bind local approval state to deterministic `plan_hash` values and fresh local quota snapshots.
- M3b `jobs.submit` now supports UTS HPC PBS submission through a fixed qsub adapter and consumes approval records once.
- M3c `jobs.submit` now supports UTS iHPC supervised starts through a fixed Python supervisor on active cnode evidence.
- M3d `jobs.status`, `jobs.logs`, and `jobs.cancel` now support UTS HPC PBS run records with fixed qstat/tail/qdel adapters and UTS iHPC supervised run records with fixed Python helper adapters.
- M3e approval-policy hardening now derives system reasons from saved plans and prevents operation/profile-switch approval reuse mistakes.
- M4 first-slice artifact tools now support plan-derived listing, manifest-based single-file fetch, manifest-hash-scoped batch fetch, checksum verification, bounded local metric summary with safe tokenized filename matching, dry-run cleanup planning, and scoped cleanup execution.
- M4 artifact schemas and sanitized MCP artifact resources are implemented for manifest, fetch, summary, cleanup-plan, and cleanup-execution state.
- M4 fixed-file transfer execution now supports saved transfer plans, scoped approvals, preflighted file lists, strict helper metadata matching, bounded SHA-256 verification for checksum-eligible upload/download files, explicit `skipped-large` evidence for oversized files, download post-rsync local destination verification, total byte limits, and fixed rsync argv.
- M5 protocol hardening now covers iHPC `jobs.status`, `jobs.logs`, and `jobs.cancel` tool schemas and protocol calls, plus structured tool results and JSON-envelope tool errors.
- M5 first-slice packaging hardening now validates shared Codex/Claude plugin shims, plugin-root-relative paths, shared MCP config, built MCP entrypoint presence, and shared Skill frontmatter.
- M5 host-neutral plugin smoke testing now launches the MCP server from `.mcp.json` inside a temporary plugin root, forces example profiles, strips secret-like parent environment variables, and performs offline profiles/templates/migration/jobs.plan checks.
- M5 client-installed smoke evidence now has a fixed prompt generator, schema, validator, and tests for Codex plus Claude Code evidence.
- M5 MCP prompts now expose user-invoked workflow entry points with protocol tests for inventory, arguments, safe text, redacted prompt inputs, no side effects, and static import boundaries.
- M5 state migration apply now supports confirmed additive schema-version writes with dry-run plan hash binding, per-file backups, and approval/run-state preservation.
- M5 documentation now includes plugin setup, schema migration planning, and failure playbooks.
- Tests cover mocked live probes, platform dispatch, unsafe host aliases, unsafe iHPC storage roots, optional iHPC probe failures, PBS/iHPC command separation, protocol-level resource list/read behavior, protocol-level allowlisted `docs.search`, protocol-level fixed-source `docs.refresh`, protocol-level iHPC status/log/cancel tool calls, structured tool output envelopes, approval state transitions, stale/mismatched quota rejection, trusted-token approval decisions, server-derived M3e approval reasons, mocked HPC qsub submission, mocked iHPC supervised start, mocked HPC qstat/log/qdel operations, mocked HPC qstat/tail/qdel failure paths, mocked iHPC status/log/cancel helper operations, mocked artifact list/fetch/batch-fetch/summary/cleanup operations, mocked fixed-file transfer execution, transfer helper metadata and checksum-policy rejection, upload/download checksum mismatch rejection, skipped-large evidence, download post-rsync local verification failures, artifact metric filename allowlist/denylist behavior, artifact symlink-boundary helper requirements, batch approval scope hashes, transfer approval scope hashes, state migration dry-run/apply guards, protocol-level unsafe artifact input rejection, expanded redaction corpus, and plugin package validation.

P0/P1 improvements for the next slices:

- Keep schema migration staged: optional `schema_version` reader fallback, `state.migrate.plan`, and narrow `state.migrate.apply` are implemented; future non-additive migrations stay deferred until backup, approval, confirmation-token, no-secret, and fixture tests are reviewed.
- Run and capture the validated client-installed smoke evidence files inside real Codex and Claude Code plugin hosts before release.
- Add protocol-level tests for later live mutation tools.

## Agent Audit Summary

The parallel audit converged on four recommendations:

- MCP design: keep the current tool boundary, but harden paths, redaction, structured outputs, and approval state.
- Skills: keep them concise, but add phase gates so agents do not invent live tools during M1.
- Plugin composition: fix manifest paths and document the shared-root contract for Codex and Claude Code.
- Roadmap: split M2/M3 into smaller slices because read-only evidence, approval, submission, monitoring, and artifact handling have different risk levels.

The M2c follow-up audit added one implementation constraint: iHPC support must remain a separate adapter path rather than pretending it is PBS. Its read-only command surface is limited to identity/group probes, `cnode avail/all/mynodes`, `sessiontime`, `projvolu`, and profile-declared `df -hP` / `du -s -h` storage checks.

The M4 audit added two constraints for artifact work:

- artifact tools should be manifest-centered and should not accept model-provided host, user, SSH options, raw remote paths, globs, local destination directories, rsync flags, or cleanup/delete flags;
- tests should prove failures occur before command execution for unsafe ids, wrong approvals, tampered paths, and protocol-layer unsafe input.
