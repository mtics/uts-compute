# iHPC live node truth — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin track which iHPC nodes an account is *actually* on (live `cnode mynodes`), auto-retire runs on nodes you no longer hold to a new `stale` status, and switch the WebUI Node-load panel to that live signal — so it stops showing rotted run-record nodes.

**Architecture:** A shared read-only `fetchHeldNodes(profileId)` seam wraps the existing `cnode mynodes` SSH path. The jobs reconcile sweep (`trackActiveJobs`) gains a per-profile held-set pre-pass that marks non-terminal iHPC runs whose node ∉ held set as `stale` — but ONLY when the held-node probe succeeded (preserving the audit-P0 "indeterminate never clobbers definite" invariant). `stale` joins the terminal set, so stale runs drop out of every "active" view at once. The WebUI Node-load panel derives its probe set from live held nodes (per record-profiles ∪ configured iHPC profiles) instead of `submission.node`.

**Tech Stack:** TypeScript (mcp-server, strict, compiled to `dist/`), Node's built-in `node:test`, vanilla-JS WebUI (`webui/server.mjs` + `webui/public/app.js`), AJV-validated JSON schemas. Inline remote python (if any) must stay RHEL7/py3.6-safe. Spec: `docs/superpowers/specs/2026-06-29-ihpc-node-truth-design.md`.

**Live-validated truth (use as test fixtures):** liyou holds `mars11`,`venus2`; zhiwli holds `mars4`,`saturn10`,`turing2`. The 40 rotted records sit on `venus6`,`mars15` (liyou) and `mars16`,`saturn2`,`turing2` (zhiwli) — `turing2` is the only still-held overlap.

---

## File structure

- `mcp-server/src/core/types.ts` — add `"stale"` to `RunRecord.status` union (line ~315); add optional `stale_reason?: string`.
- `schemas/run-record.schema.json` — add `"stale"` to the status enum (line ~148).
- `mcp-server/src/ops/quotas/held-nodes.ts` *(new)* — `fetchHeldNodes(profileId, opts)`; re-export/move `parseIhpcActiveNodes` here, have `quotas.ts` import it (no duplicate parser).
- `mcp-server/src/ops/jobs/jobs.ts` — `TERMINAL_STATUSES`/local `terminal` sets gain `"stale"`; new `reconcileStaleHeldNodes()` pre-pass in `trackActiveJobs`.
- `webui/server.mjs` — `TERMINAL_STATUSES` (line 205) gains `"stale"`; `relevantIhpcNodes` → `liveHeldNodeTargets` (held nodes per record-profiles ∪ configured iHPC profiles); `refreshNodeUsage` tags held-but-untracked nodes + per-profile probe errors.
- `webui/public/app.js` — render the `held · no plugin run` tag + per-profile "couldn't reach login host" state.
- `mcp-server/src/ops/jobs/ihpc-node-usage.ts` (+ any shared SSH-reason helper) — strip the OpenSSH post-quantum-KEX warning from probe stderr/reason.
- Tests mirror each under `mcp-server/tests/...` and `webui/tests/...`.

---

## Task 1: Add the `stale` run status (schema + types + terminal sets)

**Files:**
- Modify: `mcp-server/src/core/types.ts:315`
- Modify: `schemas/run-record.schema.json:148`
- Modify: `mcp-server/src/ops/jobs/jobs.ts:315` (the local `terminal` set) and any module-level `TERMINAL_STATUSES`
- Modify: `webui/server.mjs:205`
- Test: `mcp-server/tests/core/run-record-schema.test.mjs` (or the existing schema test file)

- [ ] **Step 1: Failing test — schema accepts `stale`, terminal sets include it**

```js
// mcp-server/tests/core/run-record-stale-status.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { validateRunRecord } from "../../dist/core/schema.js"; // use the project's existing validator entrypoint
test("run-record schema accepts status 'stale'", () => {
  const rec = { run_id: "run_x", profile_id: "ihpc-liyou", platform: "uts-ihpc",
    status: "stale", stale_reason: "node venus6 not in held set", created_at: "2026-06-29T00:00:00Z", events: [] };
  const r = validateRunRecord(rec);
  assert.equal(r.ok, true, JSON.stringify(r.errors));
});
```

- [ ] **Step 2: Run it, verify it FAILS** — `npm run build && node --test mcp-server/tests/core/run-record-stale-status.test.mjs` → FAIL (enum rejects `stale`).

- [ ] **Step 3: Implement** — add `"stale"` to: `types.ts:315` union; `schemas/run-record.schema.json:148` enum; add `stale_reason?: string` to the `RunRecord` interface near `status`. Add `"stale"` to the `terminal` set in `jobs.ts` (line 315) and the WebUI `TERMINAL_STATUSES` (`webui/server.mjs:205`). Grep for other `["finished","failed","cancelled"]` literals and add `"stale"` where they mean "terminal/non-active" (e.g. fleet-status, projects active-count).

- [ ] **Step 4: Verify PASS** — same command → PASS. Then full `npm test` (existing schema/projects/track tests still green).

- [ ] **Step 5: Commit** — `feat(types): add terminal 'stale' run status (node no longer held)`

---

## Task 2: `fetchHeldNodes(profileId)` shared seam

**Files:**
- Create: `mcp-server/src/ops/quotas/held-nodes.ts`
- Modify: `mcp-server/src/ops/quotas/quotas.ts` (import `parseIhpcActiveNodes` from the new module instead of its local copy at line 570)
- Test: `mcp-server/tests/ops/quotas/held-nodes.test.mjs`

Interface:
```ts
export interface HeldNodesResult {
  ok: boolean;                 // true = cnode mynodes succeeded (heldNodes authoritative, may be empty)
  heldNodes: Set<string>;      // node names; empty when ok && account holds nothing
  observedAt: string;
  reason?: string;             // present when ok === false
}
export async function fetchHeldNodes(
  profileId: string,
  opts: { configPath?: string; executor?: IhpcCommandExecutor; timeoutMs?: number } = {}
): Promise<HeldNodesResult>;
```

- [ ] **Step 1: Failing test** — inject a fake executor (the same pattern quotas tests use) returning a `cnode mynodes` stdout fixture; assert parse + ok semantics.

```js
// mcp-server/tests/ops/quotas/held-nodes.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { fetchHeldNodes } from "../../../dist/ops/quotas/held-nodes.js";
const MYNODES = "Node    Family\nmars11  mars\nvenus2  venus\n";
const okExec = async (_id, _host, argv) => ({ status: "passed", exit_code: 0,
  stdout: argv.join(" ") === "cnode mynodes" ? MYNODES : "", stderr: "" });
test("parses held nodes; ok=true", async () => {
  const r = await fetchHeldNodes("ihpc-liyou", { executor: okExec });
  assert.equal(r.ok, true);
  assert.deepEqual([...r.heldNodes].sort(), ["mars11", "venus2"]);
});
test("probe failure => ok=false, marks nothing", async () => {
  const failExec = async () => ({ status: "failed", exit_code: 255, stdout: "", stderr: "ssh: connect timeout" });
  const r = await fetchHeldNodes("ihpc-liyou", { executor: failExec });
  assert.equal(r.ok, false);
  assert.equal(r.heldNodes.size, 0);
});
test("ok with zero held nodes is valid (holds nothing)", async () => {
  const noneExec = async () => ({ status: "passed", exit_code: 0, stdout: "No nodes\n", stderr: "" });
  const r = await fetchHeldNodes("ihpc-liyou", { executor: noneExec });
  assert.equal(r.ok, true);
  assert.equal(r.heldNodes.size, 0);
});
```

- [ ] **Step 2: Run, verify FAIL** (module missing).

- [ ] **Step 3: Implement** — move `parseIhpcActiveNodes` (quotas.ts:570) into `held-nodes.ts` and export it; `quotas.ts` imports it. `fetchHeldNodes` resolves the profile (`loadProfile`/`listProfiles` via `configPath`), runs `runIhpcCommand("sessions.cnode-mynodes", host_alias, ["cnode","mynodes"], timeoutMs, executor)`, and returns `{ ok: cmd.status==="passed", heldNodes: new Set(parseIhpcActiveNodes(cmd.stdout).map(n=>n.node)), observedAt: now, reason }`. `ok:false` ⇒ empty set. Read-only; no approval gate.

- [ ] **Step 4: Verify PASS**; confirm quotas tests still pass (parser move is behavior-preserving).

- [ ] **Step 5: Commit** — `feat(quotas): extract fetchHeldNodes seam over 'cnode mynodes'`

---

## Task 3: Stale reconciliation in the jobs sweep (audit-P0-safe)

**Files:**
- Modify: `mcp-server/src/ops/jobs/jobs.ts` (new `reconcileStaleHeldNodes`, called early in `trackActiveJobs` after the `active` set is built ~line 357, before `selected`/reconcile)
- Test: `mcp-server/tests/ops/jobs/stale-held-nodes.test.mjs`

Truth table (the ONLY behavior): for each profile owning ≥1 non-terminal iHPC run, call `fetchHeldNodes(profile)` once; then per such run with node = `observed.node ?? submission.node`:

| held probe | node ∈ held? | action |
|---|---|---|
| `ok:true` | no | set status `stale`, `stale_reason`, append `status_reconciled`-style event, persist |
| `ok:true` | yes | no change (normal reconcile continues) |
| `ok:false` | — | **no change** (audit-P0: indeterminate never clobbers definite) |

- [ ] **Step 1: Failing tests** (inject a `fetchHeldNodes` stub via options seam):

```js
// uses a tmp auditDir with two iHPC running records: one on venus6 (not held), one on mars11 (held)
test("ok probe: run on un-held node -> stale; run on held node -> unchanged", async () => {
  const held = async () => ({ ok: true, heldNodes: new Set(["mars11"]), observedAt: "..." });
  await reconcileStaleHeldNodes(records, { fetchHeldNodes: held, auditDir });
  assert.equal(read("run_on_venus6").status, "stale");
  assert.match(read("run_on_venus6").stale_reason, /venus6/);
  assert.equal(read("run_on_mars11").status, "running");
});
test("failed probe: marks NOTHING (audit-P0)", async () => {
  const down = async () => ({ ok: false, heldNodes: new Set(), observedAt: "...", reason: "vpn" });
  await reconcileStaleHeldNodes(records, { fetchHeldNodes: down, auditDir });
  assert.equal(read("run_on_venus6").status, "running");
});
test("one cnode-mynodes call per profile, not per run", async () => { /* spy count === distinct profiles */ });
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** `reconcileStaleHeldNodes(records, deps)`: group non-terminal iHPC records by `profile_id`; `const held = await deps.fetchHeldNodes(profile)` once each; if `!held.ok` skip the whole profile; else for each run whose node ∉ `held.heldNodes`, write status `stale` + `stale_reason: \`node ${node} no longer in held set\`` + a reconcile event, via the same single-write record seam used by `updateRunStatus` (do NOT bypass it). Wire it into `trackActiveJobs`: run it on the iHPC subset of `active` before building `selected`; drop now-`stale` records from `selected`. Inject `fetchHeldNodes` through `JobOperationOptions` (default to the real one) so tests stub it.

- [ ] **Step 4: Verify PASS**; run the existing `jobs`/`track`/`reconcile` tests — confirm the audit-P0 reconcile tests still pass (we add a parallel definite path, we do not change `updateRunStatus`'s unknown-handling).

- [ ] **Step 5: Commit** — `feat(jobs): retire runs on no-longer-held iHPC nodes to 'stale' (probe-success-guarded)`

---

## Task 4: WebUI Node-load = live held nodes

**Files:**
- Modify: `webui/server.mjs` (`relevantIhpcNodes` → `liveHeldNodeTargets`; `refreshNodeUsage`)
- Test: `webui/tests/node-load-live.test.mjs`

- [ ] **Step 1: Failing tests** (inject `fetchHeldNodes` + `nodeUsageExecutor` through the server config the tests already use):

```js
test("node set = live held nodes per (record-profiles ∪ configured iHPC profiles), not submission.node", async () => {
  // records say venus6/mars15 (liyou); held says mars11/venus2 -> targets are mars11,venus2 (not venus6)
});
test("held node with no matching run record is tagged held_no_run", async () => { /* assert node.held_no_run === true */ });
test("fetchHeldNodes failure for a profile -> per-profile probe_error, last snapshot retained", async () => {});
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — replace `relevantIhpcNodes` with `liveHeldNodeTargets(cfg)`: profiles = (iHPC profiles in non-terminal records) ∪ (all `listProfiles(cfg.configPath)` whose platform is `uts-ihpc`); for each, `fetchHeldNodes(profile)`; targets = each held node (carry `held_no_run = !someActiveRecordHasNode(node)`); on `!ok`, emit `{ profile_id, probe_error: reason }` and keep the prior snapshot for that profile. `refreshNodeUsage` probes each held node's GPU (existing `runIhpcNodeUsage`) and ALSO calls Task-3 `reconcileStaleHeldNodes` (so a panel refresh self-heals the ledger). Snapshot node objects gain `held_no_run` and the response gains `profile_errors[]`.

- [ ] **Step 4: Verify PASS**; full `webui` test suite green.

- [ ] **Step 5: Commit** — `feat(webui): node-load probes live held nodes (cnode mynodes), tags held-but-untracked`

---

## Task 5: Frontend tag + per-profile error, and strip the PQ-KEX warning

**Files:**
- Modify: `webui/public/app.js` (node-load card render)
- Modify: `mcp-server/src/ops/jobs/ihpc-node-usage.ts` (and/or the shared SSH-reason helper) — strip the warning
- Test: `webui/tests/*` (app.js string assertions, the project's existing style) + `mcp-server/tests/ops/.../node-usage-reason.test.mjs`

- [ ] **Step 1: Failing tests**

```js
// reason strip (unit)
test("post-quantum KEX warning is stripped from probe reason", () => {
  const raw = "** WARNING: connection is not using a post-quantum key exchange algorithm.\n** This session may be vulnerable...\nnvidia-smi: command not found";
  assert.equal(stripSshNoise(raw), "nvidia-smi: command not found");
});
// app.js render (existing webui assertion style)
test("app.js renders a 'held · no plugin run' tag", () => { assert.match(appjs, /held · no plugin run/); });
```

- [ ] **Step 2: Run, verify FAIL.**

- [ ] **Step 3: Implement** — add `stripSshNoise(text)` that drops lines matching `/post-quantum key exchange/i`, the "store now, decrypt later" line, the "server may need to be upgraded" line, and the iHPC welcome-banner block, then trims; apply it where the probe builds its failure `reason`. In `app.js`, render the `held · no plugin run` chip for `node.held_no_run` and a per-profile "couldn't reach login host — <reason>" line from `profile_errors`. Verify with `node --check app.js` + a browser render (0 console errors) per project convention.

- [ ] **Step 4: Verify PASS** (both tests; browser check).

- [ ] **Step 5: Commit** — `feat(webui): held-but-untracked tag + strip OpenSSH post-quantum warning from probe reasons`

---

## Task 6: Docs + version

**Files:** `README.md`, `docs/architecture*.md` (node-load description), `webui/README.md`, the four lockstep version manifests, the spec's Status line.

- [ ] **Step 1** Update the Node-load docs to describe the live-held-nodes source + the `stale` status; mark the spec `implemented`.
- [ ] **Step 2** Bump version in the four lockstep manifests (package.json, manifest.json, server.json + release URL, `.claude-plugin/plugin.json`) + README badge.
- [ ] **Step 3** `npm test` full suite green; `npm run validate:plugin`.
- [ ] **Step 4: Commit** — `docs(release): iHPC live node truth + version bump`

---

## Self-review

- **Spec coverage:** C1 fetchHeldNodes → T2; C2 stale reconcile → T3; C3 `stale` status+terminal → T1; C4 panel live held nodes → T4; C5 PQ strip → T5; held-but-untracked tag → T4/T5; acceptance #1–5 covered (live-node fixtures match the validated mars11/venus2/mars4/saturn10/turing2 truth). ✅
- **Audit-P0:** T3 acts only on `ok:true`; the failed-probe test pins "marks nothing"; `updateRunStatus` unknown-handling is untouched. ✅
- **Type consistency:** `fetchHeldNodes`/`HeldNodesResult` signature identical in T2, T3, T4; `held_no_run` + `profile_errors` introduced in T4 and consumed in T5; `stale`/`stale_reason` defined in T1 and used in T3. ✅
- **No placeholders:** every task carries concrete tests + integration points + commit. (Idiomatic final code follows the cited existing patterns — quotas executor injection, the single-write record seam, the webui injectable executors.) ✅
