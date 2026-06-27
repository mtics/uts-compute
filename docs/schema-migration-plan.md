# Schema Migration Plan

This plan defines how `uts-compute` changes persisted local state without breaking Codex, Claude Code, or existing `.uts-computing/` records.

## Scope

Versioned local state includes:

- profile documents validated by `schemas/profile.schema.json`;
- job specs validated by `schemas/job-spec.schema.json`;
- run records validated by `schemas/run-record.schema.json`;
- quota snapshots validated by `schemas/quota-snapshot.schema.json`;
- approval records validated by `schemas/approval-record.schema.json`;
- transfer plans validated by `schemas/transfer-plan.schema.json`;
- transfer execution records validated by `schemas/transfer-execution-record.schema.json`;
- artifact manifests, single/batch fetch records, summaries, cleanup plans, and cleanup execution records validated by `schemas/artifact-*.schema.json`.

The schema plan covers local files and MCP tool/resource outputs. It does not migrate UTS remote filesystems, PBS jobs, iHPC sessions, or user credentials.

## Compatibility Rules

- Additive fields are preferred. New optional fields must have safe defaults in readers.
- Required fields may be added only with a migration function and a documented fallback.
- Field meaning must not change in place. Introduce a new field and deprecate the old one.
- Approval records must remain immutable except for explicit state transitions such as `approved`, `rejected`, `expired`, or `used_at`.
- Run records must preserve `run_id`, `profile_id`, `platform`, `plan_hash`, `quota_snapshot_id`, and audit events across migrations.
- Redacted evidence must stay redacted after migration.
- Client-specific plugin manifests must not introduce separate schema versions for Codex and Claude Code.

## Versioning

Current persisted records do not yet carry a `schema_version` field. The first compatibility migration should add optional `schema_version: "0.1.0"` support to schemas and readers, then later make it required only after old local records can be upgraded safely. Future migrations should use semantic version strings:

- patch version: validation/documentation-only changes or optional additive fields;
- minor version: additive persisted fields with backward-compatible readers;
- major version: breaking persisted format changes requiring an explicit migration command.

## Migration Workflow

1. Add or update JSON Schema files under `schemas/`.
2. Update TypeScript types and validators under `mcp-server/src/core/` (`types.ts`, `validation.ts`) and the migration logic in `mcp-server/src/ops/data/migrations.ts`.
3. Add reader fallback logic for old records before writing new records.
4. Add tests with one old fixture and one new fixture.
5. Document the migration in this file and `docs/fact-registry.md`.
6. Run `npm test`, `npm run dry-run:sample`, and `npm run validate:plugin`.
7. For breaking changes, provide a dry-run migration command before any write command.

## Dry-Run First

`state.migrate.plan` is the implemented dry-run MCP tool. It has no input parameters and no write/apply/confirm switch. It scans only allowlisted local `.uts-computing` state directories and reports:

- `mode: "dry-run"`;
- `target_schema_version`;
- `plan_hash` binding the current dry-run candidate set;
- `writes_planned: false`;
- `files_read`;
- `files_would_write` as future apply candidates only;
- detected schema versions;
- one record entry per known local state file with `kind`, project-relative `path`, `id`, `current_schema_version`, `status`, `action`, `would_change_fields`, `errors`, and `warnings`;
- records that cannot be migrated;
- `approval_state_would_change: false`;
- `run_state_would_change: false`.

The tool must not call SSH, VPN, DNS, TCP, PBS, iHPC, `rsync`, approval-state helpers, or run-state helpers. It must not mutate profile config, credentials, client manifests, local secret files, approval state, run state, plan hashes, quota snapshot ids, events, or fetched artifacts.

The default must remain no write. Write mode is exposed only as the separate `state.migrate.apply` tool, never as a switch on `state.migrate.plan`.

## Apply Tool

`state.migrate.apply` is the implemented write-capable MCP tool for the first additive compatibility migration. It accepts only:

- `planHash`: the `plan_hash` returned by the current `state.migrate.plan` result;
- `confirmationToken`: a trusted local confirmation token, checked the same way as other explicit approval decisions.

The apply tool re-runs the dry-run scan immediately before writing. It refuses to write when the supplied `planHash` does not match the current dry-run plan, when any record is blocked or requires manual review, or when the confirmation token is absent or invalid.

The current apply scope is intentionally narrow:

- add top-level `schema_version: "0.1.0"` to already-valid state files that lack it;
- add nested `snapshot.schema_version: "0.1.0"` for quota snapshot wrapper files;
- do not repair corrupt JSON, unsupported versions, symlinks, escaped paths, missing fields, or invalid records;
- do not alter approval `state`, `used_at`, plan hashes, quota snapshot ids, run statuses, run events, command evidence, fetched artifacts, profile config, credentials, client manifests, or local secret files;
- do not call SSH, VPN, DNS, TCP, PBS, iHPC, `rsync`, approval-state helpers, or run-state helpers.

Before each mutation, apply writes a backup copy of the original file under `.uts-computing/backups/<timestamp>/<same-relative-path>`. Writes use a temp file plus rename, and the migrated value is schema-validated before the original file is replaced.

## Rollback

Before write-mode migration, copy each changed local state file to `.uts-computing/backups/<timestamp>/` with the same relative path. Do not back up secrets or files outside `.uts-computing`.

Rollback instructions must say which backup directory to restore and which validation command proves the restore.

## Deferred Work

- Add schema coverage for future persisted state surfaces before making them automatic migration targets.
- Add future non-additive migration tools only after separate review, because they may mutate local audit state beyond schema-version metadata.
