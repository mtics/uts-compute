# iHPC Internalization — Phase 4 (iHPC supervision & sweep correctness) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make iHPC use correct and observable: hard-stop the single-process `ihpc-start` from being misused for multi-GPU/fan-out work and steer it to the scheduler (H6/H7); surface scheduler-reported GPU placement so iHPC runs are no longer usage-blind (H8); and pre-flight a campaign's queue YAML before launch so a `MovieLens`≠`ML` dataset typo or a malformed `param_overrides` is caught locally, not on the cluster (P9).

**Architecture:** A small guard in `ihpc-start.ts` rejects array/multi-GPU specs with a message pointing to `ihpc.scheduler.deploy` + on-node `ihpc-sched`. A new optional `RunRecord.placement` field carries scheduler-reported placement (gpu_index/hostname/node), populated through the adopt path; adopted iHPC runs stay **history-only** (no synthetic supervisor — that would bypass the profile-root security boundary). A new pure `validateQueueContract` primitive + `ihpc.campaign.preflight` tool validate the queue YAML structure, local dataset existence, and `param_overrides` shape.

**Tech Stack:** TypeScript (ES modules), Zod, `node --test`, the existing `safeTool`/`defineTool`/RunRecord/JobSpec machinery, YAML parsing via the repo's `yaml` dep. No remote calls in the new code paths (preflight is local; placement is carried, not probed).

---

## Key design decisions (read first)
1. **Adopted iHPC stays history-only (deliberate non-goal).** The Phase-1 deferral of "full adopted-iHPC reconciliation" resolves as: do NOT synthesize a supervisor block. `requireIhpcSupervisor` (jobs.ts:~1022) demands `metadata_path`/`stdout_path`/`stderr_path` **inside the profile roots**; an externally-started process doesn't expose them, and guessing them bypasses a hard security boundary. So `jobs.status`/`logs`/`cancel` keep rejecting adopted iHPC with the clear "missing supervisor metadata" error. We add **observability** (placement), not reconciliation.
2. **The plugin reads what the scheduler reports; it never probes GPUs.** `placement` is carried into the record (operator/scheduler-supplied via adopt); a live `ihpc-sched status --json` poll is a future enhancement, noted but out of this phase.
3. **Preflight is pure + local.** `validateQueueContract` does NO SSH. Dataset existence is checked against a caller-supplied `datasetDirs` list (case-sensitive — `MovieLens` ≠ `ML`). A *remote* `test -d` probe is explicitly a later candidate, not P9.
4. **P9 introduces a new finding shape — there is nothing to mirror (verified).** The repo's validators return `ValidationResult { valid: boolean; errors: string[] }` (+ `warnings: string[]`); there is NO `Finding`/`{level,path,message}` type anywhere in `mcp-server/src`. P9 needs structured multi-finding output, so **declare a new shape explicitly**: `interface QueueFinding { level: "error" | "warning"; path: string; message: string; suggestion?: string }` and have `validateQueueContract` return `QueueFinding[]`. (`validateProfiles` actually lives in `core/config.ts:105`, not `ops/profiles/`.)
5. **Conventions:** baseline suite is **432** on this branch; tool count **42**. P9 adds the 43rd tool → the **5-touch** change (handler, schema, `index.ts` TOOLS group, `tool-registration.test.mjs` name+count 42→43, `mcp-protocol.test.mjs` inventory+annotation). H6/H7 and H8 add NO tool. Adding `RunRecord.placement` touches `schemas/run-record.schema.json` (a `schema-defs-sync` test may pin it) and `core/types.ts`. Commit per task; do not push (the controller batches the push to PR #4).

---

### Task 1: H6/H7 — `ihpc-start` hard-stop guard

**Files:**
- Modify: `mcp-server/src/ops/jobs/ihpc-start.ts` (add the guard + call it)
- Test: `mcp-server/tests/ops/ihpc-start.test.mjs`

- [ ] **Step 1: Write the failing tests.** Confirm where `array`/`ngpus` live on the normalized spec (recon: `plan.normalized_job_spec.resources`; verify the JobSpec resources shape in `core/types.ts`). Tests:
  ```javascript
  test("ihpc-start hard-stops a multi-GPU spec and points to the scheduler", async () => {
    // build/seed a plan with resources.ngpus = 2, then call startIhpcRun
    await assert.rejects(() => startIhpcRun(/* plan/runId */, { /* options, mock executor */ }),
      /scheduler|ihpc\.scheduler\.deploy|ihpc-sched/i);
  });
  test("ihpc-start hard-stops an array/sweep spec", async () => {
    // resources.array present
    await assert.rejects(() => startIhpcRun(/* ... */), /scheduler/i);
  });
  test("ihpc-start allows a legitimate single-process run (ngpus=1, no array)", async () => {
    // resources = { ngpus: 1, node_family: ... } -> no throw from the guard (mock the rest)
  });
  ```
  Use the existing `ihpc-start.test.mjs` harness for how a plan/run is seeded and how the executor is mocked.

- [ ] **Step 2: Run — FAIL** (no guard yet; multi-GPU silently runs once).

- [ ] **Step 3: Implement the guard** in `ihpc-start.ts`:
  ```typescript
  // H6/H7: ihpc-start runs ONE process on ONE node. Multi-GPU / array / fan-out belongs to the
  // on-node scheduler, not here — silently running a multi-GPU command once would waste the campaign.
  function assertIhpcSingleProcessResources(plan: PlannedJob): void {
    const r = plan.normalized_job_spec.resources ?? {};
    if (r.array) {
      throw new Error(
        "ihpc-start runs a single process on one node and does not support array/sweep jobs. " +
        "For multi-GPU or fan-out workloads, deploy the iHPC scheduler (ihpc.scheduler.deploy) and run `ihpc-sched start`."
      );
    }
    if (typeof r.ngpus === "number" && r.ngpus > 1) {
      throw new Error(
        "ihpc-start is single-GPU (one process, one node); ngpus>1 would not fan out. " +
        "Use the iHPC scheduler: deploy via ihpc.scheduler.deploy, then `ihpc-sched start`."
      );
    }
  }
  ```
  `startIhpcRun(input: { runId; … }, options)` takes a **runId** and loads the plan via `readVerifiedPlan(input.runId, …)` (ihpc-start.ts:76). Call the guard **after the `plan.platform !== PLATFORM.IHPC` check (~ihpc-start.ts:79), before `readRunRecord` (~line 80)** — the plan (with `resources`) exists by then, and we fail eagerly before any I/O. (The guard takes the loaded `plan`, not a passed-in plan object; tests seed a plan with `resources.ngpus=2`/`resources.array` via the `ihpc-start.test.mjs` harness and call `startIhpcRun({ runId })`.)

- [ ] **Step 4: Run targeted + full** — `npm test`. Confirm the guard fires for array/ngpus>1 and the happy path is unaffected. Tool count still 42.

- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/ops/jobs/ihpc-start.ts mcp-server/tests/ops/ihpc-start.test.mjs
  git commit -m "feat(ihpc): hard-stop ihpc-start on multi-GPU/array; steer to the scheduler (H6/H7)"
  ```

---

### Task 2: H8 — `RunRecord.placement` + adopt-carried GPU visibility

Add an optional, platform-agnostic `placement` field to the run record and carry scheduler-reported iHPC placement through the adopt path, so iHPC runs report *where they are* (node + GPU). Adopted iHPC stays history-only for reconciliation (per decision 1).

**Files:**
- Modify: `mcp-server/src/core/types.ts` (`RunRecord.placement?`), `schemas/run-record.schema.json` (the optional `placement` object)
- Modify: `mcp-server/src/ops/jobs/adopt.ts` (`ihpcPidToRunRecord` + `adoptExternalRun` accept optional placement), `mcp-server/src/index.ts` (the `jobs.adopt` input schema gains optional placement fields)
- Modify (surface): `mcp-server/src/ops/jobs/history.ts` and/or `jobs.ts` status result to include `placement` when present
- Test: `mcp-server/tests/ops/adopt-primitives.test.mjs` (+ `jobs-adopt.test.mjs`, `jobs-history.test.mjs`)

- [ ] **Step 1: Write the failing tests** — `ihpcPidToRunRecord` with placement stores it; `jobs.adopt` accepts `{ gpuIndex, hostname }` and persists `placement`; `jobs.history` surfaces it:
  ```javascript
  test("ihpcPidToRunRecord carries scheduler-reported placement", () => {
    const rec = ihpcPidToRunRecord({ runId: "adopt-venus01-31245", profileId: "uts-ihpc-account-a",
      node: "venus01", pid: 31245, now, placement: { gpu_index: 1, hostname: "venus01" } });
    assert.deepEqual(rec.placement, { gpu_index: 1, hostname: "venus01", node_id: "venus01" });
  });
  ```
  (Choose the exact `placement` shape and stick to it across types/schema/adopt.)

- [ ] **Step 2: Run — FAIL.**

- [ ] **Step 3: Implement.**
  - `core/types.ts`: add to `RunRecord`:
    ```typescript
    // Scheduler-reported placement (iHPC): where the run is, for observability. PBS leaves this null
    // (its accounting is in `usage`). The plugin carries what the scheduler reports; it never probes GPUs.
    placement?: {
      hostname: string;
      node_id?: string;
      gpu_index?: number;
      slots_per_gpu?: number;
      started_at?: string;
      placement_hash?: string;
    };
    ```
  - `schemas/run-record.schema.json`: add the matching optional `placement` object with `additionalProperties:false`, `required:["hostname"]`, and **exactly** the keys `hostname`/`node_id`/`gpu_index`/`slots_per_gpu`/`started_at`/`placement_hash` (so type↔schema can't drift). **The sync is enforced by `assertRunRecord` (Ajv, `validation.ts`), NOT by `schema-defs-sync.test.mjs`** (that test only pins `retry_lineage`/`job_spec`). So the real proof is the adopt/history `node --test` runs calling `assertRunRecord` — if the schema lacks `placement` while the record carries it, those FAIL. `core/types.ts` and the schema **must change in the same commit**. Keep `ihpcPidToRunRecord` from injecting default `started_at`/`placement_hash` so the Step-1 `deepEqual(rec.placement, { gpu_index, hostname, node_id })` holds for that input.
  - `ops/jobs/adopt.ts`: extend `IhpcAdoptContext` and `ihpcPidToRunRecord` to accept an optional `placement` and spread it into the record (default `node_id` to `node` when absent). Extend `AdoptInput`/`adoptExternalRun` to accept optional `gpuIndex`/`hostname`/`slotsPerGpu` and build the placement object for the iHPC path.
  - `index.ts`: add optional `placement` inputs to the `jobs.adopt` schema (e.g. `gpuIndex: z.number().int().optional()`, `hostname: z.string().optional()`) **and thread them through the handler** — the `jobs.adopt` handler (index.ts:~621) destructures a fixed arg list (`node`/`pid` already there at :616-617), so add `gpuIndex, hostname` to the destructure and pass them into `adoptExternalRun`.
  - Surface: include `placement` in `jobs.history` per-run summary (when present) and in the `jobs.status` result. PBS records have no `placement` (null/absent).

- [ ] **Step 4: Run full suite** — `npm test`; confirm `schema-defs-sync`, adopt, history all green. Confirm adopted iHPC `jobs.status` still rejects with the supervisor error (decision 1 — add/keep a test asserting `/supervisor/`).

- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/core/types.ts schemas/run-record.schema.json mcp-server/src/ops/jobs/adopt.ts \
    mcp-server/src/index.ts mcp-server/src/ops/jobs/history.ts \
    mcp-server/tests/ops/adopt-primitives.test.mjs mcp-server/tests/ops/jobs-adopt.test.mjs mcp-server/tests/ops/jobs-history.test.mjs
  git commit -m "feat(ihpc): carry scheduler-reported placement on adopted iHPC runs (H8 observability)"
  ```

> **Note (documented limitation):** adopted iHPC runs are discoverable + carry placement, but reconciliation (status/logs/cancel) still requires supervisor metadata, available only for runs started via `jobs.submit`/`jobs.retry`. A live `ihpc-sched status --json` poll to refresh placement is a future enhancement.

---

### Task 3: P9 — `ihpc.campaign.preflight` (validate queue YAML before launch)

**Files:**
- Create: `mcp-server/src/ops/jobs/ihpc-preflight.ts` (`validateQueueContract` + `QueueFinding`)
- Modify: `mcp-server/src/index.ts` (register `ihpc.campaign.preflight`). **No `schemas.ts` change** — `jsonObjectField()` already exists at `mcp/schemas.ts:76` (`z.record(z.string(), z.unknown())`); reuse it for `queueYaml`/`parameterSpace`.
- Modify: `mcp-server/tests/integration/tool-registration.test.mjs` + `mcp-server/tests/integration/mcp-protocol.test.mjs` (5-touch, 42→43)
- Test: `mcp-server/tests/ops/preflight.test.mjs`

- [ ] **Step 1: Write the failing pure-primitive tests** (`preflight.test.mjs`). The queue YAML contract (recon, uts-ihpc `config.py:292-475` + real `configs/*.yaml`): top-level `my_nodes` (≥1) and `experiments` (≥1, each `{ name, command, requires_gpu }`), plus a `scheduler` section. **The dataset is a `--dataset <name>` CLI flag in `experiment.command`, NOT a key in `param_overrides`** (verified across 336 real blocks — `param_overrides` carries hyperparameters only, e.g. `learning_rate`/`T_steps`). `param_overrides` is JSON embedded as `--param_overrides '{...}'`. Findings are the new `QueueFinding` shape `{ level, path, message }`. Cover:
  ```javascript
  import { validateQueueContract } from "../../dist/ops/jobs/ihpc-preflight.js";
  const goodYaml = { my_nodes: [{ hostname: "venus01", gpu_count: 2 }],
    experiments: [{ name: "e1", command: "python train.py --dataset MovieLens --param_overrides '{\"learning_rate\":0.01}'", requires_gpu: true }] };

  test("valid queue YAML + present dataset -> no errors", () => {
    const f = validateQueueContract(goodYaml, ["MovieLens", "Cards"]);
    assert.equal(f.filter((x) => x.level === "error").length, 0);
  });
  test("missing my_nodes / empty experiments -> structural errors", () => {
    assert.ok(validateQueueContract({ experiments: [] }).some((x) => x.level === "error"));
  });
  test("dataset typo (--dataset MovieLens) vs available ['ML'] is flagged (case-sensitive)", () => {
    const f = validateQueueContract(goodYaml, ["ML", "Cards"]); // MovieLens not present, ML != MovieLens
    assert.ok(f.some((x) => /dataset|MovieLens/.test(x.message)));
  });
  test("malformed param_overrides JSON -> error", () => {
    const bad = { my_nodes: [{ hostname: "v" }], experiments: [{ name: "e", command: "python x --param_overrides '{not json}'", requires_gpu: false }] };
    assert.ok(validateQueueContract(bad).some((x) => /param_overrides|json/i.test(x.message)));
  });
  test("param_overrides validated against an optional parameter_space", () => {
    const space = { type: "object", properties: { learning_rate: { type: "number" } }, additionalProperties: false };
    assert.equal(validateQueueContract(goodYaml, ["MovieLens"], space).filter((x) => x.level === "error").length, 0);
  });
  ```
  > When `datasetDirs` is omitted, skip the dataset check entirely (no findings about datasets).

- [ ] **Step 2: Run — FAIL** (module missing).

- [ ] **Step 3: Implement `validateQueueContract`** (pure, no SSH) returning the new `QueueFinding[]` shape (declared in decision 4). Logic:
  1. **Structure:** `my_nodes` is a non-empty array; `experiments` is a non-empty array; each experiment has string `name`, string `command`, boolean `requires_gpu`. Emit `level:"error"` findings (with `path` like `experiments[0].command`) for violations.
  2. **Dataset existence (local, only when `datasetDirs` supplied):** for each experiment, extract the dataset from the **`--dataset <token>` CLI flag** in `command` (regex `/--dataset\s+(\S+)/`), NOT from `param_overrides`. Check the captured name is in `datasetDirs` with an **exact, case-sensitive** match; if not → `error` (this is the `MovieLens` ≠ `ML` catch). When `datasetDirs` is omitted, skip this check.
  3. **param_overrides shape:** extract `--param_overrides '...'` robustly — locate the literal `--param_overrides '`, then take the substring up to the **next single-quote** (the JSON uses double quotes internally, so `'` is the unambiguous terminator; do NOT use a single greedy/non-greedy `{...}` regex — real values nest objects/arrays like `"topk":[50]` and `"multimodal_ablation":{...}`). `JSON.parse` the slice: if it throws → `error`; if `paramSpace` is supplied → Ajv-validate the parsed object against it (reuse the `Ajv2020` instance pattern from `core/validation.ts:27-30`) and emit `error`/`warning` findings.
  Return `QueueFinding[]`.

- [ ] **Step 4: Register `ihpc.campaign.preflight`** in `index.ts`: `annotations: READ_LOCAL` (the source const is 4-field incl. `idempotentHint:true` — use the const, don't hand-write it); input `strictInput({ queueYaml: jsonObjectField(), datasetDirs: z.array(z.string()).optional(), parameterSpace: jsonObjectField().optional() })`; handler calls `validateQueueContract` and returns `{ preflight: { valid: <no error-level findings>, findings } }`. Apply the **5-touch**: TOOLS group; `tool-registration.test.mjs` — add the name to `EXPECTED_TOOL_NAMES` AND bump the literal `names.length, 42` → `43` (line ~95); `mcp-protocol.test.mjs` — add to the sorted inventory AND add an `EXPECTED_TOOL_ANNOTATIONS` entry in the **3-field** test shape `{ readOnlyHint:true, destructiveHint:false, openWorldHint:false }` (the protocol test derives its count from the table, so no separate count literal there).

- [ ] **Step 5: Run targeted + full** — `npm run build && node --test mcp-server/tests/ops/preflight.test.mjs && npm test`. Tool count now 43 (both integration tests green).

- [ ] **Step 6: Commit**
  ```bash
  git add mcp-server/src/ops/jobs/ihpc-preflight.ts mcp-server/src/index.ts \
    mcp-server/tests/ops/preflight.test.mjs mcp-server/tests/integration/tool-registration.test.mjs mcp-server/tests/integration/mcp-protocol.test.mjs
  git commit -m "feat(ihpc): add ihpc.campaign.preflight queue-YAML validation (P9)"
  ```

---

### Task 4: Docs + spec tick
- [ ] Update `README.md` / `mcp-server/README.md`: tool count 42 → **43**; add `ihpc.campaign.preflight`; note the `ihpc-start` multi-GPU guard and the new `placement` observability; document that adopted iHPC is history-only by design.
- [ ] Add a "Phase 4 delivered" note to `docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md` (H6/H7, H8, P9; record the adopted-iHPC "history-only + observability, no synthetic supervisor" decision).
- [ ] Update the architecture-doc tool count if you bump it here (43) — OR leave the architecture docs for a single end-of-phases sync (note which).
- [ ] `npm test`; commit `docs(ihpc): document Phase 4 (ihpc-start guard, placement, preflight)`.

---

## Phase 4 exit criteria
- [ ] `ihpc-start` rejects `array`/`ngpus>1` with a scheduler-pointer message; single-process runs unaffected.
- [ ] `RunRecord.placement` exists (schema + type, schema-defs-sync green); adopted iHPC runs carry scheduler-reported placement and surface it in `jobs.history`/`jobs.status`; adopted iHPC reconciliation still rejects with the supervisor error (history-only preserved).
- [ ] `ihpc.campaign.preflight` (tool count **43**) validates queue YAML structure + local dataset existence (case-sensitive) + `param_overrides` shape; pure/local, no SSH.
- [ ] Full suite green; no real account ids/hosts introduced (`git grep` clean).

## Deliberate non-goals (this phase)
- **No full adopted-iHPC reconciliation** — synthesizing supervisor paths would bypass the profile-root security boundary; adopted iHPC stays history-only with placement observability instead.
- **No remote dataset probing** in preflight (pure/local). A remote `ssh test -d` dataset check is a candidate for a later phase.
- **No live GPU probing** — the plugin carries scheduler-reported placement; it does not run `nvidia-smi`.
