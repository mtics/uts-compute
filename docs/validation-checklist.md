# Validation Checklist

Use this checklist before handing the package to agents or installing it as a plugin.

## Local M1

- `npm test` passes.
- `npm run dry-run:sample` renders a script and writes a planned run record under `.uts-computing/runs/`.
- No M1 path accepts arbitrary absolute paths from model-controlled MCP input.
- No M1 tool runs SSH, `qsub`, `qstat`, `pbsnodes`, `cnode`, `rsync`, VPN probes, or UTS remote hosts.
- Audit records redact common passwords, tokens, API keys, MFA values, and URL credentials.

## Skills

- Every `skills/*/SKILL.md` has valid frontmatter with `name` and `description`.
- Skill descriptions are narrow enough for automatic loading.
- Each Skill states the current implemented capability boundary and later milestone stop conditions.
- Each Skill stops when a required live MCP tool is unavailable.
- Skill references are plugin/repository-root relative.

## Plugins

- `npm run validate:plugin` passes.
- `.claude-plugin/plugin.json` uses `./skills/` and `./.mcp.json` (Claude MCP config, `${CLAUDE_PLUGIN_ROOT}` launch arg).
- `.claude-plugin/` contains only `plugin.json` + `marketplace.json`; no duplicated MCP/Skill implementation.
- The Claude manifest does not point outside the plugin root with `../`.
- Every `skills/<name>` is mirrored under `.agents/skills/<name>` so Codex and other agents discover the same Skills.
- `mcp-server/dist/index.js` exists before plugin/MCP testing.
- Claude Code (plugin) and Codex (standard MCP config + `.agents/skills`) load the same shared `skills/` Skills and the same `mcp-server/dist/index.js`.

## M2 Read-Only Live Queries

- Remote commands are argv-level allowlisted.
- `access.check` records VPN, DNS, TCP, SSH identity, and host-key evidence.
- Default tests for `access.check` use mocks and do not touch real DNS, TCP, SSH, VPN, UTS hosts, or known_hosts.
- MCP protocol smoke tests confirm the stdio server exposes the implemented tool inventory.
- `docs.refresh` accepts only optional fixed `sourceIds`, `maxBytes`, and `timeoutMs`; it must not accept path, URL, host, headers, profile, proxy, credential, live, regex, or output-directory inputs.
- `docs.refresh` fetches only the server-side official UTS documentation source allowlist, rejects unsupported MIME types, redirects, oversized responses, unknown source ids, duplicate source ids, and cache directories outside `.uts-computing`.
- `docs.refresh` returns bounded summaries and `uts://docs-cache/{sourceId}` references, not absolute cache paths or full document bodies in tool output.
- `docs.search` accepts only query, optional allowlisted doc ids, and result/snippet bounds; it must not accept path, URL, host, profile, live, regex, or timeout inputs.
- `docs.search` returns bounded snippets plus `uts://docs/{docId}` references and must not expose absolute project paths, `.uts-computing` paths, or full document bodies.
- `quotas.refresh` records `observed_at`, source commands, raw evidence paths, parsed limits, and freshness status.
- Current `quotas.refresh` supports UTS HPC and UTS iHPC with separate command allowlists.
- MCP resources expose redacted `profiles`, `templates`, `quota-snapshots`, `run-records`, local documentation context, and fixed-source documentation cache context.
- Resource URI templates reject unsafe ids and do not provide arbitrary project or runtime file reads.
- Public and cached documentation facts are treated as defaults only, not account-specific limits.
- Stale quota snapshots block submission planning that depends on them.

## M3 Controlled Submission

- Every submission has exactly one `profile_id`.
- Every submission is tied to a `plan_hash`.
- Every approval is tied to the same `plan_hash` and `quota_snapshot_id`.
- Approval state is explicit: `not_required`, `required`, `approved`, `rejected`, or `expired`.
- Approval decisions require a trusted local confirmation token and must not be model self-approval.
- Approval requests reject missing, stale, mismatched, or cross-profile quota snapshots.
- Approval requests derive system risk reasons from saved plan artifacts when available; callers cannot bypass GPU, restricted queue, high CPU, high memory, long walltime, array, high concurrency, or iHPC supervised-run reasons by omitting `reasons`.
- Approval ids and records are operation-specific; `jobs.submit`, `jobs.cancel`, and `jobs.retry` approvals cannot be reused across operations.
- Cross-account switches after planning must include explicit profile-switch context through `previousProfileId` or equivalent user-facing approval context.
- `jobs.submit` accepts only `runId`, `approvalId`, and timeout; it must not accept scripts, commands, hosts, queues, paths, qsub flags, or SSH options.
- Retry-derived plans must carry `retry_of` lineage and `approval_operation: "jobs.retry"`; `approvals.request` and `jobs.submit` must reject `jobs.submit` approval for them.
- `jobs.retry.plan` accepts only `sourceRunId`, `retryRunId`, and optional redacted `reason`; it must reject non-failed runs, cancelled runs without a reason, existing retry targets, tampered source plan hashes, and ambiguous source workdirs before writing retry state.
- `jobs.submit` submits UTS HPC PBS plans only through the allowlisted `ssh ... -T <profile-host> qsub` adapter with the saved plan script on stdin.
- `jobs.submit` starts UTS iHPC plans only through the allowlisted `ssh ... -T <profile-host> ssh <active-cnode> python3 -` adapter with fixed supervisor code on stdin.
- UTS iHPC retry start must use the same fixed supervisor path as ordinary iHPC starts and must reject mismatched retry lineage before command execution.
- iHPC live start requires saved `command_argv`, a fresh matching quota snapshot, active `cnode mynodes` evidence, and a workdir under profile roots.
- `jobs.status` accepts only `runId` and timeout; it must query only the run-record PBS job id with `qstat -f` or the run-record iHPC supervisor pid/node with a fixed Python status helper.
- `jobs.logs` accepts only `runId`, stream, max bytes, and timeout; it must derive PBS log paths from the saved PBS plan artifact and iHPC log paths from persisted supervisor metadata.
- `jobs.cancel` accepts only `runId`, `approvalId`, and timeout; it must require a matching operation-specific `jobs.cancel` approval and run only `qdel <recorded-job-id>` for PBS or a fixed Python process-group cancellation helper for iHPC.
- Default submission and job-operation tests use a mock executor and do not touch real SSH, VPN, UTS hosts, `qsub`, `qstat`, `qdel`, or iHPC compute nodes.
- No generic remote shell tool exists.
- Remote paths are canonicalized before writes, transfers, and artifact fetches.

## M4 Artifact And Analysis

- `transfers.plan` persists a deterministic transfer plan when explicit `files` and `max_total_bytes` are supplied; it must not execute rsync.
- `transfers.execute` accepts only `runId`, `approvalId`, and timeout; it must not accept execution-time source, destination, files, rsync flags, SSH options, or delete/remove flags.
- `transfers.execute` must read the saved transfer plan, recompute `plan_hash`, require a matching `transfers.execute` approval resource summary, preflight exact files and total bytes, consume approval before rsync, and run fixed `rsync --files-from=-` argv through a mockable executor.
- Remote transfer preflight metadata must exactly match the saved file order, byte accounting, and checksum policy; missing, extra, duplicate, negative-size, fractional-size, wrong-total, invalid checksum, missing checksum status, checksum-eligible skipped, or over-limit captured helper output must fail before approval consumption or rsync execution.
- Download transfer execution must verify local destination files after rsync success and before execution evidence is written: each saved-plan file must exist, not be a symlink, resolve inside the planned destination, be a regular file, match the preflight size, and for checksum-eligible files match the remote preflight SHA-256.
- Upload transfer execution must compute local preflight SHA-256 for checksum-eligible files and, after rsync success, run only the fixed remote post-check helper against the planned destination root and saved file list; remote size or checksum mismatches must fail before execution evidence is written.
- Oversized transfer files must record `checksum_status: "skipped-large"` plus `checksum_policy` and must not carry a SHA-256 or be described as content-hash verified.
- Transfer execution must reject missing files, duplicate/unsafe file entries, roots outside profile workspace/scratch/project policies, local destinations outside `.uts-computing/transfers`, wrong-operation approvals, used approvals, and resource-scope mismatches before rsync execution.
- Planned job and planned transfer artifacts validate against dedicated persisted-artifact schemas without adding metadata fields to `plan_hash` payloads.
- `uts://transfers` and `uts://transfers/{runId}/state|plan|executions` expose sanitized transfer context only, with allowlisted checksum evidence fields when present and no raw scripts, raw local paths, host aliases, helper output, or `files/...` browsing.
- `artifacts.list` accepts only `runId`, entry/checksum bounds, and timeout; it must not accept host, username, SSH options, raw remote paths, globs, regexes, rsync flags, local destinations, or cleanup flags.
- `artifacts.list` derives paths only from saved plan `workdir` plus declared `outputs`, and rejects outputs outside the planned workdir or selected profile roots before command execution.
- The remote artifact-list helper uses fixed `ssh ... python3 - <artifact-spec>` and checks remote `realpath` values to reject symlink escapes.
- `artifacts.fetch` accepts only `runId`, one manifest `artifactId`, one matching `artifacts.fetch` approval id, max bytes, and timeout.
- `artifacts.fetch` reads from the latest local manifest, fetches only regular files inside declared outputs, verifies SHA-256 against remote and manifest checksums, writes local evidence, appends a run event, and consumes the approval.
- `artifacts.fetch` rejects wrong-operation approvals, used approvals, mismatched plan hashes, stale/missing run metadata, unsafe artifact ids, and manifest paths outside declared outputs before command execution.
- `artifacts.fetch.batch` accepts only `runId`, `manifestHash`, explicit unique manifest `artifactIds`, one matching `artifacts.fetch.batch` approval id, per-file byte bounds, total byte bounds, and timeout.
- `artifacts.fetch.batch` approval `resource_summary` must cover the same `manifest_hash`, ordered `artifact_ids`, `max_bytes_per_file`, and `max_total_bytes`; changing any of these fields creates a distinct approval scope hash.
- `artifacts.fetch.batch` rejects duplicate ids, mismatched manifests, non-file artifacts, manifest totals over `maxTotalBytes`, per-file size overruns, wrong-operation approvals, and checksum mismatches; it must not run remote commands before these preflight checks pass.
- `artifacts.summarize` and `artifacts.cleanup.plan` operate only on local `.uts-computing/artifacts/<runId>/` state.
- `artifacts.summarize` accepts only `runId`, reads only already-fetched local `files/`, and must not accept local paths, remote paths, hosts, SSH options, globs, regexes, file extensions, parser settings, or output directories.
- `artifacts.summarize` only extracts from allowlisted metric-like JSON/JSONL/NDJSON/CSV/TSV filenames whose safe stem tokens include metric/result/summary/eval/score terms; it skips logs, text dumps, binary/model/archive formats, symlinks, files over 1 MB, total metric reads over 5 MB, secret-like filenames, and secret-like keys.
- `artifacts.summarize` aggregates JSONL/CSV/TSV rows into metric stats and must not embed full raw tables or large text in summaries.
- `artifacts.cleanup.execute` input schema must require `runId`, `manifestHash`, `artifactIds`, and `approvalId`, bound `artifactIds` to at most 100, and reject raw path, host, command, glob, force, directory, and recursive cleanup controls.
- `artifacts.cleanup.execute` must reject non-terminal runs, stale manifest hashes, duplicate ids, non-file artifacts, artifacts without captured SHA-256, artifacts without size evidence, approval mismatches, and total bytes above the cleanup cap before deletion.
- `artifacts.cleanup.execute` approval `resource_summary` must exactly match `manifest_hash`, ordered `artifact_ids`, `delete_mode: "unlink-regular-files-only"`, `max_artifacts`, and `max_total_bytes`.
- The cleanup helper must use fixed SSH/Python argv, validate realpath boundaries, reject symlinks, require regular files, verify size and SHA-256 for every selected artifact before unlinking, and call `os.unlink` only for the selected regular files.
- Artifact manifests, single/batch fetch evidence, summaries, cleanup plans, and cleanup execution records validate against dedicated schemas.
- `uts://artifacts`, `uts://artifacts/{runId}/state`, `uts://artifacts/{runId}/manifest`, `uts://artifacts/{runId}/cleanup-plans`, and `uts://artifacts/{runId}/cleanup-executions` expose sanitized artifact context only, with no raw remote paths, local paths, fetched content, raw cleanup helper args, helper stdout/stderr, or `files/...` resource browsing.
- Artifact resource tests cover unsafe run ids and symlink escapes before reading manifest or cleanup evidence content.
- Cleanup planning is dry-run only; cleanup execution is available only through the scoped approval path above.
- Default artifact tests use mock executors and do not touch real SSH, VPN, UTS hosts, remote filesystems, `rsync`, or cleanup commands.

## M5 Packaging And Hardening

- `docs/plugin-setup.md`, `docs/schema-migration-plan.md`, and `docs/failure-playbooks.md` are present and exposed through `uts://docs` and searchable through `docs.search`.
- Plugin validation enforces shared `skills/`, shared `.mcp.json`, safe plugin-root-relative paths, safe MCP env values, and built MCP entrypoint presence.
- `npm run smoke:plugin:host-neutral` launches the MCP server from `.mcp.json` in a temporary plugin root, always uses example profiles inside that child environment, never copies local profile files, strips secret-like parent environment variables, and runs only offline checks.
- Redaction tests cover passwords, tokens, API keys, access/refresh tokens, client secrets, secret access keys, private keys, bearer tokens, MFA/OTP, and URL credentials.
- PBS failure tests cover qstat failure, tail failure, and qdel failure without consuming cancel approval on failed qdel.
- MCP tool results include a JSON text fallback and matching `structuredContent`; expected business failures return tool results with `isError: true`, `ok: false`, and a redacted error message.
- MCP tool input schemas must be strict at the top level: dangerous extra arguments such as raw `path`, `url`, `host`, `command`, `remoteJobId`, `remotePath`, `glob`, `force`, `files`, or `runtimeRoot` must fail protocol validation before any handler runs.
- Protocol smoke tests cover iHPC `jobs.status`, `jobs.logs`, and `jobs.cancel` schemas and calls without live SSH.
- MCP prompt tests cover prompt inventory, required/enum arguments, all prompt bodies, no local state changes from `prompts/get`, redaction of path/secret-like user prompt arguments, Skill references, operation-specific approval language, and static import guards that prevent prompt handlers from importing live/state/action modules.
- Schema changes follow the migration plan: reader fallback first, `state.migrate.plan` dry-run before write, tests for old/new/unsupported-version fixtures, no-write file-hash checks, and backups before mutation.
- `state.migrate.plan` has no write/apply/confirm input, reports `writes_planned: false`, does not call approval/run-state helpers, and leaves expired approvals plus run records unchanged.
- `state.migrate.apply` accepts only `planHash` and `confirmationToken`; it must reject stale plan hashes, invalid tokens, blocked records, corrupt JSON, symlink escapes, and unsupported versions before writing.
- `state.migrate.apply` must back up every changed file under `.uts-computing/backups/<timestamp>/`, add only schema-version fields to already-valid records, preserve approval/run state fields, and avoid all SSH/VPN/UTS/rsync calls.
- Failure triage follows `docs/failure-playbooks.md` and must start from local state plus narrow MCP tools, not direct shell commands.
- `client-smoke:prompt` generates fixed prompts and evidence templates for real client-installed smoke checks.
- `client-smoke:validate -- --require-both <codex-evidence.json> <claude-code-evidence.json>` validates one Codex and one Claude Code installed-client evidence file against `schemas/client-smoke-evidence.schema.json`.
- Real client-installed smoke evidence remains required before release: discover Skills, list profiles/templates, read docs context, run `state.migrate.plan`, and run dry-run `jobs.plan` in both Codex and Claude Code. Direct MCP stdio smoke output must not be treated as installed-client evidence.
