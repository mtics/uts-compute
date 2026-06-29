# uts-compute dashboard (`webui/`)

A lightweight, **read-mostly, localhost-only** experiment-tracking web UI over the redacted JSON the
MCP server writes under `.uts-computing/`. Built on [Tabler](https://tabler.io) (MIT) via CDN — **no
build step**. It is an *optional, isolated* surface: nothing here is imported by the client-neutral MCP
core. See [../docs/dashboard-design.md](../docs/dashboard-design.md) for the full design.

## Run

```sh
npm run build        # the dashboard imports the compiled mcp-server/dist/*
npm run webui        # stops old WebUI listeners, then serves http://127.0.0.1:4173
npm run webui:stop   # manually stop the fixed WebUI port when needed
npm run webui:status # check whether the fixed WebUI port is still occupied
```

Then open <http://127.0.0.1:4173>. Pages:

- **Runs** — an operational dashboard: an execution overview (active / queued / platforms / accounts /
  nodes / evidence), a Projects glance, a live iHPC **Node load** section (per-node GPU utilization,
  derived from the account's **live held nodes** via `cnode mynodes` on the login host — new nodes
  appear automatically, departed nodes vanish; held nodes with no plugin run record are tagged
  "held · no plugin run"; a non-terminal iHPC run whose node is no longer held is auto-retired to
  `stale` on reconcile/refresh, only when the held-node probe succeeds; folded in here, not a standalone
  page) on one row with a **Runs by status** donut, then **Core-hours by project** on its own row. The
  detailed, filterable/sortable run table now lives in **Explore**. A **Live probe** control re-polls
  active runs' status + usage over SSH and re-discovers the live held-node set (with an opt-in
  **Auto-probe** interval), kept distinct from the local **Auto-refresh** reload.
- **Run detail** — Overview / Plan & Resources / Lifecycle / Logs / Artifacts. The Overview starts
  with action readiness, evidence completeness, and resource evidence cards before the metric summary;
  **Submit** (planned runs), **Clone/Rerun** (terminal runs), and **Abort** (active runs) remain
  state-gated actions, opened through local modals that show payload evidence and keep MCP gates intact.
- **Explore** — resource-fit analysis with a compact `Current analysis` summary, URL-backed
  project/status/platform/queue filters, fixed group-by modes, a requested-vs-used memory scatter,
  chart scope/freshness/missing-usage context, clickable group summaries, right-sizing candidates,
  walltime review, and a matching table with core-hours, GPU-hours, CPU-efficiency bars, and
  run-detail links. For iHPC runs (no per-run scheduler accounting) the GPU column shows the **observed
  node-level GPU** from the node-load probe as a provenance-distinct chip; finished PBS **array jobs**
  show usage aggregated across their sub-jobs (`qstat -x -t`).
- **Capacity Snapshot** (`/capacity`) — profile/snapshot freshness, per-queue headroom, iHPC family/session
  evidence, and storage headroom from a captured quota snapshot, without implying live worker
  monitoring. When a saved/latest snapshot is available, evidence renders before the compact
  `Change capacity snapshot` controls. Legacy `/queue` URLs are normalized for compatibility.
- **Projects** — compact project index table with health, ordered status mix, filtered Runs links,
  scope, and latest-update evidence.

A **light/dark theme toggle** (top-right, persisted) and an **auto-refresh** switch (Runs list + live run
detail, 10 s) are available throughout. The left menu has been replaced by a compact top navigation
with separate `local`, `read-mostly`, and `MCP-gated` safety chips plus page-specific scope chips.
Aggregate KPIs come from `GET /api/summary`; the Explore data
from `GET /api/explore` (each run enriched with its usage/requested resources).

## What it is / isn't

- **Reads** the same already-redacted local state as the `uts://` resources (run records, plans,
  projects, capacity, artifact manifests). No secrets, no `profiles.local.yaml`.
- **Write actions** (clone → `jobs.retry.plan`, rerun → `jobs.submit`, abort → `jobs.cancel`, decide →
  `approvals.decide`) call the **same** built functions the MCP tools use, so they pass the **same**
  gates — plan_hash re-verification, live conformance, and the Tier-B human-confirmation token. The
  token lives in the server's env (`UTS_COMPUTING_APPROVAL_TOKEN`), never in the browser.
- Binds **`127.0.0.1` only** on the fixed local port `4173`; `npm run webui` stops any old listener
  on that port before starting a new one, and `npm run webui:stop` also clears stale WebUI server
  listeners left behind on `4174-4189`. Avoid starting ad-hoc `417x` dashboard ports; this is a
  single-user local tool, not a multi-tenant web app.
- **Not** a SaaS tracker, hosted leaderboard, or a replacement for the MCP tools — it visualizes and
  triggers them.

## Layout

- `server.mjs` — the Node HTTP server (`createWebuiServer(options)` for tests; CLI entry binds localhost).
- `public/` — `index.html` + `app.js` (vanilla SPA) + `app.css`.
- `tests/webui.test.mjs` — regression for the API + actions + safety guards (run by `npm test`).
