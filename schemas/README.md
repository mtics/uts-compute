# Schemas

Schemas define the contracts enforced by the MCP server before remote actions.

- `profile.schema.json`: one account on one platform.
- `onboarding-record.schema.json`: local record created by `profiles.onboard` binding a profile id and platform to its onboarding timestamp, quota snapshot id, and cluster.
- `access-check-result.schema.json`: read-only VPN, DNS, TCP, SSH, and remote identity preflight evidence.
- `approval-record.schema.json`: local approval state bound to a plan hash, quota snapshot, and optional operation scope hash.
- `quota-snapshot.schema.json`: read-only live quota, queue, node, job, identity, and evidence snapshot.
- `docs-cache-record.schema.json`: fixed-source official UTS documentation cache record created by `docs.refresh`.
- `job-spec.schema.json`: planned compute work before rendering or submission.
- `planned-job.schema.json`: persisted dry-run job plan artifact consumed by approved submission, including optional retry approval operation and lineage metadata.
- `run-record.schema.json`: local audit record for planned, submitted, running, finished, failed, or cancelled work, including optional retry lineage metadata and an optional reproducibility block (git sha/branch/dirty plus the redacted command).
- `transfer-plan.schema.json`: local transfer plan input, optionally including fixed files and total byte budget for approved execution.
- `planned-transfer.schema.json`: persisted dry-run transfer plan artifact consumed by approved transfer execution.
- `transfer-execution-record.schema.json`: local evidence record created by approved `transfers.execute`, including optional bounded SHA-256 transfer checksum evidence and policy for new records while still accepting older size-only records.
- `artifact-manifest.schema.json`: local manifest created by `artifacts.list`.
- `artifact-fetch-record.schema.json`: local evidence record created by approved `artifacts.fetch`.
- `artifact-fetch-batch-record.schema.json`: local evidence record created by approved `artifacts.fetch.batch`.
- `artifact-summary.schema.json`: local bounded metrics summary created by `artifacts.summarize`.
- `artifact-cleanup-plan.schema.json`: dry-run cleanup plan created by `artifacts.cleanup.plan`.
- `artifact-cleanup-execution-record.schema.json`: local evidence record created by approved `artifacts.cleanup.execute`.
- `state-migration-plan.schema.json`: no-write local state migration dry-run result.
- `state-migration-apply-record.schema.json`: confirmed local schema-version migration apply result.
- `client-smoke-evidence.schema.json`: manual real Codex/Claude Code installed-client smoke evidence summary.

Future schemas should cover template manifests, richer queue snapshots, iHPC session snapshots, and sanitized resource projections.

Schema evolution must follow [../docs/schema-migration-plan.md](../docs/schema-migration-plan.md). Persisted record schemas accept optional `schema_version: "0.1.0"` for reader compatibility; it is not required yet. `state.migrate.apply` may add that field to already-valid local state after dry-run plan-hash binding, confirmation, and backup.
