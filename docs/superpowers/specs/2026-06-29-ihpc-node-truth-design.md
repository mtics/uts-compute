# iHPC live node truth — held-node discovery + stale reconciliation

- **Date:** 2026-06-29
- **Status:** approved design, pending implementation plan
- **Supersedes/extends:** [`2026-06-27-webui-runs-semantics-and-ihpc-node-load-design.md`](2026-06-27-webui-runs-semantics-and-ihpc-node-load-design.md) (the original run-record-derived Node-load panel)

## Problem

The plugin's notion of "which iHPC nodes my account is currently on" is derived **only** from local run records' `submission.node` (or `observed.node`), written once at submit/adopt and updated only by reconcile — and reconcile against a node you have left is *indeterminate*, so by the audit-P0 invariant it can never move the record out of `running`. The records therefore **rot**:

- Observed live: 40 iHPC run records (one account batch, `created_at` 2026-06-20), all still `status: running`, `observed.node` empty, node taken from `submission.node`. They have `remote_job_id` but no supervisor/campaign/adoption block.
- The WebUI **Node load** panel ([`webui/server.mjs:209` `relevantIhpcNodes`](../../../webui/server.mjs)) probes exactly those frozen nodes; the four the user has left are unreachable → `unreadable`, and the user's **new** nodes never appear because no record points at them.
- "Refresh (live probe)" ([`webui/server.mjs:232` `refreshNodeUsage`](../../../webui/server.mjs)) only re-probes the frozen set — it cannot re-discover reality.

This is a capability gap, not bad data: the plugin has no path from "the run is on a node I no longer hold" to "stop trusting that record."

## Key finding — live discovery already exists over SSH

`quotas.refresh` already runs **`cnode mynodes`** on the profile's **login host** ([`mcp-server/src/ops/quotas/quotas.ts:142`](../../../mcp-server/src/ops/quotas/quotas.ts)) and parses it via `parseIhpcActiveNodes` ([`quotas.ts:570`](../../../mcp-server/src/ops/quotas/quotas.ts)) into `sessions.active_nodes` — the account's **authoritative currently-held node set**, per profile. It is:

- **SSH-only, no portal, no new creds** — runs on the login gateway, so it sees held nodes even for compute nodes you can no longer reach. (This removes the previously-deferred portal/`/clusters` Django-login dependency entirely.)
- Already trusted by the codebase for node-limit conformance (`computeNodePoolOccupancy`, `selectActiveComputeNode`, capacity).

The gap is only that the Node-load panel and the reconcile ledger **ignore** this signal.

## Design

Treat `cnode mynodes` as the source of truth for "which nodes am I on," and reconcile both the **ledger** (run records) and the **display** (Node-load) against it.

### Component 1 — shared `fetchHeldNodes(profileId)` seam

A single read-only function: run `cnode mynodes` on the profile's login host, parse with the existing `parseIhpcActiveNodes`, and return:

```
{ ok: true,  heldNodes: Set<string>, observedAt: string }   // probe succeeded (may be empty set = holds zero nodes)
{ ok: false, reason: string }                                // probe failed (VPN down / SSH error / timeout)
```

Extract/reuse the existing quotas implementation so reconcile and the WebUI share one code path (no second parser). Same trust + safety class as `quotas.refresh` / `jobs.track` — read-only, **not** approval-gated.

### Component 2 — stale reconciliation (core, self-healing)

In the reconcile/track path ([`jobs.ts:290` `trackActiveJobs`](../../../mcp-server/src/ops/jobs/jobs.ts), feeding [`reconcileRunStatus`](../../../mcp-server/src/ops/jobs/jobs.ts)): for each profile that owns non-terminal iHPC runs, call `fetchHeldNodes(profile)` **once** per sweep, then apply the transition truth table:

| `fetchHeldNodes` | run's node in held set? | action |
|---|---|---|
| `ok: true` | **no** | transition run → **`stale`** (definite negative signal) |
| `ok: true` | yes | leave to normal per-run reconcile |
| `ok: false` (probe failed) | — | **mark nothing** — preserve current status; record an `observation_failed`-style event |

The "node not in my held set" signal is **definite** (it comes from the login host's own session view), so marking `stale` does **not** violate the audit-P0 rule in [`updateRunStatus`](../../../mcp-server/src/ops/jobs/jobs.ts) ("an indeterminate observation must never clobber a definite ledger state"). The guard is strict: stale is applied **only** when the held-node probe `ok: true`.

### Component 3 — new `RunRecord.status = "stale"`

Add `stale` to the RunRecord status enum (schema + `mcp-server/src/core/types.ts`) and to `TERMINAL_STATUSES` (in `jobs.ts` **and** the WebUI's copy at [`webui/server.mjs:205`](../../../webui/server.mjs)). Effect: stale runs drop out of "active" **everywhere** at once — Node-load, fleet-status, projects, usage.

`stale` is deliberately distinct from `finished`/`failed`/`cancelled`: the outcome is **unknown**; it means *"the plugin can no longer see this run on a node you hold."* The record carries `stale_reason` and the observing `observed_at`, and emits a reconcile event so the transition is auditable. (No claim of success/failure is ever fabricated.)

### Component 4 — WebUI Node-load = live held nodes

`relevantIhpcNodes` becomes **"live held nodes per relevant profile"**: the set of iHPC profiles to query = profiles present in active run records **∪** all configured iHPC profiles (so a profile whose every run just went `stale` is still queried and its new nodes surface). On **Refresh (live probe)**:

1. `fetchHeldNodes(profile)` for each relevant profile;
2. probe each held node for GPU (existing `runIhpcNodeUsage`);
3. run the Component-2 stale reconciliation.

Result: new nodes appear automatically; left nodes vanish. A held node with **no matching run record** is shown tagged **"held · no plugin run"** (so manually-started work is visible). Run→node attribution for the held nodes still comes from run records. A `fetchHeldNodes` failure for a profile shows a per-profile probe error and falls back to the last snapshot — it never silently freezes a stale node list.

### Component 5 — side cleanups (in scope)

- Strip the OpenSSH **"WARNING: connection is not using a post-quantum key exchange algorithm"** line from probe stderr before it reaches reasons/messages (it is a red herring that currently pollutes the `unreadable` text and misdirects diagnosis).

## Data flow

```
Refresh (live probe) ─┐
jobs.track / sweep  ──┼─→ fetchHeldNodes(profile)  [ssh: cnode mynodes @ login host]
                      │        │ ok:true → heldNodes set        │ ok:false
                      │        ▼                                ▼
                      │   per non-terminal iHPC run:        mark nothing
                      │     node ∈ held → normal reconcile  (observation_failed event)
                      │     node ∉ held → status = stale
                      ▼
   Node-load panel node set = ⋃ heldNodes(profile)  →  probe GPU per held node
                                                        held & no run record → "held · no plugin run"
```

## Error handling

- **Held-node probe fails** (VPN/SSH/timeout): no stale marking (Component 2 guard); WebUI shows per-profile probe error + last snapshot fallback.
- **`cnode mynodes` returns zero nodes** (you hold nothing): valid `ok:true` empty set → every non-terminal run for that profile becomes `stale`; panel shows no nodes for that profile. Correct.
- **Transient hold gap** (between sessions): a run could be marked `stale` while you briefly hold no node. Acceptable: `stale` is recoverable — a later adopt/submit creates a fresh non-terminal record; we never delete data.
- **Audit-P0:** strictly never mark `stale` on an indeterminate (`ok:false`) probe.

## Testing

- `fetchHeldNodes`: parse reuse (held node names, header/empty filtering, family inference); `ok:false` on non-zero/timeout.
- Stale-transition truth table: held / not-held / probe-failed → only (not-held ∧ probe-ok) marks `stale`.
- Audit-P0 guard: probe-failed marks nothing, preserves `running`, emits failure event.
- `stale` ∈ `TERMINAL_STATUSES` in both `jobs.ts` and `webui/server.mjs`; stale runs excluded from active counts (fleet-status/projects/usage) and from the Node-load probe set.
- WebUI: node set derived from held nodes (not run records); profile union (records ∪ configured); held-but-untracked tag; per-profile probe-error fallback.
- PQ-KEX warning stripped from a probe stderr fixture.

## Out of scope (YAGNI)

- iHPC portal / `/clusters` scraping — the SSH `cnode mynodes` path makes it unnecessary.
- Auto-*adopting* the new runs into full supervised tracking — the panel surfaces them as "held · no plugin run"; adopting remains a separate, opt-in `jobs.adopt`.
- Retroactively classifying *why* an old run ended (finished vs killed) — unknowable from the held-set; `stale` is the honest state.

## Acceptance criteria

1. After Refresh, Node-load shows the account's **currently held** nodes (new nodes appear, left nodes gone) for every relevant profile.
2. A non-terminal iHPC run on a node no longer held becomes `stale` on the next reconcile/refresh **iff** `cnode mynodes` succeeded; it never changes on a failed probe.
3. `stale` runs disappear from active counts in fleet-status, projects, usage, and the Node-load probe set.
4. The 40 observed 2026-06-20 records reconcile to `stale` once their accounts' held sets are probed (the old 5 nodes leave the panel), and any node those accounts now hold appears.
5. The post-quantum-KEX warning no longer appears in probe error text.

## Touched surfaces (add-a-behaviour 5-touch rule)

- `mcp-server/src/ops/quotas/` (or a new `ops/.../held-nodes.ts`) — extract/expose `fetchHeldNodes` + reuse `parseIhpcActiveNodes`.
- `mcp-server/src/ops/jobs/jobs.ts` — stale reconciliation in `trackActiveJobs`/`reconcileRunStatus`; `TERMINAL_STATUSES`.
- `mcp-server/src/core/types.ts` + `schemas/*run-record*.schema.json` — add `stale` status + `stale_reason`.
- `webui/server.mjs` — `relevantIhpcNodes` → live held nodes; `refreshNodeUsage` reconcile; `TERMINAL_STATUSES`; held-but-untracked tag; PQ-warning strip.
- `webui/public/app.js` — render the "held · no plugin run" tag + per-profile probe-error state.
- Tests mirroring each (mcp-server/tests + webui/tests).
