# iHPC Internalization — Phase 5 (Execute paths & fair-use) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** (§10) Hard-enforce each account's **own** caps — the real ban-prevention — and make multi-allocation campaigns **transparent and attributable** (not hidden); (M10) give failed sweeps a bounded, autonomy-respecting recovery path instead of O(failures) manual round-trips; (M11) align two legacy skills with the ADR-0004 autonomous model so they stop demanding a human token for autonomous submit/retry.

**Architecture:** A new `checkIhpcNodePoolConformance` extends the existing autonomy gate to **hard-block** any account that would exceed its **own** iHPC node-pool cap (PBS per-user caps are already enforced), called from `ihpc-start` before launch. A pure `ops/quotas/fairuse.ts` derives a **campaign ledger** over RunRecords (no second source of truth) — `campaign_id` is operator-declared (required on fan-out/sweep, optional on a single submit), `owner`/`allocation` are new non-credential attribution fields. Two read-only tools (`campaign.status`/`campaign.audit`) disclose the ledger and flag any over-cap account. M10 adds a minimal `sweep.retry.plan` **dry-run planner** (re-plans only the failed indices) — the agent's own loop is the orchestrator, not a new god-object.

**Tech Stack:** TypeScript (ES modules), Zod, `node --test`, the existing conformance gate / RunRecord / planner / sweep machinery. No new remote capability; the fair-use gate is local (caps come from `defaults.node_limits`, which are NOT SSH-queryable).

---

## ⚖️ Ethical frame (load-bearing — read first, do not deviate)

This phase is **enforcement + disclosure, NEVER detection-evasion.**
1. **A single account exceeding its OWN cap is ALWAYS hard-blocked** — its own iHPC node-pool cap (`defaults.node_limits`, +1 semantics) or PBS per-user cap — regardless of any campaign id, attestation, or owner. No exception path exists. Exceeding an account's own iHPC node limit is exactly what triggers a ban; this gate structurally prevents it.
2. **Cross-account use is policy-PERMITTED here** (two collaborators, one HPC + one iHPC each, no two same-platform accounts → the "multiply one platform's per-account cap" pattern structurally cannot exist). The fair-use code **MUST NEVER sum usage across accounts** to compute a cap — that would be both wrong and an evasion vector. Each account is checked against its own caps only.
3. **The campaign ledger + attestation exist to DISCLOSE** that a campaign legitimately spans different owners' allocations — for audit and attribution — **not to hide or circumvent** anything. `accountKey`/`buildCampaignLedger` record attribution; they are not a bypass.
4. If any step here could be read as enabling evasion, STOP and flag it. The ledger surfaces over-cap accounts; it never excuses them.

---

## Key design decisions
- **Tool count 43 → 46:** `campaign.status`, `campaign.audit` (5-touch each), `sweep.retry.plan` (5-touch). Each: handler, schema (reuse fields), `index.ts` TOOLS group, `tool-registration.test.mjs` (name + bump the `names.length, 4X` literal), `mcp-protocol.test.mjs` (inventory + 3-field annotation).
- **`campaign_id` is organizational metadata, NOT hashed into `plan_hash`** — treat it exactly like `project` (excluded from `planHashForPlan`). Add optional to `JobSpec` + `RunRecord`. `jobs.adopt` leaves it absent (external jobs have no declared campaign).
- **`owner`/`allocation` are attribution, NOT credentials** — optional `defaults.owner?`/`defaults.allocation?` strings; redaction must treat them as non-secret labels (like `account_label`), never as secrets, and they must never carry a real account id in committed example profiles.
- **M10 stays a planner.** `sweep.retry.plan` is dry-run only (mode `dry-run`, no SSH, no mutation of the source run); re-submission goes through the existing autonomous conformance-gated `jobs.submit`. Do NOT add auto-detect/auto-submit/orchestration (the layering audit explicitly rejected the god-object).
- Baseline suite is **443** on this branch. Commit per task; do not push (controller batches the push to PR #4).

---

## Chunk 1: Fair-use enforcement + campaign ledger

### Task 1: Hard per-account iHPC node-pool enforcement + attribution fields

**Files:**
- Modify: `mcp-server/src/ops/quotas/conformance.ts` (`checkIhpcNodePoolConformance` + a `node-pool-exceeded` violation), `mcp-server/src/ops/jobs/ihpc-start.ts` (gate before launch)
- Modify: `mcp-server/src/core/types.ts` (`ComputeProfile.defaults.owner?`/`allocation?`), `schemas/profile.schema.json` (REQUIRED — `defaults.additionalProperties:false`), `mcp-server/src/core/config.ts` (`redactProfile` surfaces them), `profiles/profiles.example.yaml` (placeholder values, **no real ids**)
- Test: `mcp-server/tests/ops/conformance.test.mjs` (+ `ihpc-start.test.mjs`, + a profile-validation/redaction test)

- [ ] **Step 1: Write the failing test** — an account whose iHPC pool is already at its cap is HARD-BLOCKED from starting another node in that pool:
  ```javascript
  test("checkIhpcNodePoolConformance hard-blocks a node-pool overflow (own-cap)", () => {
    // pool {families:["turing"], limit:2}, already 2 held -> starting a 3rd turing node violates
    const r = checkIhpcNodePoolConformance({ targetNode: "turing3", nodeLimits: [{ families: ["turing"], limit: 2 }], activeNodes: [{ node: "turing1", family: "turing" }, { node: "turing2", family: "turing" }] });
    assert.equal(r.conforms, false);
    assert.ok(r.violations.some((v) => v.code === "node-pool-exceeded"));
  });
  test("conforms when the pool has headroom", () => {
    const r = checkIhpcNodePoolConformance({ targetNode: "turing2", nodeLimits: [{ families: ["turing"], limit: 2 }], activeNodes: [{ node: "turing1", family: "turing" }] });
    assert.equal(r.conforms, true);
  });
  ```
  (Match the real `NodeLimitPool`/`activeNodes` shapes from `quota-limits.ts` — reuse `computeNodePoolOccupancy`/`inferNodeFamily`, don't reinvent pool math.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `checkIhpcNodePoolConformance`** in `conformance.ts` (pure): given the target node + the profile's `node_limits` + the current `activeNodes`, infer the target's pool (`inferNodeFamily`), compute that pool's occupancy (`computeNodePoolOccupancy`), and if `held + 1 > limit` → a `node-pool-exceeded` violation (`+1` semantics, mirroring `checkPbsConformance`'s `runningInQueue + 1 > maxRun`). Add `"node-pool-exceeded"` to the violation-code union. **Never sum across accounts** — this checks ONE profile's pool only.

- [ ] **Step 4: Gate `ihpc-start`.** In `ihpc-start.ts`, after `selectActiveComputeNode` picks the target node and before launching the supervisor, call `checkIhpcNodePoolConformance(...)` with the profile's `defaults.node_limits` + the snapshot's active nodes; if `!conforms`, throw with the violation (mirror `submit.ts`'s `checkPbsConformance` refusal). This is the iHPC analogue of the PBS gate — the real ban-prevention. (If `node_limits` is unset, there is no enforceable cap; document that the operator must set it from the portal "My Node Limits".)

- [ ] **Step 5: Add attribution fields.** `ComputeProfile.defaults`: add optional `owner?: string` and `allocation?: string` (non-credential labels).
  - `core/types.ts`: add the two optional fields to `ComputeProfile.defaults`.
  - **`schemas/profile.schema.json` (REQUIRED):** the `defaults` object has `additionalProperties:false` (`:54`) — add `owner` and `allocation` (both `{ "type": "string" }`) to `defaults.properties` (`:34-53`), or `validateProfiles`/`assertProfile` will **reject** any profile carrying them. Add a test that an `owner`/`allocation`-bearing profile passes `validateProfiles`.
  - `profiles/profiles.example.yaml`: show the fields with **placeholder** values (e.g. `owner: owner-a`, `allocation: alloc-a`) — never a real id.
  - **`redactProfile` (`core/config.ts:199-205`) is a whitelist** that silently drops unlisted fields. Since the ledger's purpose is *disclosure/attribution*, **surface** `owner`/`allocation` by adding them to the redacted `defaults` object (they are non-secret labels, like `account_label`). Add a test asserting `redactProfile` includes them.

- [ ] **Step 6: Run full suite** — `npm test`. Add an `ihpc-start.test.mjs` case proving a start is refused when the pool is at cap. Tool count unchanged (no new tool).

- [ ] **Step 7: Commit**
  ```bash
  git add mcp-server/src/ops/quotas/conformance.ts mcp-server/src/ops/jobs/ihpc-start.ts mcp-server/src/core/types.ts \
    schemas/profile.schema.json mcp-server/src/core/config.ts profiles/profiles.example.yaml \
    mcp-server/tests/ops/conformance.test.mjs mcp-server/tests/ops/ihpc-start.test.mjs mcp-server/tests/core/profile-account.test.mjs
  git commit -m "feat(fairuse): hard-block iHPC node-pool overflow per-account + owner/allocation attribution (§10)"
  ```

---

### Task 2: `fairuse.ts` primitives + `campaign_id` plumbing

**Files:**
- Create: `mcp-server/src/ops/quotas/fairuse.ts` (`accountKey`, `buildCampaignLedger`, `fairUseVerdict`)
- Modify: `mcp-server/src/core/types.ts` (`RunRecord.campaign_id?` — NOT JobSpec), `mcp-server/src/core/audit.ts` (`RunRecordMetadata.campaignId?` + spread into the record), `schemas/run-record.schema.json` (optional `campaign_id`), `mcp-server/src/ops/plans/planner.ts` (accept a `campaignId` arg → metadata; no plan_hash change), `mcp-server/src/ops/jobs/sweep.ts` (require `campaignId` arg), `mcp-server/src/index.ts` (`jobs.plan` optional / `sweep.plan` required `campaignId` input), `mcp-server/src/ops/jobs/adopt.ts` (absent by construction — likely no change)
- Test: `mcp-server/tests/ops/fairuse.test.mjs` (+ sweep/planner tests)

- [ ] **Step 1: Write the failing tests** for the pure primitives + the sweep requirement:
  ```javascript
  test("sweep.plan requires an explicit campaignId (fan-out must declare identity)", () => {
    // campaignId is a planSweep ARGUMENT (not a JobSpec field); omitting it throws.
    assert.throws(() => planSweep({ jobSpec, parameters /* , campaignId omitted */ }), /campaign/i);
  });
  test("buildCampaignLedger groups runs by campaign into per-owner allocations (derived, no second source)", () => {
    const runs = [ /* RunRecords with campaign_id + profile_id */ ];
    const ledger = buildCampaignLedger(runs, profilesById);
    // one campaign -> allocations keyed by account, each with owner/allocation/run_count
  });
  test("fairUseVerdict flags an account over its OWN cap and NEVER sums across accounts", () => {
    // two accounts each under their own cap but summing would exceed -> NO violation (cross-account not summed)
    // one account over its own pbs/ihpc cap -> violation for THAT account only
  });
  ```

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.** **`campaign_id` must live ONLY on the `RunRecord` (via metadata), NEVER on `JobSpec`** — verified: `project` is not a `JobSpec` field; it is threaded into `buildRunRecord` metadata (`planner.ts:89-90`), and `buildPlanHash` hashes the *entire* `normalized_job_spec` wholesale with NO field exclusion (`planner.ts:138-148`, `lib/shared.ts` canonicalize only drops `undefined`). Putting `campaign_id` on `JobSpec` would (a) hash it into `plan_hash` and (b) be rejected by `job-spec.schema.json`'s `additionalProperties:false`. So:
  - `core/types.ts`: add optional `campaign_id?: string` to **`RunRecord`** (after `project_hash`) and to **`RunRecordMetadata`** (`audit.ts:24`). Do **NOT** add it to `JobSpec`. `schemas/run-record.schema.json`: add optional `campaign_id` string.
  - `planner.ts`: accept an optional `campaignId` **planner argument** (threaded from the `jobs.plan`/`sweep.plan` tool input, exactly parallel to how `project`/`projectHash` reach `buildRunRecord` metadata). It lands on the RunRecord only — never on the hashed spec; no `planHashForPlan` change needed (and none wanted).
  - `index.ts`: the `jobs.plan` tool input gains optional `campaignId`; the `sweep.plan` tool input gains `campaignId` (required, enforced in `planSweep`).
  - `sweep.ts` `planSweep`: take a `campaignId` argument and at entry `if (!campaignId) throw new Error("sweep.plan requires an explicit campaignId — the fan-out operator must declare campaign identity (accounts-and-safety.md forbids inferring it)")`.
  - `adopt.ts`: `campaign_id` stays absent on adopted records (`pbsRowToRunRecord`/`ihpcPidToRunRecord` hand-build records; absent by construction — no change).
  - `fairuse.ts`:
    - `accountKey(profile) => `${profile.account_label}@${profile.platform}`` (per-account, per-platform key).
    - `buildCampaignLedger(runs, profilesById) => CampaignLedgerEntry[]` — group runs by `campaign_id`, then by account; per account record `{ account_key, profile_id, account_label, owner?, allocation?, platform, run_ids, run_count, status_breakdown, last_updated }`. **Pure derivation over the runs — no second store.**
    - `fairUseVerdict(profile, occupancyOrCounts) => Violation[]` — re-uses the per-account cap check (PBS per-user via `effectiveUserLimit`, iHPC via `computeNodePoolOccupancy`); returns violations for an account over its OWN cap. **Never aggregates across accounts.**

- [ ] **Step 4: Run full suite** — `npm test` (assertRunRecord via the planner/adopt tests proves the schema sync). Tool count unchanged.

- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/ops/quotas/fairuse.ts mcp-server/src/core/types.ts schemas/run-record.schema.json \
    mcp-server/src/ops/plans/planner.ts mcp-server/src/ops/jobs/sweep.ts mcp-server/src/ops/jobs/adopt.ts \
    mcp-server/tests/ops/fairuse.test.mjs mcp-server/tests/ops/sweep.test.mjs
  git commit -m "feat(fairuse): campaign_id plumbing + derived campaign-ledger/verdict primitives (§10)"
  ```

---

### Task 3: `campaign.status` + `campaign.audit` tools

Two read-only tools mirroring `projects.list` (derived rollup over RunRecords). `campaign.status` shows a campaign's allocations per owner; `campaign.audit` additionally **flags any account over its own cap** (composes `fairUseVerdict` against the latest per-profile quota snapshots) and surfaces the optional fair-use attestation.

**Files:**
- Create: `mcp-server/src/ops/quotas/campaign.ts` (`campaignStatus`, `campaignAudit`) — or add to `fairuse.ts`
- Modify: `mcp-server/src/index.ts` (register both), `mcp-server/tests/integration/tool-registration.test.mjs` + `mcp-protocol.test.mjs` (5-touch ×2, 43→45)
- Test: `mcp-server/tests/ops/campaign.test.mjs`

- [ ] **Step 1: Write failing tests** — seed RunRecords (some with `campaign_id`, across two profiles/owners) + per-profile quota snapshots in a temp runtime dir; assert `campaignStatus({ campaignId })` returns the per-owner allocations, and `campaignAudit({ campaignId })` flags an account that's over its own cap. (Mirror `projects.test.mjs` / `jobs-history.test.mjs` seeding.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement** `campaignStatus`/`campaignAudit` (read-only, local): enumerate run records (`listRunRecordIds` + `readRunRecordSafe`), filter by `campaign_id`, build the ledger via `buildCampaignLedger`, and for `audit` compose `fairUseVerdict` against each account's latest quota snapshot. Return `{ campaign: { campaign_id, allocations, ...(audit ? { findings } : {}) } }`. Surface the optional attestation (an operator-supplied `fair_use_basis` note, if recorded on the campaign's runs — keep it on the records, no second store).

- [ ] **Step 4: Register both tools** (`READ_LOCAL`). 5-touch ×2: TOOLS group; `tool-registration.test` add both names + bump count 43→**45**; `mcp-protocol.test` add both to the inventory + `EXPECTED_TOOL_ANNOTATIONS` (3-field `{readOnlyHint:true,destructiveHint:false,openWorldHint:false}`).

- [ ] **Step 5: Run targeted + full** — `npm test`. Tool count 45.

- [ ] **Step 6: Commit**
  ```bash
  git add mcp-server/src/ops/quotas/campaign.ts mcp-server/src/index.ts \
    mcp-server/tests/ops/campaign.test.mjs mcp-server/tests/integration/tool-registration.test.mjs mcp-server/tests/integration/mcp-protocol.test.mjs
  git commit -m "feat(fairuse): campaign.status + campaign.audit (disclose allocations, flag over-cap accounts) (§10)"
  ```

---

## Chunk 2: Execute path (M10) + skill cleanup (M11) + docs

### Task 4: M10 — `sweep.retry.plan` (dry-run re-planner)

A minimal, autonomy-respecting recovery: re-plan ONLY the failed array indices into a new, smaller array job (new run_id, new plan_hash, lineage), so the agent re-submits a compacted retry through the **existing autonomous conformance-gated** `jobs.submit` — turning O(failures) manual round-trips into one re-plan. **Planner only — no SSH, no source mutation, no orchestration.**

**Files:**
- Create: `mcp-server/src/ops/jobs/retry-sweep.ts` (`planRetrySweep`)
- Modify: `mcp-server/src/core/types.ts` (`SweepRetryLineage` + `sweep_retry_of?` on `PlannedJob`/`RunRecord`), `schemas/run-record.schema.json` (optional `sweep_retry_of`), `mcp-server/src/ops/plans/planner.ts` (thread `sweep_retry_of` through `PlanHashLineage`/`buildPlanHash`/`planHashForPlan`), `mcp-server/src/index.ts` (register `sweep.retry.plan`), the two integration tests (5-touch, 45→46)
- Test: `mcp-server/tests/ops/retry-sweep.test.mjs`

- [ ] **Step 1: Write failing tests:** accepts only a finished **sweep** source run; validates `failedIndices` are within the original array bounds; **compacts** indices (original `[5,7,8,9]` → new `[0..3]`) and returns an `index_map` (`{5:0,7:1,8:2,9:3}`); builds a new array plan of cardinality `failedIndices.length` with `sweep_retry_of` lineage; output `mode:"dry-run"` with warnings (no remote write).

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement `planRetrySweep`** mirroring `sweep.ts`/`retry.ts`. **The index→params table is NOT persisted** in the saved plan (only `resources.array{start,end}` + the params embedded in the generated `case` block; the `sweep.table` is returned only in the tool response). So `planRetrySweep` takes the **original `parameters` grid + `failedIndices`** as inputs (re-run `expandGrid` and re-select — exactly as `sweep.rank` already requires the original `parameters`, `sweep.ts:167-176`); it reads+verifies the source sweep run only for lineage/escalation context. Compact the failed indices into a new `[0..n-1]` array and return an `index_map` (`{orig:new}`).
  - **New hash-bound lineage (required):** `RetryLineage` lacks `failed_indices`/`index_map`, and `planHashForPlan` only commits `approval_operation` + `retry_of` (`planner.ts:137-159`) — a `sweep_retry_of` field would be silently EXCLUDED from the hash. Add a new `SweepRetryLineage` type to `core/types.ts` + a `sweep_retry_of?` field to `PlannedJob`/`RunRecord`, and thread it through `PlanHashLineage`/`buildPlanHash`/`planHashForPlan` so the lineage is hash-bound (the way `retry_of` binds). This is what makes Step 5's "new, independent plan_hash" true.
  - `approval_operation` aligned to the autonomous model (conformance gates re-submission; no token). Return `{ retry_sweep: { mode:"dry-run", source_run_id, failed_indices_count, planned_sweep_size, index_map, plan, warnings } }`. Keep lineage to **one level per call** (require explicit `sourceRunId`; do not infer). `planRetrySweep` is **synchronous** (pure planner — no await-in-safeTool footgun).

- [ ] **Step 4: Register `sweep.retry.plan`** (annotation `ANNOTATIONS_DRY_RUN` or whatever `sweep.plan`/`jobs.retry.plan` use). 5-touch (count 45→**46**).

- [ ] **Step 5: Run targeted + full** — `npm test`. Confirm the re-planned sweep is independent (new plan_hash) and that re-submission still passes live conformance (the existing submit path is unchanged — note this; do not weaken conformance).

- [ ] **Step 6: Commit**
  ```bash
  git add mcp-server/src/ops/jobs/retry-sweep.ts mcp-server/src/core/types.ts schemas/run-record.schema.json \
    mcp-server/src/ops/plans/planner.ts mcp-server/src/index.ts \
    mcp-server/tests/ops/retry-sweep.test.mjs mcp-server/tests/integration/tool-registration.test.mjs mcp-server/tests/integration/mcp-protocol.test.mjs
  git commit -m "feat(jobs): add sweep.retry.plan dry-run re-planner for failed array members (M10)"
  ```

> **Scope guard:** if you find yourself adding auto-detect-failures, auto-submit, or a multi-run orchestrator, STOP — that's the god-object the layering audit rejected. The agent's own loop (jobs.track → sweep.retry.plan → jobs.submit) is the orchestrator.

---

### Task 5: M11 — align legacy skills with ADR-0004 (docs-only)

**Files:**
- Modify: `skills/hpc-submit-pbs/SKILL.md`, `skills/ihpc-run-background/SKILL.md`, `skills/triage-and-retry/SKILL.md` (confirm the real dir names via `ls skills/`)

- [ ] **Step 1:** Read both legacy SKILL.md files + one well-formed skill (e.g. `run-experiment`) for the house style. Identify the lines that (a) mandate `approvalId` for autonomous `jobs.submit`/`jobs.retry`, (b) falsely gate `transfers.execute`/`artifacts.fetch` on approval, (c) would hit the now-wired token.
- [ ] **Step 2:** Edit so they teach the ADR-0004 model: submit/retry/transfer/fetch are **autonomous** (pass a fresh `quota_snapshot_id`; conformance is the gate); `approvalId` is **optional** for those and **required only** for irreversible ops (`jobs.cancel`, `artifacts.cleanup.execute`, `state.migrate.apply`). Confirmed targets: `hpc-submit-pbs/SKILL.md:24` and `ihpc-run-background/SKILL.md:26` both mandate `approvalId` for autonomous submit (the modern `run-experiment/SKILL.md:15-16` is the correct template). Add a one-line pointer to `docs/adr/0004-quota-envelope-autonomy.md`. Add a note: for external (non-plugin-created) jobs, use `jobs.adopt` first, then `jobs.cancel` with the approval token. **Also fix `triage-and-retry/SKILL.md:21`** — it routes `jobs.retry` through the full `approvals.request`/`decide` human gate, the same ADR-0004 drift; align it too (a third, same-defect skill the recon surfaced). **Docs-only — no behavior change. Packaging is safe: `validate-plugin-package.mjs` checks only SKILL.md frontmatter, not bodies.**
- [ ] **Step 3:** `npm test` (skills may be checked by a packaging/smoke test — confirm green). Commit `docs(skills): align hpc-submit-pbs + ihpc-run-background with ADR-0004 autonomy (M11)`.

---

### Task 6: Docs + spec tick
- [ ] Update `README.md`/`mcp-server/README.md`: tool count 43 → **46**; add `campaign.status`, `campaign.audit`, `sweep.retry.plan`; document the per-account hard cap (incl. the new iHPC node-pool gate) and the campaign ledger's **disclosure** purpose.
- [ ] Update the architecture docs tool count 43 → **46** (`architecture.md:112`, `architecture-overview.md`, `architecture-deep-dive.md` "X 个点号工具" + the grep-vs-registered reasoning [`grep defineTool(` now matches 46], `architecture-layers.svg`) + add the 3 new tools to `architecture.md`'s tool table. **Leave the deep-dive's PLATFORM-branch count `约 NN 处分支` untouched** — that's a different number, not a tool count.
- [ ] Add a "Phase 5 delivered" note to the spec (the per-account-hard-cap + ledger-for-disclosure framing; M10 planner-not-orchestrator; M11).
- [ ] `npm test`; commit `docs(ihpc): document Phase 5 (fair-use enforcement + ledger, sweep.retry.plan, skill cleanup)`.

---

## Phase 5 exit criteria
- [ ] **Hard per-account enforcement:** an account at its own iHPC node-pool cap is BLOCKED from starting another node in that pool (mirrors the existing PBS per-user block); the gate **never sums across accounts**; tests prove both.
- [ ] **Campaign ledger discloses, doesn't hide:** `campaign_id` (required on sweep, optional single), `owner`/`allocation` attribution, `campaign.status`/`campaign.audit` surface per-owner allocations and flag over-cap accounts.
- [ ] **M10:** `sweep.retry.plan` re-plans only failed indices as a dry-run (no SSH, no source mutation, no auto-submit); re-submission still passes live conformance.
- [ ] **M11:** the two legacy skills teach the autonomous model; no skill mandates a token for autonomous submit/retry.
- [ ] Tool count **46**; full suite green; **no real account ids/owners/hosts** in any committed file (`git grep` clean — owner/allocation examples use placeholders).

## Deliberate non-goals
- **No cross-account quota aggregation** (would be wrong + an evasion vector). Each account checked against its own caps only.
- **No detection-evasion.** The ledger surfaces over-cap accounts; it never excuses them. No code hides multi-allocation use.
- **No orchestrator/god-object** for M10 — `sweep.retry.plan` is a planner; the agent loop orchestrates.
