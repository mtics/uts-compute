# Implementation Plan

## Current Baseline

The repository started as an empty non-git directory. This scaffold establishes the first durable architecture:

- documentation basis in `docs/`;
- shared Skills in `skills/`;
- shared MCP server area in `mcp-server/`;
- schemas in `schemas/`;
- example profiles in `profiles/`;
- templates in `templates/`;
- Codex and Claude Code plugin shims.

## Milestones

### M0: Contracts And Documentation

Status: complete for the initial scaffold.

Deliverables:

- platform research basis and fact registry;
- multi-account and safety policy;
- JSON Schemas for profiles, job specs, and run records;
- initial Skills with concise workflow instructions;
- example profile file with four placeholder profiles;
- PBS and iHPC template placeholders.

Acceptance:

- no secrets in repo;
- Skills validate with the skill validator;
- docs state which facts are static, dynamic, or account-specific.

### M1: Local Dry-Run MCP

Status: implemented and locally tested.

Deliverables:

- MCP server project setup;
- `profiles.list` and `profiles.validate`;
- `jobs.plan` with schema validation;
- template rendering for PBS CPU, PBS GPU, PBS array, iHPC background run, and rsync transfer;
- local audit record creation without SSH.

Acceptance:

- example job specs render deterministically;
- invalid resource requests fail before any remote access;
- plugin shims can launch the same MCP server command.
- model-controlled MCP input cannot redirect config reads or audit writes outside project boundaries;
- audit records redact common secret forms.

Implemented commands:

```sh
npm install
npm test
npm run dry-run:sample
```

Implemented MCP tools:

- `profiles.list`
- `profiles.validate`
- `templates.list`
- `jobs.plan`
- `transfers.plan`

M1 remains local-only. It must not use SSH, `qsub`, `cnode`, `rsync`, or UTS remote hosts.

### M2: Read-Only Live Platform Queries

Status: implemented.

Deliverables:

- M2a: `access.check` for VPN, DNS, TCP, SSH identity, and host-key preflight. Implemented.
- M2b: UTS HPC read-only queue, node, job, group, and quota refresh. Implemented for identity, groups, queues, current jobs, PBS nodes, `quota -s`, and `df -hP` over profile roots.
- M2c: UTS iHPC read-only node-family, session, group, and storage refresh. Implemented.
- M2d: MCP resources for profiles, templates, quota snapshots, run records, and local documentation. Implemented.
- M2e: `docs.search` for allowlisted local documentation snippets. Implemented.
- M2f: `docs.refresh` for fixed-source official UTS documentation cache refresh plus `uts://docs-cache/{sourceId}` resources. Implemented.

Acceptance:

- no remote write commands;
- all remote commands are argv-level allowlisted;
- every live fact includes `observed_at` and source command;
- raw evidence is stored under `.uts-computing` with redaction;
- reusable read-only context is exposed as MCP resources without live side effects;
- stale quota snapshots block submission planning that depends on them.

M2 implemented MCP tools:

- `access.check`
- `docs.refresh`
- `docs.search`
- `quotas.refresh` for UTS HPC profiles
- `quotas.refresh` for UTS iHPC profiles

M2 implemented MCP resources:

- `uts://profiles`
- `uts://templates` and `uts://templates/{templateId}`
- `uts://quota-snapshots` and `uts://quota-snapshots/{snapshotId}`
- `uts://run-records` and `uts://run-records/{runId}`
- `uts://docs` and `uts://docs/{docId}`
- `uts://docs-cache` and `uts://docs-cache/{sourceId}`

M2a allowed probes:

- local SSH config inspection with `ssh -G`;
- DNS lookup;
- TCP connection to the effective SSH host and port;
- local known-host lookup with `ssh-keygen -F`;
- SSH batch auth with remote `true`;
- SSH remote identity with `id -un`.

M2a default tests mock all network and SSH behavior; live checks are runtime behavior, not part of default `npm test`.

M2e `docs.search` reads only allowlisted local docs shared with `uts://docs`, returns bounded line snippets plus resource URIs, and does not call VPN, DNS, TCP, SSH, UTS hosts, or live documentation URLs.

M2f `docs.refresh` fetches only the server-side fixed official UTS documentation source allowlist over HTTPS, with bounded timeout and response bytes. It writes schema-validated sanitized text cache records under `.uts-computing/docs-cache/` and exposes cached pages through `uts://docs-cache/{sourceId}`. It does not accept arbitrary URLs, paths, hosts, headers, profile ids, proxy settings, credentials, or output directories. If UTS documentation requires VPN, the local VPN must already be connected. Cached docs remain platform context only; per-account quota and ACL decisions still require `quotas.refresh`.

M2b UTS HPC allowed remote probes:

- `whoami`
- `id`
- `groups`
- `qstat -Q`
- `qstat -Qf`
- `qstat -u <observed-user>`
- `pbsnodes -F json -a`
- `quota -s`
- `df -hP <profile-declared-root>`

M2b default tests mock all SSH, PBS, and storage behavior.

M2c UTS iHPC allowed remote probes:

- `whoami`
- `id`
- `groups`
- `cnode avail`
- `cnode all`
- `cnode mynodes`
- `sessiontime`
- `projvolu`
- `df -hP <profile-declared-root>`
- `du -s -h <profile-declared-root>`

M2c default tests mock all SSH, iHPC, session, and storage behavior.

### M3: Controlled Submission Loop

Status: M3a, M3b, M3c, M3d, M3e approval-policy hardening, and M3f retry planning implemented for UTS HPC PBS jobs plus UTS iHPC supervised runs. UTS HPC retry submission and UTS iHPC supervised retry start are supported only from retry-derived plans with matching `jobs.retry` approval.

Deliverables:

- M3a: approval state machine bound to `plan_hash` and `quota_snapshot_id`. Implemented for local approval records and MCP approval tools.
- M3b: `jobs.submit` for UTS HPC PBS jobs using allowlisted submission paths. Implemented with saved plan artifacts, approval consumption, and `ssh ... qsub` stdin submission.
- M3c: supervised iHPC background run start using allowlisted session and process management. Implemented through `jobs.submit` with saved `command_argv`, active `cnode mynodes` evidence, and a fixed Python supervisor.
- M3d: `jobs.status`, `jobs.logs`, and explicit `jobs.cancel`. Implemented for UTS HPC PBS run records and UTS iHPC supervised run records.
- M3e: approval records for GPU, long walltime, big memory, high concurrency, cross-account switches, retries, and cancellation. Implemented for policy reasons, operation-specific approval ids, profile-switch metadata, and submit/cancel operation enforcement.
- M3f: `jobs.retry.plan` for local retry dry-runs. Implemented with retry lineage metadata, cancelled-run reason requirements, source plan hash checks, and `jobs.retry` approval-operation enforcement for UTS HPC retry submission plus UTS iHPC supervised retry start.

Acceptance:

- all live submissions require a selected `profile_id`;
- all live submissions require a matching plan hash and fresh quota snapshot;
- approval decisions require a trusted local confirmation token and cannot be silently self-approved by the model;
- no generic shell tool exists;
- all remote job ids are linked to local run ids.

> **Superseded by ADR 0004 (quota-envelope autonomy, Phase 2 complete 2026-06-16).** `jobs.submit`, `jobs.retry`, `transfers.execute`, `artifacts.fetch`, `artifacts.fetch.batch`, and iHPC supervised start no longer consume a human token; they run autonomously, gated by live conformance against the selected profile's fresh quota snapshot (PBS queue/resource/user-count limits, iHPC active-cnode, storage headroom). The token requirement above now applies only to `artifacts.cleanup.execute`, `jobs.cancel`, and `state.migrate.apply`. The `approval-policy.ts` risk thresholds are advisory display-only. **iHPC-specific (ban-critical):** a UTS iHPC supervised start (and supervised retry start) ALWAYS requires a fresh `quotaSnapshotId` — even when an `approvalId` is also supplied — because the per-account node-pool gate must evaluate held-node occupancy against consume-time-fresh evidence, never an approval's possibly-stale bound snapshot. So an approval-gated iHPC submit needs BOTH the `approvalId` and a fresh `quotaSnapshotId` (an iHPC submit with only an `approvalId` hard-fails); the PBS approval-only path is unchanged. See `docs/adr/0004-quota-envelope-autonomy.md` and `docs/accounts-and-safety.md`.

M3 implemented MCP tools:

- `approvals.request`
- `approvals.status`
- `approvals.decide`
- `jobs.submit` for UTS HPC PBS plans
- `jobs.submit` for UTS iHPC supervised starts
- `jobs.status` for submitted UTS HPC PBS run records and UTS iHPC supervised run records
- `jobs.logs` for bounded UTS HPC PBS stdout/stderr tails from saved plan paths and bounded UTS iHPC supervisor log tails from saved supervisor paths
- `jobs.cancel` for explicit UTS HPC PBS qdel or UTS iHPC supervisor process-group termination with a matching `jobs.cancel` approval
- `jobs.retry.plan` for local retry planning from failed runs or explicitly explained cancelled runs

M3a implemented MCP resources:

- `uts://approval-records`
- `uts://approval-records/{approvalId}`

M3a approval records are local-only and stored under `.uts-computing/approvals`. They validate that `quota_snapshot_id` exists locally, matches the selected profile/platform, and is fresh. Approval expiration is capped by quota snapshot freshness.

M3b/M3c `jobs.submit` supports UTS HPC PBS and UTS iHPC supervised starts. It reads `.uts-computing/plans/<run_id>.json`, recomputes the plan hash, verifies the approved and unconsumed approval record, and requires the run record to still be `planned`. HPC plans submit the saved script through `ssh <profile-host> qsub` on stdin. iHPC plans require saved `command_argv` and a fresh matching quota snapshot with active `cnode mynodes` compute-node evidence (the fresh `quotaSnapshotId` is ALWAYS required for the ban-critical node-pool gate, even on the approval path — an iHPC submit with only an `approvalId` hard-fails), and then run a fixed Python supervisor via `ssh <profile-host> ssh <active-cnode> python3 -` with supervisor code on stdin.

M3d monitoring supports two platform-specific paths. UTS HPC PBS uses `qstat -f <remote_job_id>`, bounded `tail -c <max_bytes> -- <plan-derived-log-path>`, and `qdel <remote_job_id>`. UTS iHPC supervised runs use the persisted supervisor pid, compute-node id, and stdout/stderr paths from the run record, then call only fixed Python helpers through `ssh <profile-host> ssh <ihpc-compute-node> python3 - <supervisor-spec>` for status, bounded logs, and approved process-group cancellation. Remote ids and log paths always come from local state created by `jobs.submit`, and cancel approvals are operation-specific so submit approvals cannot be reused.

M3e approval policy now uses shared server-side policy reasons for GPU requests, restricted/special queues, high CPU, high memory, long walltime, array jobs, high array concurrency, and iHPC supervised starts. `approvals.request` derives these reasons from the saved plan artifact when available, so clients cannot bypass system reasons by omitting them from tool input. It also adds operation-specific reasons for cancellation, retry, and transfer approvals, supports optional `previousProfileId` for auditable cross-account switches, and refuses to reuse an existing approval record for a new profile-switch context.

M3f retry planning creates a new saved plan and run record from a saved failed source run, or from a cancelled source run only when the caller supplies a reason. The tool accepts no replacement command, script, template, resources, workdir, remote job id, approval id, or plan hash. Retry artifacts carry `retry_of` lineage and `approval_operation: "jobs.retry"`. `approvals.request` rejects `jobs.submit` approval requests for retry-derived plans, and `jobs.submit` rejects retry-derived UTS HPC and UTS iHPC plans unless the approval operation is `jobs.retry`. UTS iHPC retry start reuses the same fixed supervisor, saved `command_argv`, active cnode evidence, workdir-root checks, and lineage checks as ordinary supervised starts.

### M4: Artifact And Analysis Loop

Status: first slice implemented for manifest-based listing, single-file fetch, bounded explicit batch fetch, fixed-file rsync transfer execution, artifact checksum verification, bounded transfer SHA-256 evidence, bounded local metric summary, dry-run cleanup planning, scoped cleanup execution for explicit latest-manifest regular file artifacts, persisted plan schemas, sanitized artifact/transfer resources, stricter transfer preflight verification, download post-transfer local destination verification, upload remote post-check verification, and broader conservative metric filename matching. Broad unbounded directory transfer, arbitrary local artifact summarization, raw-path cleanup, directory cleanup, glob cleanup, and recursive cleanup remain later work.

Deliverables:

- artifact listing and fetch. Implemented as `artifacts.list`, approved single-file `artifacts.fetch` by manifest `artifact_id`, and approved `artifacts.fetch.batch` for explicit manifest ids with total byte limits.
- fixed-file rsync transfer. Implemented as saved `transfers.plan` records plus approved `transfers.execute` with explicit file lists and total byte limits.
- checksum capture. Implemented for artifacts with SHA-256 capture during list plus post-fetch verification, and for fixed-file transfers with a server fixed SHA-256 cap: checksum-eligible upload/download files are verified, while oversized files record `skipped-large` and the evidence `checksum_policy`.
- metric extraction hooks. Implemented as a conservative local metrics extractor for fetched metric-like JSON, JSONL, NDJSON, CSV, and TSV files whose basename stem contains a safe separator-delimited metric/result/summary/eval/score token, such as `train_metrics.json`, `validation-results.ndjson`, `fold_0_scores.tsv`, or `wandb-summary.json`. It skips symlinks, oversized files, non-metric logs/text, binary/model files, secret-like filenames, and secret-like keys.
- result summary templates. Implemented as local markdown summary generation that cites run id, profile id, platform, plan hash, expected outputs, and extracted metrics.
- cleanup planning and scoped execution. Cleanup planning is implemented as local dry-run plan generation for declared remote outputs and local artifact cache files. Cleanup execution is implemented only for terminal runs, latest manifest hash, explicit manifest file ids, captured SHA-256/size evidence, exact cleanup approval scope, and regular-file unlink helpers.
- artifact record schemas. Implemented for manifests, single/batch fetch evidence, summaries, cleanup plans, and cleanup execution evidence.
- sanitized MCP artifact resources. Implemented for artifact indexes, aggregate artifact state, sanitized per-run manifests, cleanup plans, and cleanup execution evidence.
- persisted saved-plan schemas. Implemented for planned job artifacts and planned transfer artifacts.
- sanitized MCP transfer resources. Implemented for transfer indexes, aggregate state, saved plans, and execution evidence without raw scripts or local paths.

Acceptance:

- raw outputs remain traceable;
- destructive cleanup is not automated by default;
- summaries cite run ids, profile ids, and artifact paths.

M4 implemented MCP tools:

- `artifacts.list`
- `artifacts.fetch`
- `artifacts.fetch.batch`
- `artifacts.summarize`
- `artifacts.cleanup.plan`
- `artifacts.cleanup.execute`
- `transfers.execute`

M4 implemented MCP resources:

- `uts://artifacts`
- `uts://artifacts/{runId}/state`
- `uts://artifacts/{runId}/manifest`
- `uts://artifacts/{runId}/cleanup-plans`
- `uts://artifacts/{runId}/cleanup-executions`
- `uts://transfers`
- `uts://transfers/{runId}/state`
- `uts://transfers/{runId}/plan`
- `uts://transfers/{runId}/executions`

M4 artifact operations are intentionally not a generic remote file browser. `artifacts.list` accepts only `runId`, entry bounds, checksum byte bounds, and timeout. Candidate paths are derived from the saved plan `workdir` and declared `outputs`, must remain under the selected profile roots, and are inspected through a fixed read-only Python helper. The helper checks remote `realpath` values to reject symlink escapes from the planned workdir or output root.

`artifacts.fetch` accepts only `runId`, one manifest `artifactId`, one matching `artifacts.fetch` approval id, max bytes, and timeout. It reads the latest local artifact manifest, verifies the target is a file inside declared outputs, runs a fixed Python helper with an allowed root, verifies the returned SHA-256 against remote and manifest checksums, stores the artifact under `.uts-computing/artifacts/<runId>/files/`, writes evidence, appends a run event, and consumes the approval.

`artifacts.fetch.batch` accepts only `runId`, the latest `manifestHash`, explicit manifest `artifactIds`, one matching `artifacts.fetch.batch` approval id, per-file byte bounds, total byte bounds, and timeout. The approval must include a `resource_summary` with the same manifest hash, file ids, `max_bytes_per_file`, and `max_total_bytes`. The tool rejects mismatched manifests, duplicate ids, non-file artifacts, manifest totals beyond the approved total, and checksum mismatches before or during the fixed helper fetch path. It consumes the approval before the first remote fetch command.

`artifacts.summarize` accepts only `runId` and operates only on already-fetched local artifact files. It extracts bounded JSON values, JSONL/NDJSON row aggregates, and CSV/TSV column aggregates from allowlisted metric-like filenames whose safe stem tokens include metric/result/summary/eval/score terms; it does not parse `.log`, `.out`, `.err`, `.txt`, model checkpoints, archives, secret-like filenames, or arbitrary local paths.

`artifacts.cleanup.execute` accepts only `runId`, the latest `manifestHash`, explicit manifest `artifactIds`, one matching `artifacts.cleanup.execute` approval id, and timeout. It rejects non-terminal runs, stale manifests, non-file artifacts, artifacts without captured SHA-256 or size evidence, approval scope mismatches, directories, raw paths, globs, force flags, and recursive cleanup. The approval `resource_summary` must include the same `manifest_hash`, ordered `artifact_ids`, `delete_mode: "unlink-regular-files-only"`, exact `max_artifacts`, and exact `max_total_bytes`. The fixed remote helper validates realpath boundaries, rejects symlinks, checks regular-file status, size, and SHA-256 before deletion, and calls `os.unlink` only after all selected targets pass preflight. Local cached copies are removed only from `.uts-computing/artifacts/<runId>/files/` after symlink and realpath checks.

`transfers.plan` now persists a hashed transfer plan under `.uts-computing/transfers/<runId>/plan.json` when a fixed file list and `max_total_bytes` are supplied. `transfers.execute` accepts only `runId`, `approvalId`, and timeout. It reads the saved transfer plan, recomputes `plan_hash`, verifies a matching `transfers.execute` approval resource summary, preflights the exact file list and total bytes, verifies that helper metadata exactly matches the saved file list, byte accounting, and checksum policy, consumes approval, then runs fixed `rsync` argv with `--files-from=-`. For downloads, after rsync returns success and before writing execution evidence, it verifies that each local destination file exists, is not a symlink, resolves inside the planned destination, is a regular file, matches the preflight size, and for checksum-eligible files matches the remote preflight SHA-256. For uploads, local preflight captures checksum-eligible source SHA-256 values and rsync success is followed by a fixed remote post-check helper over the planned destination root and saved file list; size or checksum mismatches fail without writing successful execution evidence. Oversized files record `checksum_status: "skipped-large"` plus `checksum_policy` and are not claimed as content-hash verified. `rsync --checksum` is not treated as persisted checksum evidence. The tool does not accept execution-time source/destination/files, user-provided rsync flags, SSH options, delete/remove flags, globs, arbitrary checksum commands, or arbitrary local destinations.

Deferred M4/M5 improvements:

- optional additional metric filename phrases only after per-phrase review;
- optional configurable transfer checksum thresholds or alternate algorithms only after separate approval-scope, schema, and evidence review;
- broad destructive cleanup only after a separate design and approval review.

### M5: Packaging And Hardening

Status: implemented for shared plugin validation, host-neutral direct MCP stdio plugin smoke testing, client-neutral MCP workflow prompts, client-installed smoke prompt/evidence validation, schema migration planning, `state.migrate.plan` dry-run tooling, narrow `state.migrate.apply` schema-version writes, failure playbooks, expanded redaction corpus, structured tool results, iHPC protocol smoke tests, and mocked PBS failure tests. Real Codex/Claude Code in-client evidence files still must be collected before release.

Deliverables:

- Codex plugin packaging. Implemented as `.codex-plugin/plugin.json` pointing to shared `./skills/` and `./.mcp.json`.
- Claude Code plugin packaging. Implemented as `.claude-plugin/plugin.json` pointing to shared `./skills/` and `./.mcp.json`.
- plugin-root-relative manifest validation. Implemented as `npm run validate:plugin` plus packaging tests.
- host-neutral plugin smoke testing. Implemented as `npm run smoke:plugin:host-neutral`, which launches the MCP server from `.mcp.json` inside a temporary plugin root and performs offline tool/resource checks with example profiles only.
- MCP workflow prompts. Implemented for experiment planning, run triage, artifact collection, fixed-file transfer staging, and installed-client smoke evidence. Prompts return guidance only and do not execute tools, grant approvals, read secrets, or contact UTS systems.
- client-installed smoke evidence contract. Implemented as `npm run client-smoke:prompt` plus `npm run client-smoke:validate -- --require-both ...`, backed by `schemas/client-smoke-evidence.schema.json`.
- mock SSH/PBS tests. Implemented for success, pre-execution rejection, and key PBS qstat/tail/qdel failure paths.
- schema migration plan. Implemented in `docs/schema-migration-plan.md`.
- schema migration dry-run and apply. Implemented as read-only `state.migrate.plan` plus narrow `state.migrate.apply` that requires a matching migration plan hash, trusted confirmation token, blockers-free dry-run, and per-file backups before adding `schema_version`.
- redaction tests. Implemented as a dedicated redaction corpus plus existing access/quota/job evidence redaction tests.
- failure playbooks. Implemented in `docs/failure-playbooks.md`.
- structured MCP tool results. Implemented as a JSON envelope in both text content and `structuredContent`, with expected business failures returned as `isError: true` tool results.
- protocol-level iHPC job-operation smoke tests. Implemented for `jobs.status`, `jobs.logs`, and `jobs.cancel` schemas and calls.

Acceptance:

- both clients use the same MCP server and Skills;
- client-specific files are limited to plugin shims and setup notes;
- security policy is enforced in tests.

M5 implemented commands:

- `npm run validate:plugin`
- `npm run smoke:plugin`
- `npm run smoke:plugin:host-neutral`
- `npm run client-smoke:prompt`
- `npm run client-smoke:validate -- --require-both evidence/codex.json evidence/claude-code.json`

M5 validation checks:

- `.codex-plugin/plugin.json` and `.claude-plugin/plugin.json` use plugin-root-relative `./skills/` and `./.mcp.json`;
- client shim directories contain only plugin manifests;
- `.mcp.json` launches the shared MCP server from `mcp-server/dist/index.js`;
- shared Skill frontmatter is present;
- the built MCP server entrypoint exists before plugin testing.
- registered tools expose a conservative `ok` output schema and return matching `structuredContent`;
- registered tool input schemas reject unrecognized top-level arguments before handlers run, with protocol tests for dangerous extra fields such as raw paths, hosts, commands, globs, force flags, runtime roots, and execution-time file lists;
- protocol tests cover iHPC status/log/cancel calls without contacting UTS systems.
- migration tests cover optional `schema_version`, unsupported version rejection, corrupt/escaped state reporting, no-write dry-run guarantees, apply plan-hash binding, trusted confirmation, backup creation, and approval/run-state immutability.
- host-neutral smoke tests launch the packaged stdio MCP server from `.mcp.json` in a temporary plugin root, list core tools/resources/prompts, run `profiles.list`, `templates.list`, `state.migrate.plan`, fetch one safe prompt, and render one dry-run `jobs.plan` without VPN, SSH, UTS hosts, live submissions, transfers, artifact fetches, or migration apply.
- host-neutral smoke tests list core prompts and fetch one safe prompt without VPN, SSH, UTS hosts, live submissions, transfers, artifact fetches, or migration apply.
- host-neutral smoke tests never copy `profiles/profiles.local.yaml`, always force `profiles/profiles.example.yaml` in the child environment, and strip secret-like parent environment variables.
- client-installed smoke evidence validation rejects missing Codex/Claude evidence, missing UTS Skills/tools/resources/templates, wrong client manifest binding, profile/secret/path leaks, and forbidden live/mutating tool names.
- prompt protocol tests cover prompt inventory, required/enum arguments, all prompt bodies, prompt input redaction, no local state writes from prompt retrieval, Skill and approval guard language, and a static import guard that keeps prompt handlers free of live/state/action module imports.

Deferred M5 improvements:

- actual evidence files captured inside real Codex and Claude Code plugin hosts before release;
- future non-additive migration tools only after a separate backup, approval, confirmation, and fixture-tested design review;

## First Implementation Slice

The recommended first code slice is M1:

1. create a Node or Python MCP server skeleton;
2. load `profiles/profiles.example.yaml`;
3. validate profiles with `schemas/profile.schema.json`;
4. validate a minimal job spec with `schemas/job-spec.schema.json`;
5. render PBS CPU and iHPC background templates in dry-run mode;
6. write a local run record matching `schemas/run-record.schema.json`.

This gives useful agent behavior without touching live UTS systems.
