# Accounts And Safety

## Multi-Account Principle

The user has two accounts on UTS HPC and two accounts on UTS iHPC.

The package must support those accounts as separate profiles. It must not combine them into a single larger quota pool.

Allowed reasons to select a different account:

- the experiment belongs to a different project or allocation;
- the target platform permissions differ;
- the user explicitly requests a profile;
- live quota checks show the selected profile is the appropriate authorized profile for that work.

Forbidden behavior:

- rotating accounts to bypass queue limits, node limits, fair-use policies, or per-account caps;
- submitting the same workload under multiple accounts unless the user explicitly approves a legitimate comparison or replication reason;
- inferring account identity from chat history without selecting a `profile_id`;
- storing cleartext credentials.

## Quota Refresh

Before any submission, the MCP server must refresh or confirm a recent quota snapshot for the selected profile.

For UTS HPC, refresh should include:

- `whoami`, `id`, `groups`;
- `qstat -Q`;
- `qstat -Qf`;
- `qstat -u "$USER"`;
- `pbsnodes -F json -a` when available;
- storage usage and quota commands available on the platform.

For UTS iHPC, refresh should include:

- account group and identity;
- node-family access and current node occupancy;
- `cnode avail`, `cnode all`, or `cnode mynodes` when available;
- session status such as `sessiontime` when available;
- home, data, project volume, and scratch usage checks.

Every quota snapshot should include:

- `profile_id`;
- `observed_at`;
- source commands or URLs;
- parsed limits;
- raw evidence path;
- freshness status.

## Approval Gates

Safe by default:

- listing profiles;
- validating schemas;
- checking VPN/SSH;
- querying queues, nodes, sessions, and storage;
- rendering job scripts in dry-run mode;
- fetching small log files.

Run autonomously within the live conformance envelope (no human token): submitting and retrying PBS jobs, starting supervised iHPC runs, transferring files, and fetching artifacts (single and batch). These are gated by conformance against the selected profile's fresh quota snapshot — per-queue enable/ACL/resource limits and per-user run/queue caps for PBS, an active compute node for the planned node-family on iHPC, and target-mount storage headroom — and they refuse non-conformant requests (reporting the violated limit) as well as missing or stale snapshots. Submission, transfer, and fetch are reversible by design; the conformance refusal plus the scheduler backstop replace the per-submission token. See ADR 0004.

Still require explicit human confirmation (a trusted local token):

- deleting explicit latest-manifest artifact files with `artifacts.cleanup.execute` — the one irreversible remote action;
- cancelling a job or supervised run with `jobs.cancel`;
- applying a local state-schema migration with `state.migrate.apply`.

Advisory only — surfaced on the plan but no longer gating: GPU use, restricted/private queues or special node groups, long walltime, high memory, many cores, large arrays, and the iHPC supervised-run note. `jobs.plan` tags these `approval.policy: "advisory"`. Switching account profiles after a plan is prepared re-binds conformance to the new profile's envelope; never reuse a plan or snapshot across accounts.

Authorization (whether by conformance or by a remaining token approval) must be bound to the exact planned operation:

- `profile_id`;
- `plan_hash`;
- `quota_snapshot_id`;
- resource request;
- command summary after redaction;
- target queue or node family;
- remote write and artifact paths;
- artifact manifest id and checksum expectations for single-file artifact fetch;
- artifact manifest hash, exact artifact id list, per-file byte limit, and total byte limit for batch artifact fetch;
- cleanup manifest hash, exact artifact id list, `delete_mode: "unlink-regular-files-only"`, exact artifact count, and exact total byte count for artifact cleanup execution;
- transfer direction, source root, destination policy, exact relative file list, maximum total bytes, fixed rsync mode, and checksum policy for transfer execution.

If any of these fields changes after approval, the approval expires and must be requested again.

Where a human token approval is still required (`artifacts.cleanup.execute`, `jobs.cancel`, `state.migrate.apply`), it must come from a trusted human confirmation path. In the current local MCP implementation, `approvals.decide` requires a confirmation token supplied through the host/user environment, such as `UTS_COMPUTING_APPROVAL_TOKEN`; model text alone is not approval.

The current MCP implementation derives advisory plan reasons from saved plans when available (GPU, restricted queue, high resource, array concurrency, iHPC supervised-run, operation-specific, and cross-account switch reasons). These are display-only metadata (`approval.policy: "advisory"`); agents may add user-facing reasons but cannot remove the server-derived ones. They inform the planner and human reader — they do not gate autonomous submission, which is gated by conformance.

Manual-only or blocked until a specific implementation review:

- arbitrary remote file deletion outside `artifacts.cleanup.execute`;
- cleanup by raw path, directory, glob, recursive traversal, force flag, or model-supplied shell command;
- fetching arbitrary remote paths outside a saved artifact manifest;
- recursively transferring broad directories without fixed file lists and total byte limits;
- using transfer execution without a saved transfer plan, exact file list, and `max_total_bytes`;
- using batch artifact fetch without a manifest-hash-scoped saved plan, exact ids, and byte limits;
- running arbitrary remote shell commands;
- modifying SSH host key records;
- changing profile secret references;
- cancelling jobs not created by this package and not adopted into local run history — an external job first adopted with `jobs.adopt` may then be cancelled through `jobs.cancel` once an approval token is configured, and that cancellation is recorded as acting on an adopted (non-plugin-originated) run;
- submitting, transferring, or fetching when the latest quota snapshot is missing or stale.

## Live Tools Outside The Approval Model

Token approval gates apply only to the irreversible or structural operations: `artifacts.cleanup.execute` (remote delete), `jobs.cancel` (terminates running compute), and `state.migrate.apply` (rewrites local state schema). Compute- and data-movement operations — `jobs.submit`, `jobs.retry`, `transfers.execute`, `artifacts.fetch`, `artifacts.fetch.batch`, and iHPC supervised start — run autonomously, gated by live conformance against the selected profile's fresh quota snapshot rather than a human token (ADR 0004). They still produce the same bound, redacted, audited evidence.

Some live tools are intentionally not approval-gated because they only read and cannot change remote state, consume compute, or move data: `access.check`, `quotas.refresh`, `jobs.status`, `jobs.logs`, `artifacts.list`, `access.doctor`, `jobs.usage`, and `jobs.diagnose`. They still produce redacted, timestamped, source-attributed evidence under `.uts-computing`, and their remote commands stay argv-level allowlisted.

`docs.refresh` is the one live tool that performs general outbound HTTPS egress rather than SSH to a profile host, and it is also intentionally ungated. This is an accepted exception, not an oversight, because it is constrained by:

- a fixed server-side documentation source allowlist, with no caller-supplied URLs, hosts, headers, paths, proxies, credentials, or output directories;
- `redirect: "manual"` with final-URL host pinning, so cross-host redirects are rejected rather than followed;
- bounded response bytes and request timeout;
- output limited to schema-validated, sanitized documentation text cache records, with no read of UTS account state.

Cached docs remain platform context only, so per-account quota and ACL decisions still require `quotas.refresh`. If a UTS documentation source requires VPN, the local VPN must already be connected; `docs.refresh` does not establish or probe VPN itself.

Any change that broadens `docs.refresh` beyond its fixed source allowlist, or that adds another ungated tool capable of remote mutation, compute consumption, data movement, or arbitrary network egress, requires a separate threat-model review before merge.

## Path Policy

Remote write operations must stay inside paths declared in the selected profile, for example workspace, scratch, or project output directories.

The package must not write to system paths, scan other users' directories, or clean unknown directories.

## Logging Policy

Logs and audit records should redact:

- passwords;
- tokens;
- private key paths when configured as sensitive;
- MFA material;
- full command lines containing secrets;
- direct personal identifiers unless required for local profile disambiguation.

The audit trail should preserve enough information to reproduce what was submitted without exposing credentials.

## Provisioning Is Out Of Scope

The plugin governs the *experiment* lifecycle — plan → approve → submit → monitor → collect — and *fixed-file* data movement (`transfers.*`: explicit file lists, a byte cap, no recursion, no clone, no package install). It deliberately does **not** provide first-run **provisioning**: cloning the experiment repo, creating or updating a Python environment (`pip`/`conda`/`uv`), or staging a whole dataset directory onto a clean node.

That provisioning is a one-time, out-of-band prerequisite the user performs manually (typically a single SSH session to clone the repo, build the env, and copy data). **This is a permitted carve-out from the "no raw SSH/rsync as a substitute for an MCP tool" rule** — provisioning is not a missing tool being routed around, it is setup the plugin never owned. Once a node is provisioned, all subsequent compute goes through the governed tools.

Recommended first-run flow:

1. `select-profile` → `access.check` → `quotas.refresh` (confirm the account, VPN, and SSH).
2. **Manually, out of band:** SSH to the login node, clone the repo into the profile workspace, create/activate the Python env, and stage datasets under the workspace/scratch root.
3. Resume the governed path: `jobs.plan` → approve (if required) → `jobs.submit` → `jobs.track` → `artifacts.fetch`.

`ihpc.campaign.preflight`'s missing-dataset findings point here: a dataset absent on the node is a provisioning gap to resolve out-of-band, not a tool failure.
