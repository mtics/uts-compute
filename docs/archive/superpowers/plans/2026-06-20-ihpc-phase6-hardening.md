# iHPC Internalization — Phase 6 (Correctness hardening) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the long-tail correctness gaps: make the `safeTool` nested-await footgun structurally impossible instead of hand-policed (H9); validate `jobs.history`'s `since` as a real ISO datetime instead of a raw string compare (L18); make `projectRoot` robust to layout changes so state/resource paths stop rendering `<outside-project>` (M12/L17); and let `quotas.capacity` optionally refresh a stale snapshot before reporting (L16).

**Architecture:** A runtime guard inside `safeTool` deep-checks the resolved result for any Promise-valued property and throws a clear error — covering all 46 tools with zero false positives (a static lint over hand-discipline is fragile; the guard supersedes it). `validateSinceFilter` is a pure leaf validator. `projectRoot` becomes a `package.json`-marker walk-up with a safe fallback. `quotas.capacity` gains an opt-in `refresh` that reuses the existing executor seam.

**Tech Stack:** TypeScript (ES modules), Zod, `node --test`, the existing `safeTool`/`paths`/`history`/`quotas` machinery. No new tools (stays at **46**).

---

## Key design decisions
- **H9 = runtime guard, not a static lint.** The recon recommends it: the guard runs after `await handler()` and throws if any result property is a thenable — zero false positives, covers every tool and future refactor, no async-function-list to maintain. A bare `return somePromise` stays correct (safeTool already awaits the top-level return; the guard inspects the *resolved* result). The fragile regex lint (high false-positive risk) is **not** worth it given the guard. Also audit `access.doctor` (recon's suspected offender) — but only fix if it's a genuine un-awaited *property* Promise; a bare `return runDoctor(...)` is fine.
- Baseline suite is **471**; tool count **46** (Phase 6 adds none). Commit per task; do not push (controller batches the push to PR #4).

---

### Task 1: H9 — `safeTool` runtime guard + audit

**Files:**
- Modify: `mcp-server/src/index.ts` (the `safeTool` wrapper ~:122-139; audit/fix `access.doctor` ~:293-301 if needed)
- Test: `mcp-server/tests/integration/safetool-guard.test.mjs` (or extend an existing integration test)

- [ ] **Step 1: Audit.** Read the `access.doctor` handler (index.ts:~293-301). Determine whether it returns an object with an **un-awaited Promise property** (a bug) or a bare `return runDoctor(...)` (safe — safeTool awaits the top-level return). Fix only a genuine property-Promise (make the handler `async` and `await` the call). Note the finding.
- [ ] **Step 2: Write the failing test** — a tool handler returning `{ x: Promise.resolve(1) }` (un-awaited property) must make `safeTool` produce an **error envelope** (or throw), not silently serialize `{ x: {} }`:
  ```javascript
  // Construct a safeTool-wrapped handler that returns an object with a Promise property,
  // call it through the registered tool (or test safeTool directly if exported), and assert
  // the result is { ok: false, error: /unawaited|promise/i } — NOT { ok: true, x: {} }.
  ```
  (If `safeTool` isn't exported, add a tiny test-only export or drive it through a temporary registered tool via the stdio client; prefer the simplest that exercises the guard.)
- [ ] **Step 3: Implement the guard** in `safeTool`, after `const result = await handler()`: if `result` is a non-null object (and not an array), check each own-enumerable property value; if any is a thenable (`typeof v?.then === "function"`), throw `new Error("Tool handler returned an un-awaited Promise in property '<k>' — await it before returning (safeTool only awaits the top-level return).")`. The surrounding try/catch turns it into the standard `{ ok:false, error }` envelope. Keep it shallow (top-level properties only — that's where the footgun lives) and cheap.
- [ ] **Step 4: Run full suite** — `npm test`. Confirm all 46 tools still pass (no legitimate handler returns a Promise property), the new guard test passes, and any `access.doctor` fix is green.
- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/index.ts mcp-server/tests/integration/safetool-guard.test.mjs
  git commit -m "fix(mcp): safeTool runtime guard rejects un-awaited Promise result properties (H9)"
  ```

---

### Task 2: L18 — `jobs.history` `since` ISO-8601 validation

**Files:**
- Modify: `mcp-server/src/ops/jobs/history.ts` (`validateSinceFilter` + call it), `mcp-server/src/index.ts` (tighten the `since` input schema)
- Test: `mcp-server/tests/ops/jobs-history.test.mjs`

- [ ] **Step 1: Write the failing test:**
  ```javascript
  test("jobs.history rejects a non-ISO 'since' with a clear error", () => {
    assert.throws(() => jobsHistory({ since: "2026/06/05", auditDir }), /ISO-8601|since/i); // wrong separators
    assert.throws(() => jobsHistory({ since: "yesterday", auditDir }), /ISO-8601|since/i);   // not a datetime
  });
  test("jobs.history still accepts a valid ISO 'since'", () => {
    // existing behavior: a valid ISO since filters by created_at >=
  });
  ```
- [ ] **Step 2: Run — FAIL** (non-ISO currently passes the raw `>=` compare).
- [ ] **Step 3: Implement `validateSinceFilter(since)`** in `history.ts` (pure): `undefined → undefined`; reject with a clear error if it fails `/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/` OR `!Number.isFinite(Date.parse(since))`; else return it. (The regex is the primary shape guard. `Date.parse` is defensive — it catches out-of-range like a month >12, but NOT calendar-day rollover: `Date.parse("2026-02-30T00:00:00.000Z")` is *finite* (rolls to Mar 2), so do NOT claim to reject Feb-30 — the well-formed-ISO regex is sufficient and rollover dates are acceptable.) Call it at the top of `jobsHistory` before the `since` filter. Tighten `index.ts`'s `since` schema to `z.string().regex(...).optional()` for early client feedback (keep the handler validation too, since `jobsHistory` is called directly in tests/other paths).
- [ ] **Step 4: Run full suite** — `npm test` green.
- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/ops/jobs/history.ts mcp-server/src/index.ts mcp-server/tests/ops/jobs-history.test.mjs
  git commit -m "fix(jobs): validate jobs.history 'since' as ISO-8601 (L18)"
  ```

---

### Task 3: M12/L17 — robust `projectRoot` anchor

**Files:**
- Modify: `mcp-server/src/core/paths.ts` (replace the `resolve(distDir,'../../..')` with a marker walk-up)
- Test: `mcp-server/tests/core/state-dir.test.mjs` or a new `paths-projectroot.test.mjs`

- [ ] **Step 1: Write the failing/guard test:** assert `projectRoot` is the directory that contains the repo `package.json` with `name: "uts-compute"`, and that `schemas/` and `profiles/profiles.example.yaml` exist under it. (This pins the load-bearing invariant — schema/example resolution depends on it.)
- [ ] **Step 2: Implement `resolveProjectRoot()`** in `paths.ts`: walk up from `path.dirname(fileURLToPath(import.meta.url))` (bounded, e.g. 10 levels); at each level read `package.json` and return the dir if `JSON.parse(...).name === "uts-compute"`; stop at filesystem root. **Fallback** to the historical `path.resolve(distDir, "../../..")` (with a one-line stderr warning) so existing installs don't regress. Replace `export const projectRoot = path.resolve(distDir, "../../..")` with `export const projectRoot = resolveProjectRoot()`. Add the `fs` import if missing.
- [ ] **Step 3: Run full suite** — `npm test`. Confirm schema/example resolution still works (config-fallback, validation, resources tests stay green) and `projectRoot` points at the repo root. This is load-bearing — be thorough.
- [ ] **Step 4: Commit**
  ```bash
  git add mcp-server/src/core/paths.ts mcp-server/tests/core/state-dir.test.mjs
  git commit -m "fix(core): anchor projectRoot via package.json marker, not a fixed dist depth (M12/L17)"
  ```

---

### Task 4: L16 — `quotas.capacity` opt-in refresh

**Files:**
- Modify: `mcp-server/src/ops/quotas/capacity.ts` (accept an optional refresh path), `mcp-server/src/index.ts` (the `quotas.capacity` schema gains `refresh?: boolean`; annotation → READ_REMOTE), `mcp-server/tests/integration/mcp-protocol.test.mjs` (capacity's annotation entry changes)
- Test: `mcp-server/tests/ops/capacity.test.mjs`

- [ ] **Step 1: Write the failing test** (mock executor): `quotaCapacity({ profileId, refresh: true }, { executor })` re-runs `quotas.refresh` (the executor seam) to produce a fresh snapshot, then reports capacity on it (no stale-age note). With `refresh:false`/absent, behavior is unchanged (reads the saved snapshot).
- [ ] **Step 2: Run — FAIL** (no refresh path).
- [ ] **Step 3: Implement.** Add an optional `refresh` to `quotaCapacity`'s input; when true, call the existing `refreshQuotas` (executor-seam) for the profile, then compute capacity on the fresh snapshot. Thread the executor option (mirror how job ops accept `options.executor`). In `index.ts`: add `refresh: z.boolean().default(false)` to the `quotas.capacity` schema; thread the executor inside the handler closure (the `UTS_COMPUTING_TEST_MODE` seam); **change the annotation from `READ_LOCAL` to `READ_REMOTE`** (it can now contact the cluster). Update `mcp-protocol.test.mjs`'s `EXPECTED_TOOL_ANNOTATIONS` entry for `quotas.capacity` to the READ_REMOTE 3-field shape. (Tool count stays 46 — annotation change only, not a new tool.)
- [ ] **Step 4: Run full suite** — `npm test` green (tool-registration unchanged count; mcp-protocol annotation updated).
- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/ops/quotas/capacity.ts mcp-server/src/index.ts \
    mcp-server/tests/ops/capacity.test.mjs mcp-server/tests/integration/mcp-protocol.test.mjs
  git commit -m "feat(quotas): quotas.capacity opt-in refresh-and-report for stale snapshots (L16)"
  ```

---

### Task 5: Docs + final reconciliation
- [ ] **Final architecture-doc reconciliation:** the tool count is already 46, but the **test count** and **TS module count** in `docs/architecture-overview.md` trail reality (they say `432 tests · 57 TS modules` from Phase 3). Recompute the live numbers — `npm test` final count, and `find mcp-server/src -name '*.ts' | wc -l` — and update `architecture-overview.md:9` and the `:138` "X tests" reference to match. Also fix the deep-dive `defineTool` line anchors if stale.
- [ ] Add a "Phase 6 delivered" note to the spec (`docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md`): H9 runtime guard, L18, M12/L17, L16. Mark the internalization spec **complete** (all phases delivered).
- [ ] `npm test`; commit `docs(ihpc): document Phase 6 + reconcile architecture test/module counts (final)`.

---

## Phase 6 exit criteria
- [ ] `safeTool` throws (→ error envelope) on a result with an un-awaited Promise property; all 46 tools still pass (none legitimately do this); `access.doctor` audited.
- [ ] `jobs.history` rejects a non-ISO `since` with a clear error; valid ISO still works.
- [ ] `projectRoot` resolves via the `package.json` marker (with fallback); schema/example/profile resolution still works; no `<outside-project>` for legitimate in-project paths.
- [ ] `quotas.capacity refresh:true` refreshes then reports (mock-tested via the executor seam); default behavior unchanged; annotation is READ_REMOTE.
- [ ] Full suite green; tool count **46**; architecture-doc counts reconciled (tools/tests/modules all match reality); no real account ids/hosts (`git grep` clean).
