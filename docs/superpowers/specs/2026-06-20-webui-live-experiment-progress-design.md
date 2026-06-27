# WebUI Live Experiment Progress — Design Spec

**Date:** 2026-06-20
**Status:** Approved (brainstorming), pending implementation plan
**Topic:** Surface live experiment-run progress (HPO trial counts, robust test metrics, lifecycle) in the uts-compute WebUI and via an MCP tool, without binding the plugin to any single project or ML framework.

---

## 1. Problem

The WebUI (`webui/server.mjs`) is a pure local-record reader. `GET /api/runs/:id` returns the static adopted record plus saved plan/manifest. It has no path to the live progress of a running experiment. The actual progress (HPO trial counts, current best test metrics, trial lifecycle) lives in framework-specific artifacts on SSH-reachable clusters (for the current NexusRec campaign: optuna journals at `outputs/hyper_search/{model}/{dataset}/optuna_journal.log` on three accounts). The WebUI never touches them.

We want the WebUI (and Claude, via MCP) to show live progress, while keeping the plugin **project-agnostic** and **framework-independent**. We may serve multiple projects, and the plugin must not be welded to NexusRec, optuna, or recommendation-domain concepts.

## 2. Core principle: responsibility inversion

The plugin is a generic **probe transport + standard schema + cache** layer. It knows how to SSH to a host, run a command supplied by the project, parse a standard JSON result, and cache it. It knows nothing about optuna, journals, NDCG, or NexusRec. Each project owns a **probe** (an artifact living in the project repo) that encapsulates all framework specifics and emits the standard schema.

| Layer | Owner | Knows | Does NOT know |
|-------|-------|-------|---------------|
| Standard `ProgressSnapshot` schema | Plugin | Generic shape: status, counts, `metrics:[{name,value}]`, timestamps | Any framework/project concept |
| Probe transport + cache | Plugin | SSH to host, run a command, parse + validate JSON, persist to record | optuna, journal, NDCG, NexusRec |
| Probe implementation | Project (in project repo) | How this framework reports progress, where the journal is, how to compute metrics | Plugin internals |
| projects registry + host binding | Config | `project_id → probe command`; `profile_id → host` | Framework details |

Two design rules this enforces:

- **Semantics live in structure, not in names.** The `run_id` slug is an opaque stable handle, never parsed at runtime. Meaning lives in typed record fields (`project_id`, `probe_args`, `source.profile_id`) and in structured config (the projects registry). The only place a slug is parsed is a one-time backfill migration.
- **The flow is an orchestration of functional primitives**, not one monolithic function. Exactly one primitive has side effects (the SSH call).

## 3. Standard `ProgressSnapshot` schema (plugin-owned, framework-neutral)

```jsonc
{
  "status": "running|queued|done|failed|unknown",
  "counts": { "completed": 41, "running": 2, "target": 500 },
  "metrics": [
    { "name": "NDCG@50",   "value": 0.0125, "kind": "robust_median_top10_by_valid" },
    { "name": "Recall@50", "value": 0.0473, "kind": "robust_median_top10_by_valid" }
  ],
  "updated_at": "2026-06-20T08:35:30Z",
  "fetched_at": "2026-06-20T18:50:00Z",
  "schema_version": 1
}
```

The plugin validates only this generic shape: `metrics` is an arbitrary list of `{name, value, kind?}`, `counts` an arbitrary integer map. The names `NDCG@50` / `Recall@50` / `robust...` are opaque strings to the plugin. `updated_at` reflects when the underlying data last changed (e.g. journal mtime). `fetched_at` is when the plugin last ran the probe; the TTL cache decision is based on it.

A JSON Schema file for `ProgressSnapshot` ships with the plugin so projects can self-validate their probe output.

## 4. Probe contract (the sole plugin↔project interface)

A project probe MUST:

- Accept a neutral invocation carrying `probe_args` (passed as a JSON string).
- Print exactly one `ProgressSnapshot` JSON object to stdout.
- Exit 0 on success; exit non-zero with diagnostics on stderr on failure.
- Be **read-only and idempotent** — it must never touch the experiment itself.

NexusRec implements this as `tools/progress_probe.py` (a single-run version of the session's `mainhpo_report50.py`), encapsulating optuna, journal layout, the robust top-10-by-valid metric, and the optuna enum-int `TrialState` gotcha (`t.state == TrialState.COMPLETE`, not a `str(...)` comparison). Swapping frameworks means swapping this probe; the plugin is unchanged.

## 5. Configuration: (project × host) deployment facts in one structured place

```yaml
projects:
  nexusrec:
    probe_command: "{python} {repo}/tools/progress_probe.py --run-args {probe_args_json}"
    deployments:
      ihpc-u00000001:   { repo: /data/u00000001/Workspace/NexusRec_SANE, python: /data/u00000001/miniconda3/envs/FedVLR/bin/python }
      ihpc-u00000002:    { repo: /data/u00000002/Workspace/NexusRec_SANE,  python: /data/u00000001/miniconda3/envs/FedVLR/bin/python }
      hpc-u00000003: { repo: /shared/homes/u00000003/Data/Workspace/NexusRec, python: /shared/homes/u00000003/miniconda3/envs/nexusrec/bin/python }
```

The plugin substitutes only a fixed set of neutral variables into `probe_command`: `{python}`, `{repo}`, `{probe_args_json}`, `{run_id}`. It assigns no meaning to them. The host comes from the existing `profiles[profile_id].login.host_alias`. A project running on multiple hosts has multiple `deployments` entries (different repo path + interpreter per host).

## 6. Run-record fields (structure carries semantics; opaque to the plugin)

```jsonc
{
  "run_id": "mmfedavg-food-lin-mainhpo",
  "project_id": "nexusrec",
  "probe_args": { "model": "MMFedAvg", "dataset": "Food", "variant": "lin", "run_type": "mainhpo" },
  "source": { "profile_id": "ihpc-u00000001" },
  "progress": { /* cached ProgressSnapshot, section 3 */ }
}
```

`probe_args` is an opaque bag forwarded verbatim to the project probe. The recommendation-domain semantics of `model/dataset/variant` live in the NexusRec probe, not in the plugin.

## 7. Functional primitives

| Primitive | Signature | Purity |
|-----------|-----------|--------|
| `resolveProbe` | `(record, projectsCfg, profilesCfg) → ProbeInvocation{host, command}` | pure |
| `runProbe` | `(ProbeInvocation) → RawStdout` | **side-effect (only SSH)** |
| `parseSnapshot` | `(RawStdout) → ProgressSnapshot` (validates schema) | pure |
| `persistProgress` | `(record, snapshot) → record'` | pure (returns new value) |

Orchestration is composition: `refresh = persistProgress ∘ parseSnapshot ∘ runProbe ∘ resolveProbe`. The three pure primitives are unit-tested with zero network (fed fixture bytes/objects); `runProbe` is the only mockable SSH seam.

`resolveProbe` is all structured lookups: `project_id → projects[project_id]`; `source.profile_id → deployments[profile_id] → {repo, python}`; host from `profiles[profile_id].login.host_alias`. No string parsing.

## 8. Ingesting `project_id` / `probe_args` into records

- **New adopt (structured injection):** `jobs_adopt` gains optional `projectId` + `probeArgs` parameters; when supplied they are written verbatim into the record. When absent, the record has no probe capability and the WebUI shows "unbound" (no guessing).
- **Backfill for existing records (one-time migration, the only slug parse):** an idempotent `scripts/backfill_progress_fields.mjs` operates only on records lacking `project_id`. It sets `project_id = "nexusrec"` and derives `probe_args` by parsing the slug ONCE, then writes them structurally. Runtime never parses thereafter.

## 9. MCP tool `experiment_progress`

```
input:  { runId (required), refresh?: bool = true, timeoutMs? }
behavior: refresh=true  → run the orchestration (resolveProbe→runProbe→parseSnapshot→persistProgress)
          refresh=false → read the cached snapshot from the record
output: { ok: true, progress: ProgressSnapshot, cached: bool, age_seconds }
errors: { ok: false, reason } where reason ∈
        { unbound, unconfigured, fetch_failed, probe_nonzero, schema_invalid }
```

Errors are in-band structured signals (no thrown stacks), consistent with the plugin's existing tool convention. Claude and the WebUI share this single orchestration; they differ only in `refresh` and whether they `persist`.

## 10. WebUI consumption: cached snapshot + TTL auto-refresh + manual refresh

- **`GET /api/runs/:id`** (existing detail) additionally returns the record's cached `progress`. On the request, if `progress.fetched_at` is older than the TTL (config, default 10 min) AND the run is still active (not done/failed), it triggers a **background** refresh (stale-while-revalidate): the cached snapshot is returned immediately and the record is updated asynchronously; the next poll sees the fresh value.
- **`POST /api/runs/:id/refresh`** (manual Refresh button) forces a synchronous probe and returns the fresh snapshot. Guarded by the same same-origin/CSRF check as existing POST actions.
- **Stampede guard:** one in-flight lock per `runId`; concurrent GETs trigger at most one background refresh.
- **Detail-page Progress panel:** status badge, counts progress bar (completed/running/target), metrics table, "data updated X ago / fetched Y ago", a Refresh button, and an error banner when a probe fails.

The WebUI stays a pure local-record reader by default (resilient to VPN outages, showing the last good snapshot); all SSH is concentrated in the shared orchestration invoked by the refresh paths.

## 11. Error states (always retain last good snapshot; explicit, never silent fallback)

| reason | WebUI display |
|--------|---------------|
| `unbound` (record has no `project_id`) | grey "probe unbound" chip, no panel |
| `unconfigured` (profile not in project `deployments`) | "probe unconfigured: \<profile\>" |
| `fetch_failed` (SSH/VPN down) | last good snapshot + "last refresh failed (VPN?), last successful fetch at \<fetched_at\>" |
| `probe_nonzero` / `schema_invalid` | "probe error", with stderr tail / raw-output tail for debugging |

## 12. Testing

| Unit | Test approach |
|------|---------------|
| `resolveProbe` | table-driven pure test: record+config → expected invocation; includes unbound/unconfigured |
| `parseSnapshot` | fixture stdout (valid + malformed) → snapshot / typed error, pure |
| `persistProgress` | record+snapshot → record', idempotent, preserves other fields |
| `runProbe` | mock the SSH seam: assert command assembly, surface non-zero/stderr |
| orchestration | fake fetch returning fixture stdout → end-to-end, no network |
| WebUI | TTL staleness logic, stampede debounce, refresh-endpoint same-origin guard (reuse existing webui test harness) |
| NexusRec probe | **project-side test** (lives in the project repo): given a fixture journal → emits a valid `ProgressSnapshot`; NOT a plugin test |

## 13. Scope / YAGNI

- No per-trial table in the WebUI; only the aggregate snapshot (counts + robust metrics + lifecycle). A full trial history is out of scope.
- No live log streaming through this feature; that remains the existing `jobs_logs` path (PBS only).
- The plugin ships exactly one reference probe contract + JSON Schema; it does not ship project probes. NexusRec's `tools/progress_probe.py` is a project artifact.
- TTL, default 10 min, is a single config value; no adaptive scheduling.

## 14. Files (anticipated; finalized in the implementation plan)

- Plugin: `mcp-server/src/lib/experiment-progress.ts` (the four primitives + orchestration), tool registration for `experiment_progress`, `jobs_adopt` param extension, `webui/server.mjs` detail enrichment + `POST /api/runs/:id/refresh` + TTL/stampede logic, WebUI detail-page Progress panel, a `ProgressSnapshot` JSON Schema file, `scripts/backfill_progress_fields.mjs`, config-loader support for the `projects` registry.
- Project (NexusRec, separate repo): `tools/progress_probe.py` + its fixture-journal test.
