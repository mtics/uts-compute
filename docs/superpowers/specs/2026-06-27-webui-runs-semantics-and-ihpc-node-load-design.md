# WebUI Runs Semantics + iHPC Node-Load — Design

Date: 2026-06-27 · Branch: `feat/webui-runs-semantics` (isolated worktree off `6be9c32`)

## Problem

The WebUI dashboard shows "a large amount of missing information." Verified root cause (80 run records: 40 HPC / 40 iHPC; 58 adopted): a **data-model mismatch** — the UI was built for plugin-*planned* runs (which carry `plan_hash`, `requested`, `project`, `reproducibility`, and accrue `usage`), but ~73% of real runs are *adopted/observed* externals that structurally lack those fields. The UI renders every structural absence as an undifferentiated `—`, and the Explore scatter silently drops the ~58–73 records that lack both `usage.mem_gb` and `requested.memory_gb`, so it looks broken.

## Scope (this spec = the WebUI / frontend lane only)

A concurrent session is developing the **backend** on `feat/usage-audit-remediation` (P-roadmap). It already committed `6be9c32` — the iHPC **observe** path: `observed:{node,pid}` on adopted iHPC records, and `jobs.status` returning `liveness` + `gpu_usage: NodeUsageView` (the node's live per-GPU snapshot). To avoid collision we divide by domain:

- **In scope (here):** everything under `webui/` + additive `schemas/` data contracts + `webui/tests/`. We **consume** committed backend domain functions; we do **not** edit `mcp-server/src/ops/*`.
- **Out of scope (backend lane):** per-PID GPU attribution (`NODE_USAGE_PY`), and Track 2.5 (`adopt.ts` parsing PBS `Resource_List` → `submission.requested`).

Integration fact that shapes the design: `gpu_usage` is **not persisted** to the run record — it lives only in the live `jobs.status` result. So the node-load view must orchestrate the probe and persist its own snapshot.

## Track 1 — Run semantics (U1) + view adoption (U2)

### U1 — `webui/public/run-semantics.js` (new ES module; semantics in structure, not naming)

The fix is one cohesive abstraction, threaded everywhere — authored as a single module, not parallelized.

- `classifyRun(run) → { kind, platform, isAdopted }` where `kind ∈ {planned, adopted-hpc, adopted-ihpc}`. Derived from `run.adoption`/`observed`/`reproducibility`/`platform`.
- `resolveFieldState(run, fieldKey) → { state, value, reason }` — the core function. State is `f(run-kind, run-status, field)`, not a property of the field:
  - `present` — value exists → show it.
  - `pending` — expected, can still be filled (e.g. HPC `usage` while running) → muted, not alarming.
  - `not_applicable` — structurally impossible for this kind → `n/a · <reason>`.
  - `unknown` — the matrix says `present` but the value is absent → **loud**; doubles as a data-integrity probe (should be rare).
- Canonical state→DOM renderers (`stateCell`, `stateChip`) reusing the existing `evidenceChip` 3-state visual vocabulary (`present`/`missing`/`not-applicable`) already at `app.js:435–443,509`.

The field × kind → state matrix (the structural semantics):

| field | planned-HPC | adopted-HPC | adopted-iHPC |
|---|---|---|---|
| `requested` | present | pending (until backend Track 2.5) | not_applicable (external start) |
| `usage` | pending | pending (live `qstat`) | not_applicable (no batch accounting) |
| `queue` | present | pending | not_applicable |
| `placement` | not_applicable | not_applicable | pending (if adopt provided) |
| `plan_hash`/`project`/`reproducibility` | present | not_applicable (never planned) | not_applicable |
| `node` | present | present | present (`observed.node`) |
| `liveness` / node GPU | not_applicable | not_applicable | present via observe (live) |

### U2 — view adoption

`app.js` table / KPI / Run-detail consume U1 instead of ad-hoc `?? "—"`. Explore is fixed: never silently drop — show the excluded count prominently and either plot adopted/iHPC rows with a "no usage" treatment or clearly mark non-plotted rows.

## Track 5 L1 — iHPC node-load view (frontend-orchestrated)

- **Relevant node set:** active iHPC runs' `observed.node` (fallback `submission.node`), grouped by `profile_id`.
- **`webui/server.mjs`:**
  - `POST /api/ihpc/node-usage/refresh` (explicit action, mirrors existing `submit`/`cancel` actions): call `runIhpcNodeUsage(profileId, node)` per node (committed, fail-closed), aggregate, persist `.uts-computing/node-usage/<profile>-<ts>.json`.
  - `GET /api/ihpc/node-usage`: read latest snapshot(s); return per-node GPUs + freshness + a balance summary.
- **`schemas/ihpc-node-usage-snapshot.schema.json`** (additive data contract): `{ profile_id, probed_at, nodes:[{ node, status, gpus:[{index,name,utilization_gpu_percent,memory_used_mb,memory_total_mb}], reason? }] }`.
- **`app.js` "Node load" view:** per-node per-GPU util/memory bars; a **balance indicator** (util spread across nodes, and an "idle-held" flag = a node a live run holds but whose GPUs read ~0%); `node-unverifiable` shown honestly (never 0%); freshness label.

## Track 5 L2 — per-experiment hardware reasonableness

- **Frontend (here):** for each observed iHPC run, join the node-usage snapshot by `node` → show "experiment on node X · node GPU Y% / Z GB" as node-level context, plus an idle-held heuristic (`liveness=alive` ∧ node GPUs ~0% ⇒ likely wasting the GPU). Coarse: cannot separate co-located experiments on a shared node (e.g. many runs on `venus6`).
- **Backend dependency (their lane):** true per-PID attribution requires `NODE_USAGE_PY` to emit per-compute-app `{pid, used_memory}` (+ pmon for util), joined by `(node, observed.pid)`. Frontend will consume per-PID fields when present; until then the boundary is explicit.

## Non-goals

- No edits to `mcp-server/src/ops/*` (backend lane). No live SSH on GET render — only the explicit refresh action.

## Testing

- `webui/tests/`: unit tests for `classifyRun` + `resolveFieldState` (the full matrix); node-usage endpoints with a mocked probe executor (ok + `node-unverifiable`); an Explore-inclusion test (no silent drop). `npm test` green.

## Phasing

1. U1 module + tests. 2. U2 adoption + Explore fix. 3. L1 endpoints + view + tests. 4. L2 frontend (node-level per-run context) + documented per-PID backend boundary.
