---
name: analyze-artifacts
description: Plan artifact collection and analyze local UTS HPC/iHPC run outputs, with remote fetch only when matching MCP tools exist. Use when the user asks to inspect logs, compare runs, summarize metrics, build tables or figures, or prepare experiment evidence after compute jobs finish.
---

# Analyze UTS Artifacts

Use this Skill after or during an experiment when outputs need to be collected and interpreted.

## Current Capability

Repository and documentation paths are relative to the plugin/repository root.

Current tools can analyze local dry-run records, local files already present in the workspace, cached run/quota context through MCP resources, bounded UTS HPC PBS or UTS iHPC supervisor stdout/stderr tails through `jobs.logs`, plan-derived artifact manifests through `artifacts.list`, approved single-file artifact fetches through `artifacts.fetch`, approved bounded multi-file manifest fetches through `artifacts.fetch.batch`, local metrics summaries through `artifacts.summarize`, dry-run cleanup plans through `artifacts.cleanup.plan`, scoped approved cleanup execution through `artifacts.cleanup.execute`, and local state compatibility through `state.migrate.plan`.

Artifact fetching is intentionally narrow. Use `artifacts.fetch` for one manifest `artifactId` with a matching `artifacts.fetch` approval. Use `artifacts.fetch.batch` only for explicit unique manifest ids from the latest `artifacts.list` result, pass the returned `manifest_hash` as `manifestHash`, and require a matching `artifacts.fetch.batch` approval whose `resource_summary` covers `manifest_hash`, ordered `artifact_ids`, `max_bytes_per_file`, and `max_total_bytes`. Both fetch paths verify checksums and store fetched files under local `.uts-computing/artifacts/<runId>/files/`. For larger fixed-file transfers, switch to the `stage-transfer` workflow. Cleanup is also intentionally narrow: default analysis must not delete anything, and `artifacts.cleanup.execute` may be used only when the user explicitly asks to delete artifacts from a terminal run, with the latest `manifest_hash`, explicit manifest file ids, captured SHA-256 and size evidence, and a matching approval whose `resource_summary` includes matching `manifest_hash`, ordered `artifact_ids`, `delete_mode: "unlink-regular-files-only"`, exact `max_artifacts`, and exact `max_total_bytes`. The current implementation does not support arbitrary remote path browsing, directory rsync, large unbounded transfer without a fixed list, user-supplied local destinations, raw-path cleanup, directory cleanup, glob cleanup, recursive cleanup, or direct remote analysis. If a required artifact capability is unavailable, stop and report which later milestone is needed. Do not use direct shell, SSH, rsync, PBS, or iHPC commands as a substitute for a missing MCP tool.

## Workflow

1. Identify the run id, profile id, platform, and expected output paths.
2. Inspect local records through `uts://run-records` and local files already present in the workspace. If run/artifact state appears schema-incompatible, run `state.migrate.plan` and stop on blockers rather than editing `.uts-computing`.
3. Use `artifacts.list` to create or refresh the artifact manifest for declared outputs. Do not request paths outside the saved plan.
4. Check file sizes and ask for explicit approval before fetching. Single-file approval must use operation `artifacts.fetch`; batch approval must use operation `artifacts.fetch.batch` and include the manifest hash, exact ids, per-file byte limit, and total byte limit.
5. Fetch selected file artifacts with checksums only through MCP tools. Use batch fetch for a small explicit set, not for arbitrary directories or broad transfer.
6. Run `artifacts.summarize` for local allowlisted JSON/JSONL/NDJSON/CSV/TSV metric files when useful, and preserve raw outputs plus local evidence paths. It only considers safe metric/result/summary/eval/score filename tokens and skips secret-like filenames/keys. Do not ask it to summarize arbitrary logs, text dumps, model checkpoints, archives, or remote paths.
7. Summarize:
   - command and run provenance;
   - resource request and actual status when available;
   - key metrics;
   - failures, warnings, missing artifacts;
   - next experiment suggestions.
8. Keep analysis scripts or derived reports separate from raw artifacts.
9. Use `artifacts.cleanup.plan` to prepare a dry-run cleanup review. If the user explicitly asks to delete selected artifacts, use only `artifacts.cleanup.execute` with the latest manifest hash, explicit artifact ids, terminal run status, captured SHA-256/size evidence, and matching unlink-regular-files-only approval.

## References

- `docs/accounts-and-safety.md`
- `docs/fact-registry.md`
- `schemas/run-record.schema.json`

## Guardrails

Do not delete remote artifacts while analyzing unless the user explicitly asks for scoped cleanup and the `artifacts.cleanup.execute` approval path above is satisfied. Do not fetch unrelated directories. Do not hide missing outputs; report them as part of the run evidence.
