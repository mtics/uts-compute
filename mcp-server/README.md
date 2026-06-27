# MCP Server

This directory contains the shared local stdio MCP server used by Codex and Claude Code.

Current implementation scope:

- read profiles from `UTS_COMPUTING_CONFIG`;
- validate profiles and job specs against `schemas/`;
- render templates from `templates/`;
- perform dry-run planning without remote writes;
- expose narrow UTS HPC PBS and UTS iHPC adapters without generic remote shell access.

The server should expose structured tools instead of generic remote shell access. See [../docs/architecture.md](../docs/architecture.md) for the tool boundary.

## Implemented MCP Surface

Implemented tools:

- `profiles.list`
- `profiles.validate`
- `access.check`
- `access.doctor`
- `docs.refresh`
- `docs.search`
- `quotas.refresh`
- `approvals.request`
- `approvals.status`
- `approvals.decide`
- `approvals.list`
- `templates.list`
- `jobs.plan`
- `jobs.submit`
- `jobs.status`
- `jobs.logs`
- `jobs.cancel`
- `jobs.retry.plan`
- `jobs.adopt`
- `ihpc.campaign.preflight`
- `artifacts.list`
- `artifacts.fetch`
- `artifacts.fetch.batch`
- `artifacts.summarize`
- `artifacts.cleanup.plan`
- `artifacts.cleanup.execute`
- `transfers.execute`
- `transfers.plan`
- `state.migrate.plan`
- `state.migrate.apply`
- `sweep.retry.plan`
- `campaign.status`
- `campaign.audit`

Implemented resources:

- `uts://profiles`
- `uts://templates` and `uts://templates/{templateId}`
- `uts://quota-snapshots` and `uts://quota-snapshots/{snapshotId}`
- `uts://run-records` and `uts://run-records/{runId}`
- `uts://approval-records` and `uts://approval-records/{approvalId}`
- `uts://artifacts`, `uts://artifacts/{runId}/state`, `uts://artifacts/{runId}/manifest`, `uts://artifacts/{runId}/cleanup-plans`, and `uts://artifacts/{runId}/cleanup-executions`
- `uts://transfers`, `uts://transfers/{runId}/state`, `uts://transfers/{runId}/plan`, and `uts://transfers/{runId}/executions`
- `uts://docs` and `uts://docs/{docId}`
- `uts://docs-cache` and `uts://docs-cache/{sourceId}`

Implemented prompts:

- `plan-experiment`
- `triage-run`
- `collect-artifacts`
- `stage-transfer`
- `client-smoke-evidence`

Local verification:

```sh
npm install
npm test
npm run dry-run:sample
npm run validate:plugin
```

Tool results use a JSON envelope in both text content and `structuredContent`. Successful calls include `ok: true`; expected business failures include `ok: false` and top-level `isError: true` instead of surfacing as protocol failures. Registered tools expose a conservative output schema requiring `ok` so structured-output-aware clients can consume the envelope directly.

`jobs.plan` validates a job spec, renders a script, and writes a local planned run record under `.uts-computing/runs/` plus a saved plan artifact under `.uts-computing/plans/`. It does not run SSH, `qsub`, `cnode`, `rsync`, or any remote command.

`transfers.plan` validates and persists fixed-file transfer plans. It does not execute `rsync`.

`access.check` is the M2a read-only preflight tool. It checks one selected profile with DNS, TCP, SSH config, known-host, batch-auth, and remote identity probes. Its remote SSH command allowlist is limited to `true` and `id -un`.

`access.doctor` runs the same read-only diagnostics across profiles. With `--export-ssh` (the `exportSsh` flag) it instead returns a secret-free manual-handoff bundle for one explicit `profileId` — the real `login_host`, a `~/.ssh/config` snippet, and the required env-var **names** (never any value, key, password, or the real remote username) — and runs no remote probe. It is the human escape hatch when the plugin cannot reach the cluster, and fulfils the Phase-1 deferral of `login_host` disclosure.

`docs.search` is the M2 read-only local documentation search tool. It searches only the allowlisted docs shared with `uts://docs`, returns bounded line snippets and resource URIs, and does not fetch live URLs, probe VPN, or accept arbitrary paths.

`docs.refresh` is the fixed-source official documentation cache tool. It fetches only the built-in UTS HPC/iHPC documentation source allowlist, writes sanitized cache records under `.uts-computing/docs-cache/`, and exposes cached text through `uts://docs-cache/{sourceId}`. It does not accept arbitrary URLs, paths, hosts, headers, profile ids, proxy settings, or credentials. On a network-class fetch failure it adds an offline-handoff note pointing to `access.doctor --export-ssh` for a manual SSH access path. Default tests use a mock fetcher and do not require VPN or UTS website access.

`quotas.refresh` is the M2b/M2c read-only refresh tool. It gathers platform-specific identity, group, queue/node, session/job, and storage evidence through fixed SSH remote argv allowlists and writes redacted evidence under `.uts-computing/quotas/`.

M2d/M4 resources expose reusable local context without performing live checks. Runtime-backed resources are restricted to quota snapshots, run records, approval records, fixed-source documentation cache records, sanitized artifact manifests, and sanitized artifact cleanup evidence under `.uts-computing`; documentation and template resources use allowlisted project files or fixed source ids only.

M3a approval tools create local approval records under `.uts-computing/approvals/`. Approval requests require a fresh matching quota snapshot. Approval decisions require a trusted local confirmation token, for example `UTS_COMPUTING_APPROVAL_TOKEN`, and do not execute remote work.

M3e approval-policy hardening derives GPU, restricted queue, high CPU, high memory, long walltime, array, array concurrency, and iHPC supervised-run reasons from saved plan artifacts when available. Approval records also include operation-specific reasons for submit, cancel, retry, and transfer approvals, and optional `previousProfileId` records cross-account switch context.

M3b/M3c `jobs.submit` submits approved UTS HPC PBS plans and starts approved UTS iHPC supervised runs. It reads the saved plan artifact and approval record, recomputes the plan hash, then either runs `ssh <profile-host> qsub` with the saved PBS script on stdin or runs a fixed Python supervisor through `ssh <profile-host> ssh <active-cnode> python3 -`. Default tests mock these executors and do not contact UTS systems.

M3d tools provide the first monitoring and cancellation loop for UTS HPC PBS and UTS iHPC supervised runs. PBS runs use the recorded job id with `qstat -f`, saved plan-derived stdout/stderr paths with a byte bound, and `qdel <recorded-job-id>` after a matching `jobs.cancel` approval. iHPC runs use only persisted supervisor pid/node/log metadata and fixed Python helpers for status, bounded log tails, and approved process-group cancellation.

`jobs.retry.plan` creates a new local dry-run retry plan only from a saved failed run, or from a cancelled run with an explicit reason. It accepts only `sourceRunId`, `retryRunId`, and an optional redacted reason, writes retry lineage to the plan/run record, marks the plan as requiring `jobs.retry` approval, and performs no SSH, PBS, iHPC, rsync, or remote writes. UTS HPC and UTS iHPC retry plans can be submitted only with fresh quota evidence, matching saved retry lineage, and a matching `jobs.retry` approval; iHPC retries use the same fixed supervisor path and active `cnode mynodes` evidence as ordinary iHPC starts.

M4 transfer tools provide fixed-file rsync execution. `transfers.plan` persists a hashed transfer plan with explicit relative files and `max_total_bytes`; `transfers.execute` accepts only `runId`, `approvalId`, and timeout, verifies the saved plan and matching approval resource scope, preflights files and byte totals, verifies helper metadata against the saved file order and byte accounting, consumes approval, and runs fixed `rsync` argv with `--files-from=-`. For checksum-eligible files at or below the server fixed checksum cap, downloads verify the remote preflight SHA-256 against the local destination after rsync, while uploads verify the local preflight SHA-256 against a fixed remote post-check helper. Oversized files record `checksum_status: "skipped-large"` and the transfer `checksum_policy`; they are not claimed as content-hash verified. Downloads also verify local destination files after rsync success and before writing execution evidence. The tools do not accept arbitrary rsync flags, SSH options, delete/remove flags, raw execution-time paths, broad globs, arbitrary checksum commands, or arbitrary local destinations.

M4 artifact tools provide the first artifact loop. `artifacts.list` inspects only saved plan outputs through a fixed read-only Python helper and writes a local manifest with a `manifest_hash`. `artifacts.fetch` fetches one file artifact by manifest id, requires a matching `artifacts.fetch` approval, verifies SHA-256 against remote and manifest checksums, writes local evidence, and stores files under `.uts-computing/artifacts/<runId>/files/`. `artifacts.fetch.batch` fetches only explicit manifest file ids after a matching `artifacts.fetch.batch` approval whose `resource_summary` covers the same `manifest_hash`, file ids, per-file byte limit, and total byte limit. `artifacts.summarize` extracts bounded metrics from locally fetched allowlisted JSON, JSONL, NDJSON, CSV, and TSV files whose safe stem tokens include metric/result/summary/eval/score terms while skipping secret-like filenames and keys, symlinks, oversized files, non-metric logs, and arbitrary text. `artifacts.cleanup.plan` writes a dry-run plan only. `artifacts.cleanup.execute` deletes only explicit latest-manifest regular file artifacts for terminal runs after a matching `artifacts.cleanup.execute` approval whose `resource_summary` exactly covers `manifest_hash`, ordered `artifact_ids`, `delete_mode: "unlink-regular-files-only"`, `max_artifacts`, and `max_total_bytes`; it requires captured SHA-256 and size evidence and uses fixed unlink helpers. These tools do not accept arbitrary remote paths, hosts, SSH options, rsync flags, destination directories, raw cleanup paths, globs, directories, force flags, recursive cleanup, or delete flags.

Artifact manifest, single/batch fetch evidence, transfer execution evidence, summary, cleanup-plan, and cleanup-execution records validate against dedicated schemas. Artifact resources expose only sanitized manifest and cleanup evidence fields and never expose fetched file contents, raw cleanup helper args, or raw artifact browsing. Transfer resources expose only sanitized transfer evidence, including checksum status and policy when present.

M5 migration tools provide local state compatibility management. `state.migrate.plan` scans allowlisted `.uts-computing` state and returns a no-write plan hash. `state.migrate.apply` requires that plan hash plus a trusted confirmation token, rejects blockers or stale plans, backs up every changed file, and only adds `schema_version: "0.1.0"` to already-valid local records. It does not contact UTS systems or change approval/run state.

The iHPC scheduler is now internalized: the plugin ships a minimal progressor inline over SSH stdin per campaign launch (`mcp-server/src/ops/scheduler/seam/launch.ts` ships `PROGRESSOR_PY`, sourced from `mcp-server/src/ops/scheduler/node/progressor.py`), so the old node-resident-scheduler control plane — the `ihpc.scheduler.deploy` (rsync the vendored payload + version-pin) and `ihpc.scheduler.version` (read the on-node contract) tools — has been retired. The vendored `ihpc-scheduler/` tree is now a decorative, reference-only snapshot: it is unreferenced by `mcp-server/src` runtime and is excluded from the `.mcpb` bundle (via `.mcpbignore`). Its `UPSTREAM`/`PROVENANCE.json` files are a one-time source note only — there is no live provenance enforcement (no `check:provenance` guard, no re-vendoring script, no CI drift check). `npm run test:python` still runs the vendored pytest suite as a regression check. See the repository [README.md](../README.md#vendored-ihpc-scheduler-reference-snapshot) for details.

`ihpc.campaign.preflight` validates a campaign's queue YAML before launch. It is pure and local — no SSH — and checks the structural contract (`my_nodes` non-empty; each `experiments[]` entry has a string `name`/`command` and boolean `requires_gpu`), the local existence of each experiment's `--dataset <name>` CLI flag against a caller-supplied case-sensitive `datasetDirs` list (catching `MovieLens` ≠ `ML`), and the embedded `--param_overrides '{...}'` JSON shape against an optional `parameterSpace` schema. It returns structured `{ level, path, message }` findings and never probes datasets or GPUs remotely.

The iHPC start path inside `jobs.submit` runs a single process on one node, so it hard-stops a spec with `resources.array` or `resources.ngpus > 1` with a message pointing to the internalized scheduler control plane (`campaign.submit`, which ships the progressor inline over SSH); a multi-GPU or array workload must use that control plane rather than be run once here. Run records carry an optional platform-agnostic `placement` field (`hostname`/`node_id`/`gpu_index`/`slots_per_gpu`/`started_at`/`placement_hash`) carrying scheduler-reported placement supplied through `jobs.adopt`; the plugin never probes GPUs, PBS records leave it absent, and `jobs.history`/`jobs.status` surface it when present. Adopted iHPC runs remain history-only by design — reconciliation (`jobs.status`/`logs`/`cancel`) still requires supervisor metadata inside the profile roots, which only `jobs.submit`/`jobs.retry`-started runs expose, because guessing those paths for an externally-started process would bypass a hard security boundary.

The iHPC start path also enforces a per-account hard cap: before launch it runs `checkIhpcNodePoolConformance` against the selected profile's own `defaults.node_limits` (set from the portal "My Node Limits") and hard-blocks starting another node in a pool already at its cap with a `node-pool-exceeded` violation — the iHPC analogue of the existing PBS per-user `qstat -u` block. Both gates check **one** profile against **its own** caps only and never sum across accounts; if `defaults.node_limits` is unset there is no enforceable iHPC cap. `sweep.retry.plan` re-plans only a finished sweep's `failedIndices` (from the original `parameters` grid, re-expanded like `sweep.rank`) into a smaller PBS array plan with `sweep_retry_of` lineage hashed into the new `plan_hash`; it is dry-run only (no SSH, no source-run mutation, no auto-submit), so re-submission still flows through the conformance-gated `jobs.submit`. `campaign.status` and `campaign.audit` are the read-only campaign ledger; its purpose is **disclosure/attribution, not concealment**. Using `campaign_id` (required on the sweep fan-out, optional on a single job) plus the optional non-credential `defaults.owner`/`allocation` labels, `campaign.status` discloses one campaign's per-account run counts (a derived rollup over saved run records) and `campaign.audit` flags any account already over its own cap against that account's own latest quota snapshot — surfacing an over-cap account, never excusing it, and never summing usage across accounts.

MCP prompts provide user-invoked workflow entry points for experiment planning, run triage, artifact collection, fixed-file transfer staging, and installed-client smoke evidence. They return guidance messages only; they do not execute tools, grant approvals, read secrets, or contact UTS systems.
