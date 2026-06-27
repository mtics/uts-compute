# Architecture

## Design Goal

Build one shared UTS computing capability package that works for both Codex and Claude Code.

The core design is:

```text
Claude Code plugin     Codex (standard MCP+Skills)     other agents
        |                       |                            |
        +-----------+-----------+----------------------------+
                    |
               shared Skills  (skills/ + .agents/skills/ mirror)
                    |
             shared MCP server
                    |
   profiles + schemas + templates + audit state
                    |
       UTS HPC adapter      UTS iHPC adapter
```

The bottom row (`UTS HPC adapter` / `UTS iHPC adapter`) is a runtime *concept*, not a directory. Each platform's allowlisted command adapter is implemented inline inside the relevant business-op modules (for example `ops/jobs`, `ops/quotas`), branching on the profile platform. There is no `src/adapters/` directory.

## Source Layout

The MCP server (`mcp-server/src/`) is organized in layers, not as a flat directory:

```text
mcp-server/src/
  index.ts, cli.ts                              executables (stay at root)
  mcp/    prompts.ts, resources.ts, schemas.ts  MCP protocol surface
  core/   types, ids, paths, config, audit,     foundations
          validation, access, test-executors
  lib/    shared, process, redact, evidence,    pure primitives
          ssh, auth, walltime, remote-python
  ops/    business ops, subdivided by domain:
    ops/jobs/      jobs, submit, retry, ihpc-start, diagnose, history, accounting, sweep
    ops/approvals/ approvals, approval-policy, submission-approval
    ops/quotas/    quotas, quota-limits, capacity, conformance, rightsize
    ops/plans/     planner, plan-store, spec-diff, command-argv, reproducibility
    ops/data/      artifacts, transfer, migrations
    ops/access/    doctor, confirm-usage
    ops/profiles/  onboarding, project, projects
    ops/catalog/   docs, templates
```

Tests mirror this layout under `mcp-server/tests/{core,lib,ops,integration}/` plus shared `tests/{helpers,fixtures}/`.

Dependency direction flows inward: `ops/*` depend on `core/` and `lib/`; `core/` depends on `lib/`; `lib/` is leaf-level pure primitives with no upward imports. A CI guard, `mcp-server/scripts/lint-no-dup-lib-defs.mjs` (run in `pretest`), forbids any module from re-defining a name that `lib/` already exports, keeping shared primitives single-sourced.

## Package Boundary

The package is not a remote scheduler replacement and not a policy bypass layer. It is a local assistant integration that helps agents:

- understand platform rules;
- select explicit account profiles;
- validate resource requests;
- prepare reproducible experiments;
- submit and monitor jobs only through approved tools;
- collect artifacts and audit records.

## Composition Rules

Use the layers deliberately:

- Skills own workflow, platform choice, account-selection policy, approval prompts, tool order, and stop conditions.
- MCP tools own validation, dry-run rendering, live queries, live actions, state mutation, and audit records.
- MCP resources expose reusable context such as profile summaries, quota snapshots, template catalogs, local UTS documentation, and run records.
- MCP prompts expose user-invoked guided workflow entry points. They return guidance messages only and must not replace Skills, execute tools, or hide approvals.
- Plugin shims own discovery and packaging only.

Skills must not reimplement SSH, PBS, iHPC, transfer, quota, or artifact logic. When a required MCP tool is missing, the Skill should stop and state the missing milestone rather than falling back to direct shell commands.

## MCP Server Boundary

MCP is the execution and live-state plane.

Initial MCP tools should be:

| Tool | Purpose | Safety mode |
| --- | --- | --- |
| `profiles.list` | List configured profile ids and metadata. | Read-only |
| `profiles.validate` | Validate a profile against schema and local secret references. | Read-only |
| `access.check` | Check VPN, DNS, TCP, SSH, and remote identity preflight. | Read-only |
| `access.doctor` | Live health check across one or all profiles: connectivity battery, remote clock-skew, and PBS scheduler reachability, aggregated into an ok/warn/fail report. | Read-only |
| `docs.refresh` | Refresh a fixed allowlist of official UTS documentation pages into local cache. | Read-only |
| `docs.search` | Search allowlisted local platform/project docs and return bounded snippets. | Read-only |
| `profiles.onboard` | First-run gate: connect to the account, confirm live access (remote identity observed), persist an onboarding marker, and report the discovered limits + capacity. Required once per profile before live submission. | Confirm |
| `quotas.refresh` | Refresh queue, node, group, session, and storage limits for one profile. | Read-only |
| `quotas.capacity` | From a saved snapshot, advise per-queue run/queued headroom, which queue has room, recommended parallelism, and storage usage (iHPC: available cnode families + sessions). Local state only. | Read-only |
| `jobs.plan` | Convert experiment intent into a validated job spec and dry-run script, capturing a reproducibility block (git sha/branch/dirty + redacted command) and a git-derived project + content-addressed `project_hash` into the run record (neither folded into plan_hash). | Dry-run |
| `sweep.plan` | Expand a declared hyperparameter grid into one PBS array job plan (single plan_hash) plus the index->params table, selecting params per element via `$PBS_ARRAY_INDEX`. UTS HPC CPU arrays only. | Dry-run |
| `jobs.submit` | Submit an approved UTS HPC PBS job or start an approved UTS iHPC supervised run from saved local plan state. | Confirm |
| `jobs.status` | Query PBS job or iHPC supervised-run state from saved local run records; also surfaces the exec node and live usage (core/GPU-hours, CPU efficiency) parsed from the same qstat output. | Read-only |
| `jobs.track` | Re-poll every active run that has a remote job id and reconcile each saved run record to live PBS/iHPC state in one read-only sweep (with node + usage per run); skips terminal/planned runs, bounds the SSH fan-out, and caps the polled set (truncation flagged). | Read-only |
| `jobs.logs` | Fetch bounded stdout/stderr tails and agent audit records from saved local plan or supervisor paths. | Read-only |
| `jobs.cancel` | Cancel an explicit PBS job id or iHPC supervised process group with approval. | Confirm |
| `jobs.retry.plan` | Create a new local retry plan from a failed or explicitly explained cancelled run; optionally escalate resources (memory/walltime 1-4x, conformance-capped) for an OOM/timeout, or resume from a declared checkpoint for a session-timeout. | Dry-run |
| `sweep.rank` | Rank a finished sweep's array members by a supplied metric (joined to configs via the original grid) and return the top-k for a higher-budget follow-up rung. Read-only/pure. | Read-only |
| `jobs.history` | List a compact, secret-free summary across saved local run records, newest first, with optional profile/platform/status/project/since filters. | Read-only |
| `projects.list` | Per-project rollup across saved local run records: each project (git-derived grouping) with its `project_hash`, total/active counts, status breakdown, profiles, platforms, and last-updated time. Local state only. | Read-only |
| `jobs.usage` | Report PBS usage accounting for one run (core-hours, GPU-hours, CPU efficiency from `qstat -x`); framed in hours, not cost; null for iHPC. | Read-only |
| `jobs.rightsize` | Compare a project's runs' requested vs actually-used memory/walltime (from persisted run-record usage) and recommend a saner request; flags 10x over-requests. Local state only. | Read-only |
| `jobs.diagnose` | Combine `jobs.status` + bounded `jobs.logs` and classify a failure (access/quota/resource/environment/command/data-path/session-timeout) with the safe next action. | Read-only |
| `artifacts.list` | List outputs for a run inside approved paths. | Read-only |
| `artifacts.fetch` | Fetch one selected artifact with checksums. | Confirm |
| `artifacts.fetch.batch` | Fetch an explicit bounded batch of manifest artifacts. | Confirm |

Do not add a generic unrestricted `run_shell` tool. If debugging requires shell access later, expose a separate admin/debug namespace with strict allowlists and explicit user approval.

The implemented surface is the full set of 47 MCP tools registered in `mcp-server/src/index.ts`, spanning M1 local dry-run, M2 read-only context, M3 controlled submission/monitoring, the M4 artifact loop, plus fixed-file transfer and local state migration:

| Tool | Purpose | Safety mode |
| --- | --- | --- |
| `profiles.list` | List redacted local profile summaries. | Read-only |
| `profiles.validate` | Validate local profiles and return semantic warnings. | Read-only |
| `profiles.onboard` | First-run gate: connect, confirm live access, persist an onboarding marker, and report discovered limits + capacity. Required once per profile before live submission. | Confirm |
| `access.check` | Run VPN/DNS/TCP/SSH/host-key preflight for one profile and write redacted local evidence. | Read-only |
| `access.doctor` | Aggregate a live ok/warn/fail health check across one or all profiles: connectivity battery + remote clock-skew + PBS scheduler reachability. | Read-only |
| `access.confirm_usage` | SSH through one iHPC profile's login gateway to a named compute node and run `confirm_usage <token>` in response to a node-usage-monitoring email. | Effectful remote |
| `docs.refresh` | Refresh fixed official UTS documentation sources into a bounded local cache. | Read-only |
| `docs.search` | Search allowlisted local documentation snippets and return `uts://docs/{docId}` references. | Read-only |
| `quotas.refresh` | Refresh platform-specific read-only identity, group, queue/node, session/job, and storage evidence for one profile. | Read-only |
| `quotas.capacity` | From a saved snapshot, advise per-queue run/queued headroom, recommended parallelism, and storage usage (iHPC: available cnode families + sessions). Local state only. | Read-only |
| `approvals.request` | Create or retrieve a local approval record bound to one plan hash and quota snapshot. | Local state |
| `approvals.status` | Read local approval state and expire stale required approvals. | Read-only |
| `approvals.decide` | Record approved/rejected decision only with trusted local confirmation token. | Confirm |
| `approvals.list` | Enumerate local approval records (id, run, profile, operation, state, timestamps) so the approval id a token-gated action needs can be found. | Read-only |
| `templates.list` | List dry-run templates. | Read-only |
| `jobs.plan` | Validate a job spec, render dry-run script text, and write a planned local run record (with a reproducibility block and a git-derived project + `project_hash`). | Dry-run |
| `sweep.plan` | Expand a hyperparameter grid into one PBS array plan (single plan hash) plus the index-to-params table. | Dry-run |
| `sweep.rank` | Rank a finished sweep's array members by a supplied metric (joined to configs via the original grid) and return the top-k for a higher-budget follow-up rung. | Read-only |
| `sweep.retry.plan` | Re-plan only a finished sweep's failed array members (from the original grid + `failedIndices`, re-expanded like `sweep.rank`) into a new, smaller PBS array plan with `sweep_retry_of` lineage hashed into the new `plan_hash`. Dry-run only (no SSH, no source-run mutation, no auto-submit); re-submission flows through the conformance-gated `jobs.submit`. UTS HPC CPU sweeps only. | Dry-run |
| `jobs.submit` | Submit an approved UTS HPC PBS job or start an approved UTS iHPC supervised run from saved local plan state. | Confirm |
| `jobs.status` | Query `qstat -f` for UTS HPC PBS or a fixed iHPC supervisor status helper for UTS iHPC. | Read-only |
| `jobs.track` | Sweep every active run: re-poll `qstat`/the iHPC supervisor helper for each and reconcile saved status in one call; bounded concurrency, capped polled set with a truncation flag, optional profile/platform filters. | Read-only |
| `jobs.logs` | Fetch bounded stdout/stderr log content from saved PBS plan paths or saved iHPC supervisor paths. | Read-only |
| `jobs.cancel` | Cancel the recorded UTS HPC PBS job id or UTS iHPC supervisor process group with a matching `jobs.cancel` approval. | Confirm |
| `jobs.retry.plan` | Write a new local retry plan/run record with retry lineage and `jobs.retry` approval operation. | Dry-run |
| `jobs.history` | List a compact, secret-free summary across saved local run records with profile/platform/status/project/since filters. | Read-only |
| `jobs.adopt` | Synthesize a local run record for an existing remote job from external evidence (`qstat -x` for PBS; observed node+pid for iHPC, history-only) so status/usage/logs/cancel/history work on externally-started work. Idempotent. | Local state |
| `projects.list` | Per-project rollup across saved local run records (git-derived grouping + `project_hash`, total/active counts, status breakdown). Local state only. | Read-only |
| `campaign.status` | Disclose one campaign's allocations: for a `campaign_id`, which owner's allocation contributed which runs (per-account run counts, status breakdown, attestation). Disclosure/attribution only — never sums usage across accounts. Derived rollup over saved run records; no SSH. | Read-only |
| `campaign.audit` | Fair-use audit of a campaign: disclose its per-owner allocations and flag any account already over its OWN cap (iHPC node-pool or PBS per-user) against that account's own latest quota snapshot. Checks each account against its own caps only, never sums across accounts, never excuses an over-cap account. Local state only; no SSH. | Read-only |
| `campaign.submit` | Autonomous, conformance-gated launch of one iHPC campaign's planned runs: take the per-node single-writer lease from node STATE (never clobbered), GATE on the HARD per-account iHPC node-pool cap from a REQUIRED fresh quota snapshot (the ban-prevention; never sums across accounts), build the GPU-count-bounded immutable plan, then over SSH write the plan and start the resident progressor once for the node. No approval token (ADR-0004, like `jobs.submit`) — conformance is the gate. | Confirm |
| `jobs.usage` | Report PBS core-hours, GPU-hours, and CPU efficiency for one run from `qstat -x`; null for iHPC. | Read-only |
| `jobs.rightsize` | Compare a project's runs' requested vs actually-used memory/walltime from persisted run-record usage and recommend a saner request; flags 10x over-requests. Local state only. | Read-only |
| `jobs.diagnose` | Classify a failed run (access/quota/resource/environment/command/data-path/session-timeout) from status + bounded logs, with the safe next action. | Read-only |
| `ihpc.campaign.preflight` | Validate a campaign's queue YAML before launch (pure/local, no SSH): structural shape (`my_nodes`/`experiments[name,command,requires_gpu]`), local dataset existence from the `--dataset` flag (case-sensitive, `MovieLens` ≠ `ML`), and `param_overrides` JSON shape against an optional `parameter_space`. | Read-only |
| `ihpc.campaign.generate` | Read-only, pure-local dry-run: emit a canonical scheduler queue YAML (`my_nodes` + `experiments`) from structured inputs — the GENERATE counterpart to `ihpc.campaign.preflight`, so the plugin owns the queue format end-to-end (generate → preflight → `campaign.submit`). Runs the same `validateQueueContract` internally and refuses to emit if any error-level finding would fire, so output is preflight-clean by construction. | Read-only |
| `ihpc.node.usage` | Read-only, one-shot live per-GPU view for an iHPC compute node — SSHes to the node (the campaign canary's two-hop seam) and runs one fixed `nvidia-smi` query, returning each GPU's index, name, utilization (%), and memory used/total (MiB) plus a `probed_at` timestamp. One probe per call; not a daemon, not continuous telemetry. | Read-only |
| `artifacts.list` | List declared run outputs from saved plan state through a fixed helper and write a local manifest. | Read-only |
| `artifacts.fetch` | Fetch one manifest file artifact after consuming a matching artifact approval and verifying SHA-256. | Confirm |
| `artifacts.fetch.batch` | Fetch explicit manifest file artifacts after consuming a manifest-hash-scoped batch approval with per-file and total byte limits. | Confirm |
| `artifacts.summarize` | Extract bounded metrics from locally fetched allowlisted JSON/JSONL/NDJSON/CSV/TSV files and write a local summary. | Local state |
| `artifacts.cleanup.plan` | Produce a dry-run cleanup plan without deleting remote or local files. | Dry-run |
| `artifacts.cleanup.execute` | Delete explicit latest-manifest regular file artifacts after a matching cleanup approval and checksum/size preflight. | Confirm |
| `transfers.plan` | Validate and persist a fixed-file transfer plan with a deterministic plan hash. | Dry-run |
| `transfers.execute` | Execute one saved fixed-file transfer plan after matching approval, strict preflight, bounded checksum verification, and post-rsync checks. | Confirm |
| `state.migrate.plan` | No-write dry-run inspection of local `.uts-computing` state: report a migration plan hash, detected versions, candidate files, and blockers. | Dry-run |
| `state.migrate.apply` | Confirmed additive `schema_version` metadata writes with plan-hash binding and per-file backups under `.uts-computing/backups/`. | Confirm |

The implementation exposes `docs.search` for allowlisted local documentation search, exposes `docs.refresh` for fixed-source official UTS documentation cache refresh, exposes `jobs.submit` for UTS HPC PBS and UTS iHPC supervised starts, exposes `jobs.status`, `jobs.logs`, and `jobs.cancel` for both UTS HPC PBS run records and UTS iHPC supervised run records, exposes `jobs.retry.plan` for local retry planning, exposes fixed-file transfer execution, and exposes the first M4 artifact loop including scoped cleanup execution. It still does not expose arbitrary URL documentation fetching, arbitrary transfer execution, raw-path cleanup, directory cleanup, glob cleanup, or recursive cleanup.

The implemented MCP resources are:

| Resource | Purpose | Boundary |
| --- | --- | --- |
| `uts://profiles` | Redacted profile summaries. | No host aliases, usernames, keychain refs, identity paths, or secrets. |
| `uts://templates` | Template catalog. | Metadata only. |
| `uts://templates/{templateId}` | One allowlisted template source. | Template ids come from the local catalog only. |
| `uts://quota-snapshots` | Local quota snapshot index. | Reads `.uts-computing/quotas/*.json` metadata only. |
| `uts://quota-snapshots/{snapshotId}` | One sanitized quota snapshot. | Returns snapshot fields only, not raw command output evidence. |
| `uts://profiles/{profileId}/quota-snapshot/latest` | Latest local quota snapshot for one profile. | Does not refresh live state. |
| `uts://run-records` | Local run record index. | Reads `.uts-computing/runs/*.json` metadata only. |
| `uts://run-records/{runId}` | One local run record. | No log or artifact expansion. |
| `uts://projects` | Per-project rollup index across saved local run records, most-active first. | Local state only; reads run-record metadata. |
| `uts://projects/{projectHash}` | One project's rollup (run counts, status breakdown). | Project hashes come from local run records only. |
| `uts://approval-records` | Local approval record index. | Reads `.uts-computing/approvals/*.json` metadata only. |
| `uts://approval-records/{approvalId}` | One local approval record. | Approval state only; no confirmation token is stored or exposed. |
| `uts://artifacts` | Local artifact state index. | Exposes run id, state URIs, modified time, counts, and size only; no local file paths. |
| `uts://artifacts/{runId}/state` | One sanitized aggregate artifact state. | Includes manifest plus cleanup evidence summaries when present; no fetched file browsing. |
| `uts://artifacts/{runId}/manifest` | One sanitized local artifact manifest. | No raw remote paths, local paths, fetched file contents, helper stdout/stderr, or arbitrary file browsing. |
| `uts://artifacts/{runId}/cleanup-plans` | Sanitized cleanup dry-run plans for one run. | No cleanup plan absolute paths, raw local paths, or arbitrary file browsing. |
| `uts://artifacts/{runId}/cleanup-executions` | Sanitized cleanup execution evidence for one run. | No raw cleanup helper args, raw local paths, helper stdout/stderr, or arbitrary file browsing. |
| `uts://transfers` | Local transfer state index. | Exposes transfer state URIs, modified time, and size only; no raw local paths. |
| `uts://transfers/{runId}/state` | One sanitized aggregate transfer state. | No raw scripts, raw local paths, host aliases, helper output, or arbitrary file browsing. |
| `uts://transfers/{runId}/plan` | One sanitized saved transfer plan. | Exposes plan identity, hash, fixed files, and byte budget without raw script text. |
| `uts://transfers/{runId}/executions` | Sanitized transfer execution evidence for one run. | Exposes redacted command/evidence only; no raw rsync/SSH args or local cache browsing. |
| `uts://docs` | Allowlisted local documentation index. | No arbitrary file browsing. |
| `uts://docs/{docId}` | One allowlisted local documentation file. | Documentation ids come from the local allowlist only. |
| `uts://docs-cache` | Fixed official documentation cache index. | Lists allowlisted official source ids and locally cached summaries only. |
| `uts://docs-cache/{sourceId}` | One cached official UTS documentation page. | Source ids come from the fixed official source allowlist only; no arbitrary file browsing. |

The implemented MCP prompts are:

| Prompt | Purpose | Boundary |
| --- | --- | --- |
| `plan-experiment` | Guide experiment planning for UTS HPC or UTS iHPC. | Guidance only; requires Skills and MCP tools for validation and actions. |
| `triage-run` | Guide diagnosis, bounded logs, retry review, or cancellation review for one run. | No implicit approval; retry/cancel still require operation-specific approval tools. |
| `collect-artifacts` | Guide manifest-based artifact collection and local summarization. | No arbitrary remote browsing or artifact fetch without approval. |
| `stage-transfer` | Guide fixed-file upload/download transfer staging. | No rsync flags, SSH options, globs, delete/remove semantics, or execution-time widening. |
| `client-smoke-evidence` | Guide real Codex/Claude Code installed-client smoke evidence collection. | Release evidence only; not a substitute for direct MCP stdio smoke or actual client-host checks. |

`access.check` is not a generic SSH tool. It accepts one `profileId`, optional check names, and a timeout. It does not accept host, port, command, path, or output-directory overrides from the model. Allowed command shapes are limited to local `ssh -G`, local `ssh-keygen -F`, and SSH remote `true` or `id -un` with batch mode, no password prompts, strict host-key checking, and no host-key updates.

`docs.search` is not a generic file or web search tool. It accepts only a query, optional allowlisted documentation ids, and bounded result/snippet sizes. It does not accept paths, URLs, hosts, profile ids, live-fetch switches, timeout values, regexes, or runtime-state roots. Full documents remain available only through `uts://docs/{docId}` resources.

`docs.refresh` is not a generic web fetch tool. It accepts only optional fixed `sourceIds`, `maxBytes`, and `timeoutMs`; it does not accept URLs, paths, hosts, headers, cookies, profile ids, proxy settings, credentials, regexes, or arbitrary output directories. It performs HTTPS GET only against server-side allowlisted official UTS documentation URLs, rejects unsupported MIME types and redirects, bounds response size, writes schema-validated cache records under `.uts-computing/docs-cache/`, and exposes cached text through `uts://docs-cache/{sourceId}`. Cached documentation is platform context only and must not replace account-specific `quotas.refresh` evidence.

`quotas.refresh` is not a generic PBS, iHPC, or storage tool. It accepts one `profileId` plus an optional timeout. It does not accept host, username, queue, path, command, output-directory, or raw-output toggles. HPC allowed remote argv are limited to `whoami`, `id`, `groups`, `qstat -Q`, `qstat -Qf`, `qstat -u <observed-user>`, `pbsnodes -F json -a`, `quota -s`, and `df -hP <profile-declared-root>`. iHPC allowed remote argv are limited to `whoami`, `id`, `groups`, `cnode avail`, `cnode all`, `cnode mynodes`, `sessiontime`, `projvolu`, `df -hP <profile-declared-root>`, and `du -s -h <profile-declared-root>`.

`jobs.submit` is not a generic remote execution tool. It accepts only `runId`, an optional `approvalId`, an optional `quotaSnapshotId`, and an optional timeout. It reads the saved plan artifact (and, when an `approvalId` is supplied, the approval record) from local state, recomputes the plan hash, and verifies any approval is approved and unconsumed. UTS HPC runs exactly `ssh ... -T <profile-host> qsub` with the saved PBS script on stdin, and submits autonomously when conformant against a fresh `quotaSnapshotId` — an `approvalId` alone is also accepted as the legacy gate. UTS iHPC requires saved `command_argv`, active `cnode mynodes` evidence from the fresh quota snapshot, and then runs only `ssh ... -T <profile-host> ssh <active-cnode> python3 -` with a fixed MCP supervisor on stdin. A UTS iHPC supervised start **ALWAYS requires a fresh `quotaSnapshotId`** for the ban-critical per-account node-pool gate: the gate evaluates held-node occupancy against consume-time-fresh evidence, never an approval's possibly-stale bound snapshot (an approval may live up to 24h while a snapshot's held-node evidence is trusted only within its 15-min freshness window). When an iHPC start is approval-gated, it requires **BOTH** the `approvalId` (identity binding to `plan_hash` + scope) AND a fresh `quotaSnapshotId` (the ban-gate evidence); an iHPC submit with only an `approvalId` hard-fails. It does not accept model-provided scripts, commands, paths, hosts, node ids, qsub arguments, or SSH options.

`jobs.retry.plan` is not a generic job mutation tool. It accepts only `sourceRunId`, `retryRunId`, and an optional redacted reason; it never accepts a new script, command, template, resource object, workdir, remote job id, approval id, or plan hash. The source run must be failed, or cancelled with an explicit reason. The tool writes a new planned job and run record with `retry_of` lineage and `approval_operation: "jobs.retry"`. `jobs.submit` rejects retry-derived UTS HPC and UTS iHPC plans unless the approval operation is `jobs.retry`, and rejects mismatched plan/run retry lineage before command execution.

`jobs.status`, `jobs.logs`, and `jobs.cancel` are not generic PBS, iHPC, process, or file tools. They accept only run ids, bounded read options, and for cancel a matching approval id. The PBS job id comes from the local run record, PBS log paths come from the saved PBS plan artifact, and PBS cancellation uses only `ssh ... qdel <remote_job_id>` after consuming an operation-specific `jobs.cancel` approval. UTS iHPC status/log/cancel uses only the persisted supervisor pid, compute-node id, and stdout/stderr paths created by `jobs.submit`, then runs fixed MCP-generated Python helpers through `ssh ... -T <profile-host> ssh <ihpc-compute-node> python3 - <supervisor-spec>`.

`transfers.plan` and `transfers.execute` are not generic rsync tools. `transfers.plan` may accept a source root, destination root, explicit relative file list, and `max_total_bytes`, then writes a saved plan with a deterministic `plan_hash`. `transfers.execute` accepts only `runId`, `approvalId`, and timeout; it reads the saved plan, verifies `transfers.execute` approval scope, preflights file sizes, verifies helper metadata against the saved file order, byte accounting, and checksum policy, consumes approval, and runs fixed `rsync` argv with `--files-from=-`. For checksum-eligible files at or below the fixed transfer checksum cap, downloads compare the remote preflight SHA-256 with the local destination after rsync, and uploads compare the local preflight SHA-256 with a fixed remote post-check helper over the planned destination root and same file list. Oversized files record `checksum_status: "skipped-large"` and the evidence `checksum_policy`, not a content-hash verification claim. Downloads also require local destination files to exist, avoid symlinks, resolve inside the planned destination, be regular, and match preflight size before evidence is written. It does not accept model-provided rsync flags, SSH options, hosts, execution-time file lists, `--delete`, `--remove-source-files`, globs, filters, arbitrary checksum commands, broad directory recursion, or arbitrary local destinations.

`artifacts.list`, `artifacts.fetch`, `artifacts.fetch.batch`, and `artifacts.cleanup.execute` are not generic remote file tools. `artifacts.list` accepts only `runId`, bounds, and timeout; it derives candidate paths from the saved plan workdir and declared outputs, verifies those paths stay under the selected profile roots and planned workdir, then runs a fixed read-only Python helper through `ssh ... python3 - <artifact-spec>`. The helper validates remote `realpath` values so symlinks cannot escape the planned workdir or output root. `artifacts.fetch` accepts only `runId`, one manifest `artifactId`, one matching `artifacts.fetch` approval id, max bytes, and timeout; it fetches one file from the latest local manifest, verifies SHA-256 against remote and manifest checksums, stores it under `.uts-computing/artifacts/<runId>/files/`, writes evidence, and consumes the approval. `artifacts.fetch.batch` accepts only `runId`, `manifestHash`, explicit unique manifest `artifactIds`, one matching `artifacts.fetch.batch` approval id, per-file and total byte bounds, and timeout; its approval resource summary must cover the same manifest hash, ids, and byte limits. `artifacts.cleanup.execute` accepts only `runId`, the latest `manifestHash`, explicit unique manifest `artifactIds`, one matching `artifacts.cleanup.execute` approval id, and timeout. Cleanup execution requires a terminal run, file artifacts with captured SHA-256 and size evidence, approval `resource_summary` with matching `manifest_hash`, ordered `artifact_ids`, `delete_mode: "unlink-regular-files-only"`, exact `max_artifacts`, and exact `max_total_bytes`, and a fixed helper that calls `os.unlink` only after realpath, regular-file, size, and SHA-256 checks. These tools do not accept hosts, usernames, SSH options, raw remote paths, arbitrary local destinations, glob patterns, rsync flags, delete flags, force flags, directory cleanup, recursive cleanup, or checksum-command overrides.

`artifacts.summarize` is not a generic local file summarizer. It accepts only `runId`, reads only `.uts-computing/artifacts/<runId>/files/`, and considers only JSON, JSONL, NDJSON, CSV, or TSV files whose safe basename stem tokens include `metrics`, `metric`, `results`, `result`, `summary`, `eval`, `evaluation`, `scores`, or `score`. This admits common names such as `train_metrics.json`, `validation-results.ndjson`, `fold_0_scores.tsv`, and `wandb-summary.json` without accepting logs or arbitrary text. It skips symlinks, non-metric logs/text, binary/model files, files over 1 MB, total metric reads over 5 MB, secret-like filenames, and secret-like keys such as password, token, secret, api key, credentials, private key, MFA, or OTP. JSONL/NDJSON/CSV/TSV content is aggregated into column stats rather than copied as raw rows.

Artifact resources expose only sanitized context for later agent turns. `uts://artifacts/{runId}/manifest` allowlists manifest fields, redacts display paths, validates the requested run id against the manifest, and realpath-checks the manifest inside `.uts-computing/artifacts`. `uts://artifacts/{runId}/cleanup-plans` and `uts://artifacts/{runId}/cleanup-executions` validate cleanup records against schemas, redact remote and local paths, omit raw cleanup helper args, and reject symlink evidence files. Artifact resources intentionally do not provide `files/...` resources or access to fetched artifact content.

Transfer resources expose only sanitized context for later agent turns. `uts://transfers/{runId}/state` aggregates the saved plan and execution summaries, redacts transfer endpoints and command arguments, validates state files against transfer schemas, allowlists checksum evidence fields when present, and realpath-checks files inside `.uts-computing/transfers`. It intentionally does not expose raw `plan.json`, raw `execute-*.json`, transfer scripts, helper stdout/stderr, host aliases, or `files/...` resources.

Future MCP tools should return structured output where client support allows it and should report tool execution failures as tool results, not protocol failures. Tool inputs should use the narrowest schemas practical for each operation.

## Remote Execution Policy

M2 and later must use command-specific adapters, not generic shell execution.

Rules:

- represent remote commands as argv arrays, not concatenated shell strings;
- allowlist each command by platform and safety mode;
- capture raw evidence for read-only commands before parsing;
- redact secrets before storing logs or tool output;
- canonicalize remote paths before writes, transfers, or artifact fetches;
- reject symlink escapes and paths outside the selected profile's declared roots;
- bind live submissions to one `profile_id`, one `plan_hash`, and one quota snapshot.

## Platform Adapters

"Platform adapter" is a design concept, not a code directory. Each adapter is a per-platform set of allowlisted command shapes and parsers implemented inline inside the business-op modules (`ops/jobs`, `ops/quotas`, `ops/data`, `ops/access`, and so on), which branch on the profile's platform. There is no `src/adapters/` directory; the responsibilities below describe what that inline platform-specific code must do.

### UTS HPC Adapter

Responsibilities:

- SSH to the configured HPC host alias.
- Run PBS read-only commands.
- Parse `qstat`, `qstat -Qf`, and `pbsnodes` output.
- Render and submit PBS scripts.
- Track job ids, stdout, stderr, exit status, and artifacts.
- Apply queue and GPU safety policy before submission.

### UTS iHPC Adapter

Responsibilities:

- SSH to `access.ihpc.uts.edu.au` or a configured host alias.
- Detect available node families and user session state.
- Use `cnode` and related iHPC commands where available.
- Start supervised background runs only inside approved workspace paths.
- Monitor session limits and inactivity risks.
- Collect logs and artifacts without assuming a batch scheduler.

## Skills

Skills are the workflow and policy plane. They should call MCP tools by intent, not reimplement SSH/PBS behavior.

The canonical skill roster (15 skills) lives in [`skills/README.md`](../skills/README.md): seven single-step building blocks (below), six end-to-end orchestrators that compose them (`run-experiment`, `run-sweep`, `triage-and-retry`, `review-approvals`, `reproduce-run`, `fleet-status`), the standalone `confirm-usage` iHPC-monitoring email responder, and the cross-cutting `consult-platform-docs` (consult the official UTS docs when uncertain or when a needed capability is missing). The table below details the single-step building blocks.

Single-step building-block Skills:

| Skill | Trigger context | Primary MCP tools |
| --- | --- | --- |
| `plan-experiment` | planning experiments, selecting platform, estimating resources | `profiles.list`, `quotas.refresh`, `jobs.plan` |
| `select-profile` | choosing among multiple accounts, validating account limits | `profiles.list`, `profiles.validate`, `quotas.refresh` |
| `hpc-submit-pbs` | PBS scripts, queue choice, HPC submission | `jobs.plan`, `jobs.submit`, `jobs.status`, `jobs.logs` |
| `ihpc-run-background` | iHPC interactive runs, node sessions, background work | `access.check`, `quotas.refresh`, `jobs.plan`, `jobs.submit`, `jobs.status`, `jobs.logs`, `jobs.cancel` |
| `monitor-and-recover` | stalled runs, failed jobs, log triage, retry planning | `jobs.status`, `jobs.logs`, `jobs.diagnose`, `jobs.usage`, `jobs.history`, `quotas.refresh`, `jobs.retry.plan`, `approvals.*` |
| `analyze-artifacts` | fetch outputs, summarize metrics, preserve provenance, and perform scoped cleanup when explicitly requested | `artifacts.list`, `artifacts.fetch`, `artifacts.fetch.batch`, `artifacts.summarize`, `artifacts.cleanup.plan`, `artifacts.cleanup.execute`, `jobs.logs` |
| `stage-transfer` | stage datasets or larger fixed-file outputs | `transfers.plan`, `transfers.execute`, `quotas.refresh`, `approvals.*` |

In the current implementation, `quotas.refresh` supports both UTS HPC and UTS iHPC profiles, with platform-specific read-only command allowlists. UTS iHPC quota snapshots include active node evidence from `cnode mynodes` when available. UTS HPC PBS and UTS iHPC supervised-run status, logs, and cancel are implemented through separate narrow adapters. The artifact and transfer Skills can now use the M4 manifest-based list, single-file fetch, bounded batch fetch, fixed-file transfer with bounded checksum evidence, summary, dry-run cleanup-plan, and scoped cleanup-execute tools, but broad unbounded directory transfer and arbitrary destructive cleanup remain outside the current boundary.

## Profiles

Every operation must specify a `profile_id`. A profile represents one account on one platform, not a pool of accounts.

Profile fields are defined in [schemas/profile.schema.json](../schemas/profile.schema.json). Real profiles should be stored in an untracked file such as `profiles/profiles.local.yaml`.

Profiles may include:

- platform id: `uts-hpc` or `uts-ihpc`;
- login host alias;
- username reference or account label;
- SSH identity reference, keychain reference, or `ssh_agent`;
- default workspace and scratch paths;
- default queue or node family;
- project or allocation references;
- live quota snapshot metadata.

Profiles must not include passwords, private key material, MFA secrets, or tokens.

## State And Audit

The MCP server keeps local state as flat JSON files under the gitignored runtime directory `.uts-computing/`, organized into per-record-type subdirectories (`runs/`, `plans/`, `quotas/`, `approvals/`, `artifacts/`, `transfers/`, `onboarding/`, `access/`, `job-ops/`, `docs-cache/`). Every record is validated against a JSON Schema in `schemas/` (with `additionalProperties: false`) on both read and write. Run records use an optimistic-concurrency `rev` field so concurrent updates cannot silently clobber each other. The runtime root is relocatable via `UTS_COMPUTING_HOME` (used for per-test isolation) without affecting schema or template resolution.

Audit events must record:

- run id;
- profile id;
- platform;
- plan hash when available;
- quota snapshot id when available;
- schema version;
- template version;
- command summary after redaction;
- remote job id or supervised run id;
- timestamps;
- artifact checksums and bounded fixed-file transfer checksum evidence;
- approval records for high-risk actions.

Approval records must be explicit state transitions: `not_required`, `required`, `approved`, `rejected`, or `expired`. An approval for live submission is valid only for the exact operation, profile id, plan hash, and quota snapshot id it was granted against.

In the current M3 implementation, approval decisions require a trusted local confirmation token such as `UTS_COMPUTING_APPROVAL_TOKEN`. Approval ids include the operation, so a `jobs.submit` approval cannot be reused as a `jobs.cancel` or `jobs.retry` approval. `approvals.request` derives policy reasons from saved plan artifacts when available, rejects submit approval requests for retry-derived plans, and records profile-switch reasons through optional `previousProfileId`.

## State Migration Contract

State migration belongs to the local MCP state surface, not to the UTS remote-action surface. `state.migrate.plan` provides no-write dry-run inspection. `state.migrate.apply` is the separate write-capable tool and is limited to confirmed additive `schema_version` metadata writes with plan-hash binding and per-file backups.

`state.migrate.plan` must:

- read only allowlisted `.uts-computing` state directories;
- avoid SSH, VPN, DNS, TCP, PBS, iHPC, `rsync`, approval transitions, and run-status transitions;
- return the same JSON envelope as other tools, with text JSON fallback matching `structuredContent`;
- report a migration plan hash, project-relative paths, detected versions, candidate files, blockers, and whether approval/run state would change;
- keep `schema_version` client-neutral, with no Codex-only or Claude-only record fields.

`state.migrate.apply` must accept only a matching `planHash` plus trusted confirmation token, reject blockers before writing, back up every changed file under `.uts-computing/backups/`, and add only schema-version fields to already-valid records. Skills should invoke or recommend the migration tools when local state looks incompatible. They should not hand-edit `.uts-computing` records.

## Plugin Shims

Distribution is standards-first (see [adr/0005-standards-first-distribution.md](adr/0005-standards-first-distribution.md)):

- `.claude-plugin/plugin.json` (+ `marketplace.json`) is the one client plugin wrapper (Claude Code); it points to `./skills/` and `./.mcp.json`.
- `.mcp.json` is the Claude MCP config; its launch arg uses `${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js`.
- `.agents/skills/` mirrors `skills/` (symlinks) so Codex and other `agentskills.io` agents auto-discover the same Skills with no plugin.
- Codex and other agents register the same `mcp-server/dist/index.js` through their standard MCP config (e.g. `codex mcp add` / `~/.codex/config.toml`).

The repository root is the plugin root. Claude manifest component paths must use `./...` paths from that root and must not point outside it.
