# Failure Playbooks

Use these playbooks when UTS compute actions fail or appear unsafe. They are written for agents using the shared Skills plus MCP server; do not replace them with direct SSH, PBS, iHPC, rsync, or shell commands.

## Universal Triage

1. Identify the `run_id`, `profile_id`, platform, plan hash, and latest quota snapshot.
2. Read local state first through MCP resources such as `uts://run-records/{runId}`, `uts://quota-snapshots/{snapshotId}`, and `uts://approval-records/{approvalId}`.
3. Use `access.check` only for reachability and SSH preflight.
4. Use `quotas.refresh` when queue/session/storage facts may be stale.
5. Use `jobs.status` and bounded `jobs.logs` for submitted or supervised runs.
6. Use `artifacts.list` before any artifact fetch; fetch only selected manifest file artifacts with a matching `artifacts.fetch` approval.
7. Preserve evidence paths and report uncertainty instead of guessing.

## VPN Or SSH Failure

Symptoms:

- DNS or TCP checks fail;
- SSH batch auth fails;
- remote identity is unavailable.

Actions:

- Run `access.check` for the selected profile only.
- Do not run scheduler, storage, transfer, or workload commands.
- Ask the user to connect VPN or fix SSH credentials when preflight fails.
- Retry read-only preflight after the external condition changes.

Stop when:

- the host alias is unsafe or unknown;
- authentication would require an interactive password prompt;
- host-key state is unexpected and the user has not reviewed it.

## Stale Or Mismatched Quota Snapshot

Symptoms:

- approval request rejects `quota_snapshot_id`;
- profile/platform mismatch;
- snapshot is older than the accepted freshness window.

Actions:

- Run `quotas.refresh` for the selected profile.
- Re-plan if resource limits, queue availability, node sessions, or profile choice changed.
- Request a new approval bound to the new `plan_hash` and `quota_snapshot_id`.

Stop when:

- the user asks to bypass account limits;
- switching profiles looks like quota rotation rather than a legitimate project/allocation choice.

## PBS Submission Failure

Symptoms:

- `jobs.submit` returns a qsub error;
- job remains unsubmitted in the local run record.

Actions:

- Read the saved plan artifact and run record.
- Check queue/resource reasons from `jobs.plan` and `approvals.request`.
- Refresh quotas and queue evidence with `quotas.refresh`.
- Re-plan with safer resources if the queue rejects the request.

Do not:

- pass custom qsub flags;
- edit the saved PBS script after approval;
- submit the same plan under a different profile without profile-switch approval.

## iHPC Supervised Start Failure

Symptoms:

- no active `cnode mynodes` evidence;
- fixed supervisor start fails;
- run record lacks supervisor metadata.

Actions:

- Refresh iHPC session evidence with `quotas.refresh`.
- Confirm that the selected profile has an active compute node session.
- Re-plan if the command lacks saved `command_argv` or the workdir is outside profile roots.

Do not:

- start via `bash -lc`, `nohup`, shell redirection, or direct nested SSH;
- let the model choose a compute node id outside fresh `cnode mynodes` evidence.

## Stalled Or Failed Run

Actions:

- Use `jobs.status` for current scheduler/supervisor state.
- Use `jobs.logs` with conservative byte bounds.
- Classify the failure as access, quota, resource request, environment, command, data path, artifact, or session timeout.
- For partial outputs, use `artifacts.list`; fetch only selected files with `artifacts.fetch` approval.
- For retry planning, use `jobs.retry.plan` to create a new local retry plan from a failed run, or from a cancelled run only with an explicit reason. Review fresh quota evidence and create a matching `jobs.retry` approval before any UTS HPC retry submission or UTS iHPC supervised retry start.

## Cancellation

Actions:

- Cancel only one explicit run id.
- Create a fresh `jobs.cancel` approval; never reuse submit approval.
- Use `jobs.cancel` only after reviewing current status and likely impact.

Stop when:

- the target job was not created by this package;
- the request is to cancel broad sets of jobs;
- the approval operation is not `jobs.cancel`.

## Artifact Or Transfer Failure

Actions:

- Run `artifacts.list` to refresh the manifest.
- Fetch only file artifacts by manifest `artifactId`.
- For larger fixed-file transfers, inspect the saved transfer plan, exact file list, `max_total_bytes`, and matching `transfers.execute` approval.
- If transfer preflight fails, refresh quota/storage evidence when relevant and re-plan the fixed file list rather than widening rsync scope.
- For artifact fetches, verify SHA-256 evidence. For fixed-file transfers, inspect sanitized transfer evidence: checksum-eligible files should show `checksum_status: "verified"` with SHA-256, oversized files may show `checksum_status: "skipped-large"` plus `checksum_policy` and must not be described as content-hash verified.
- If a transfer fails after rsync because download local verification, upload remote post-check, or checksum comparison failed, report that no successful execution evidence was written and create a fresh scoped approval only after the plan or underlying file state is reviewed.
- Use `artifacts.cleanup.plan` first for dry-run cleanup review.
- If the user explicitly asks to delete completed run artifacts, use only `artifacts.cleanup.execute` with the latest `manifestHash`, explicit manifest file `artifactIds`, terminal run status, captured SHA-256 and size evidence, and a matching approval whose `resource_summary` includes the same manifest hash, ordered ids, `delete_mode: "unlink-regular-files-only"`, exact artifact count, and exact byte total.

Do not:

- fetch arbitrary remote paths;
- execute transfers without a saved plan and matching approval;
- use rsync flags supplied by the model;
- enable `--delete`, `--remove-source-files`, raw-path cleanup, directory cleanup, glob cleanup, or recursive cleanup;
- replace fixed file lists with globs, filters, or broad recursive directory transfer;
- hide missing artifacts from summaries.

## Reporting

Every failure report should include:

- run id, profile id, platform;
- current run status;
- latest relevant tool call and redacted command summary;
- evidence paths under `.uts-computing`;
- what was not attempted because it would violate the safety boundary;
- the safest next action.
