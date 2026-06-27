# iHPC Internalization — Phase 1 (Criticals) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Open the plugin's "closed world" against real campaigns — adopt externally-started jobs into local run history (C1), make the approval gate actually wired so token-gated operations work (C2), give the plugin a read-only version handshake with the on-node `ihpc-sched` scheduler (C3 step 1), make the plugin disclose when it has fallen back to example profiles (H4/M13), and fix the WebUI so its dashboard reads the same run store the server writes (W1).

**Architecture:** Three new MCP tools (`jobs.adopt`, `approvals.list`, `ihpc.scheduler.version`) plus install/config wiring and one envelope-level disclosure field. New work is decomposed into pure **primitives** (functional-primitive layer: `lib/ihpc-contract.ts`, `ops/jobs/adopt.ts` record synthesizers, `core/config.ts effectiveConfigStatus`) that are unit-tested with fixtures and no SSH, and thin **tools** (business-flow layer) that do the SSH/local-IO and write through the existing `buildRunRecord`/`writeRunRecord` audit path. No scheduler logic is rewritten; the scheduler stays on-node. The dangerous `ihpc.scheduler.deploy` and the Python `--print-contract-version` stamp are **out of Phase 1** (Phase 2, with vendoring).

**Tech Stack:** TypeScript (ES modules, compiled by `tsc -p mcp-server/tsconfig.json`), Zod input schemas, `node --test` (`.test.mjs` against compiled `dist/`), the `JobCommandExecutor` test seam for faking SSH, plain-`.mjs` WebUI importing from `mcp-server/dist/`.

---

## Conventions for every task (read once)

- **Build before test:** `npm test` runs `tsc` then `node --test`. To run a single test file you must build first: `npm run build && node --test mcp-server/tests/ops/<file>.test.mjs`.
- **Tests import from `dist/`,** never `src/`: `import { foo } from "../../dist/ops/jobs/adopt.js"`.
- **Isolated state:** use `tempRuntimeDir(prefix)` from `mcp-server/tests/helpers/index.mjs` and pass `{ auditDir }` (or `approvalDir`) explicitly. Never rely on the real `~/.local/state`.
- **Adding a tool is a 5-touch change** (learned during Chunk 1 execution): (1) handler in `ops/…`, (2) input schema fields reused/added in `mcp/schemas.ts`, (3) `defineTool(...)` entry in `index.ts` — the live `TOOLS` array is **grouped by domain, NOT alphabetical**, so append in the appropriate group (the sorted invariants are in the test files, not the array), (4) update `mcp-server/tests/integration/tool-registration.test.mjs`, **(5) ALSO update `mcp-server/tests/integration/mcp-protocol.test.mjs`** — it independently pins a sorted tool inventory **and** a per-tool annotation classification (`EXPECTED_TOOL_ANNOTATIONS`); the full suite fails until the new tool is added there too — this has **two** counters that both must move: add the new name to `EXPECTED_TOOL_NAMES` (line ~30; the `names.length === EXPECTED_TOOL_NAMES.length` assert at line ~87 is self-adjusting) **and** bump the hardcoded literal at line ~88 `assert.equal(names.length, 38, "38 table entries map to 38 unique tool names")` (update both the number and the string), plus the comments at lines ~28-29/~85. Phase 1 takes the tool count **38 → 41** (after Tasks 2, 4, 6).
- **Example profile ids (verified):** `profiles/profiles.example.yaml` ships `uts-hpc-account-a`, `uts-hpc-account-b`, `uts-ihpc-account-a`, `uts-ihpc-account-b`. `getProfile` throws `Unknown profile_id` on a miss — use these exact ids in tests.
- **Env-option threading:** read `process.env.UTS_COMPUTING_TEST_MODE` etc. **inside** the handler closure, never at registration time (so the test seam works).
- **Secrets:** never write a real account id, host, or token into any tracked file. The approval-token wiring carries only the `${user_config.approval_token}` placeholder.
- **Commit after every task** with a Conventional Commit message. Do not push.

---

## Chunk 1: Control-plane read paths (Tasks 1–4)

### Task 1: iHPC scheduler contract primitives (`lib/ihpc-contract.ts`)

Pure, dependency-free string functions that construct/parse/compare the scheduler contract version (`pyproject.version + "+state" + STATE_VERSION + "+" + gitShortSha`, e.g. `0.1.0+state2+e6883a9`), plus the constant the plugin pins. No SSH, no IO.

**Files:**
- Create: `mcp-server/src/lib/ihpc-contract.ts`
- Test: `mcp-server/tests/lib/ihpc-contract.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// mcp-server/tests/lib/ihpc-contract.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import {
  schedulerContractVersion,
  parseContractVersion,
  compareContract,
  EXPECTED_SCHEDULER_CONTRACT
} from "../../dist/lib/ihpc-contract.js";

test("schedulerContractVersion composes the three-part contract string", () => {
  assert.equal(
    schedulerContractVersion({ version: "0.1.0", stateVersion: 2, gitSha: "e6883a9" }),
    "0.1.0+state2+e6883a9"
  );
});

test("parseContractVersion round-trips a well-formed contract string", () => {
  assert.deepEqual(parseContractVersion("0.1.0+state2+e6883a9"), {
    version: "0.1.0",
    stateVersion: 2,
    gitSha: "e6883a9"
  });
});

test("parseContractVersion returns null for unparseable input", () => {
  assert.equal(parseContractVersion(""), null);
  assert.equal(parseContractVersion("not-a-version"), null);
  assert.equal(parseContractVersion("0.1.0+state2"), null); // missing sha
});

test("compareContract reports match / stale / unknown", () => {
  const expected = "0.1.0+state2+e6883a9";
  assert.equal(compareContract(expected, expected), "match");
  // same version+sha, older state schema -> stale
  assert.equal(compareContract("0.1.0+state1+e6883a9", expected), "stale");
  // different git sha -> stale (drifted from pinned)
  assert.equal(compareContract("0.1.0+state2+deadbee", expected), "stale");
  // unparseable live string -> unknown (e.g. scheduler predates the flag, SSH junk)
  assert.equal(compareContract("", expected), "unknown");
  assert.equal(compareContract(undefined, expected), "unknown");
});

test("EXPECTED_SCHEDULER_CONTRACT is a parseable contract string the plugin pins", () => {
  assert.ok(parseContractVersion(EXPECTED_SCHEDULER_CONTRACT), "pinned contract must parse");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test mcp-server/tests/lib/ihpc-contract.test.mjs`
Expected: FAIL — `Cannot find module '../../dist/lib/ihpc-contract.js'`.

- [ ] **Step 3: Implement the primitives**

```typescript
// mcp-server/src/lib/ihpc-contract.ts
// Pure contract-version primitives for the on-node ihpc-sched scheduler. The contract string is the
// single source of truth for "which scheduler is actually running": pyproject version + the on-disk
// STATE_VERSION schema number + the git short SHA the deploy pinned. The plugin pins EXPECTED_…; the
// ihpc.scheduler.version tool reads the live string off the node and asks compareContract for a verdict.
// No IO here — the tool fetches the live string; these functions only build/parse/compare.

export interface ContractParts {
  version: string;      // pyproject [project].version, e.g. "0.1.0"
  stateVersion: number; // src/scheduler/state.py STATE_VERSION, e.g. 2
  gitSha: string;       // git short SHA the deploy pinned, e.g. "e6883a9"
}

export type ContractVerdict = "match" | "stale" | "unknown";

const CONTRACT_RE = /^(\d+\.\d+\.\d+)\+state(\d+)\+([0-9a-f]{7,40})$/;

export function schedulerContractVersion(parts: ContractParts): string {
  return `${parts.version}+state${parts.stateVersion}+${parts.gitSha}`;
}

export function parseContractVersion(value: string | undefined | null): ContractParts | null {
  if (!value) return null;
  const m = CONTRACT_RE.exec(value.trim());
  if (!m) return null;
  return { version: m[1], stateVersion: Number.parseInt(m[2], 10), gitSha: m[3] };
}

// "match" only when the live string parses AND equals the pinned string exactly. Any parseable-but-
// different string is "stale" (drifted scheduler — the audit's two-accounts-different-versions hazard).
// Unparseable / missing live string is "unknown" (SSH failed, or the scheduler predates the stamp).
export function compareContract(live: string | undefined | null, expected: string): ContractVerdict {
  const liveParts = parseContractVersion(live);
  if (!liveParts) return "unknown";
  return live!.trim() === expected ? "match" : "stale";
}

// The contract the plugin pins. Phase 2 will regenerate this from the vendored pyproject + STATE_VERSION
// + UPSTREAM SHA; for Phase 1 it tracks the audited authoritative scheduler (mtics/uts-ihpc @ e6883a9).
export const EXPECTED_SCHEDULER_CONTRACT = "0.1.0+state2+e6883a9";
```

- [ ] **Step 4: Run the test to verify it passes**

Run: `npm run build && node --test mcp-server/tests/lib/ihpc-contract.test.mjs`
Expected: PASS (6 tests).

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/lib/ihpc-contract.ts mcp-server/tests/lib/ihpc-contract.test.mjs
git commit -m "feat(ihpc): add scheduler contract-version primitives (C3)"
```

---

### Task 2: `ihpc.scheduler.version` read-only handshake tool

A read-only tool: SSH to the iHPC profile's host, run the scheduler's contract-version print, compare to `EXPECTED_SCHEDULER_CONTRACT`, return `{ live, expected, verdict }`. `verdict !== "match"` ⇒ the tool result carries `ok:false` so drift is loud. Because no node runs the stamp yet (Phase 2 adds it), against a real node today the verdict is `unknown` — which is honest. Unit-tested with a mocked executor for all three verdicts.

**Files:**
- Create: `mcp-server/src/ops/jobs/scheduler-version.ts`
- Modify: `mcp-server/src/index.ts` (import + `TOOLS` entry)
- Modify: `mcp-server/src/mcp/schemas.ts` (reuse `PROFILE_ID`, `timeoutMsField` — likely no new field needed)
- Modify: `mcp-server/tests/integration/tool-registration.test.mjs` (add name)
- Test: `mcp-server/tests/ops/scheduler-version.test.mjs`

- [ ] **Step 1: Write the failing test** (handler-level, mocked executor)

```javascript
// mcp-server/tests/ops/scheduler-version.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { schedulerVersion } from "../../dist/ops/jobs/scheduler-version.js";
import { EXPECTED_SCHEDULER_CONTRACT } from "../../dist/lib/ihpc-contract.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

// Minimal iHPC profile fixture is read from the bundled example profiles; pick an existing iHPC id.
// (profiles.example.yaml ships an iHPC profile — confirm the id and use it here.)
const IHPC_PROFILE = "uts-ihpc-account-a";

function mockExecutor(stdout, { exitCode = 0, stderr = "" } = {}) {
  const calls = [];
  const exec = async (program, args, timeoutMs) => {
    calls.push({ program, args, timeoutMs });
    return { exitCode, stdout, stderr, timedOut: false };
  };
  return { exec, calls };
}

test("verdict=match when the node reports the pinned contract", async () => {
  tempRuntimeDir("sched-ver");
  const { exec, calls } = mockExecutor(`${EXPECTED_SCHEDULER_CONTRACT}\n`);
  const { scheduler } = await schedulerVersion({ profileId: IHPC_PROFILE }, { executor: exec });
  assert.equal(scheduler.verdict, "match");
  assert.equal(scheduler.live, EXPECTED_SCHEDULER_CONTRACT);
  assert.equal(scheduler.expected, EXPECTED_SCHEDULER_CONTRACT);
  assert.equal(scheduler.ok, true);
  assert.equal(calls[0].program, "ssh");
});

test("verdict=stale when the node reports a drifted contract", async () => {
  const { exec } = mockExecutor("0.1.0+state1+e6883a9\n");
  const { scheduler } = await schedulerVersion({ profileId: IHPC_PROFILE }, { executor: exec });
  assert.equal(scheduler.verdict, "stale");
  assert.equal(scheduler.ok, false);
});

test("verdict=unknown when SSH fails or output is unparseable", async () => {
  const { exec } = mockExecutor("", { exitCode: 255, stderr: "ssh: connect: timed out" });
  const { scheduler } = await schedulerVersion({ profileId: IHPC_PROFILE }, { executor: exec });
  assert.equal(scheduler.verdict, "unknown");
  assert.equal(scheduler.ok, false);
});

test("rejects a non-iHPC profile", async () => {
  const { exec } = mockExecutor(`${EXPECTED_SCHEDULER_CONTRACT}\n`);
  await assert.rejects(
    () => schedulerVersion({ profileId: "uts-hpc-account-a" }, { executor: exec }),
    /iHPC/
  );
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test mcp-server/tests/ops/scheduler-version.test.mjs`
Expected: FAIL — module not found. (Example ids are verified: `uts-ihpc-account-a` / `uts-hpc-account-a`; see the Conventions block.)

- [ ] **Step 3: Implement the handler**

```typescript
// mcp-server/src/ops/jobs/scheduler-version.ts
// Business flow (read-only): ask the on-node ihpc-sched what contract version it is actually running,
// and compare to the version the plugin pins. This is C3 step 1 — the version handshake — and the
// precondition for ihpc.scheduler.deploy (Phase 2): you must be able to SEE drift before you can fix it.
import { getProfile } from "../../core/config.js";
import { PLATFORM } from "../../core/types.js";
import { sshJobArgs } from "../../lib/ssh.js";
import { runProcess } from "../../lib/process.js";
import { compareContract, EXPECTED_SCHEDULER_CONTRACT, type ContractVerdict } from "../../lib/ihpc-contract.js";

export type SchedulerCommandExecutor = (
  program: string,
  args: string[],
  timeoutMs: number
) => Promise<{ exitCode: number | null; stdout: string; stderr: string; timedOut?: boolean }>;

export interface SchedulerVersionOptions {
  configPath?: string;
  executor?: SchedulerCommandExecutor;
  timeoutMs?: number;
}

export interface SchedulerVersionResult {
  scheduler: {
    profile_id: string;
    live: string | null;        // trimmed live string, or null if SSH gave nothing
    expected: string;
    verdict: ContractVerdict;   // match | stale | unknown
    ok: boolean;                // verdict === "match"
    summary: string;
  };
}

// The print command. The on-node ihpc-sched gains `--print-contract-version` in Phase 2; until then a
// real node returns nonzero/empty -> verdict "unknown". Keep the remote argv fixed (no interpolation).
const REMOTE_ARGV = ["ihpc-sched", "--print-contract-version"];

export async function schedulerVersion(
  input: { profileId: string; timeoutMs?: number },
  options: SchedulerVersionOptions = {}
): Promise<SchedulerVersionResult> {
  const profile = getProfile(input.profileId, options.configPath);
  if (profile.platform !== PLATFORM.IHPC) {
    throw new Error(`ihpc.scheduler.version requires an iHPC profile; ${input.profileId} is ${profile.platform}`);
  }
  const timeoutMs = options.timeoutMs ?? input.timeoutMs ?? 15000;
  const executor: SchedulerCommandExecutor =
    options.executor ?? ((program, args, t) => runProcess(program, args, { timeoutMs: t }));
  const sshArgs = sshJobArgs(profile.login.host_alias, timeoutMs, REMOTE_ARGV);
  const result = await executor("ssh", sshArgs, timeoutMs);
  const live = result.exitCode === 0 ? result.stdout.trim() : "";
  const verdict = compareContract(live, EXPECTED_SCHEDULER_CONTRACT);
  const summary =
    verdict === "match"
      ? "On-node scheduler matches the pinned contract."
      : verdict === "stale"
        ? `On-node scheduler is DRIFTED (live=${live || "?"} expected=${EXPECTED_SCHEDULER_CONTRACT}). Redeploy before running.`
        : "Could not read the on-node scheduler contract (SSH failed or scheduler predates the version stamp).";
  return {
    scheduler: {
      profile_id: input.profileId,
      live: live || null,
      expected: EXPECTED_SCHEDULER_CONTRACT,
      verdict,
      ok: verdict === "match",
      summary
    }
  };
}
```

> **Implementer notes:** (1) The SSH-arg builder is `sshJobArgs(hostAlias, timeoutMs, remoteArgv)` — verified exported from `mcp-server/src/lib/ssh.ts:105` (also re-exported by `core/access.ts:22`). Confirm `runProcess`'s real signature in `mcp-server/src/lib/process.ts` and match it. Reuse, do not reinvent, the SSH construction. (2) **Login-host vs cnode:** the running `ihpc-sched` tmux loop lives on a compute node (reached `ssh <login-host> ssh <cnode>`), but the *installed* package version is queryable on the login host where it is pip-installed. Phase 1 queries the **login host** (`profile.login.host_alias`) — i.e. "what version is deployed", which is what `ihpc.scheduler.deploy` (Phase 2) installs. If a real node needs a cnode hop, the `unknown` verdict covers it; Phase 2 can refine to target the active cnode. Document this in the tool description.

- [ ] **Step 4: Register the tool in `index.ts`**

Add the import near the other `ops/jobs` imports, and insert this entry into `TOOLS` (alphabetical — `ihpc.scheduler.version` sorts after `docs.*`/`jobs.*`? No: dotted names sort lexicographically, so `ihpc.scheduler.version` sits between `docs.*` and `jobs.*`). Keep the array sorted:

```typescript
import { schedulerVersion } from "./ops/jobs/scheduler-version.js";
// …
defineTool(
  "ihpc.scheduler.version",
  {
    title: "Check on-node scheduler version",
    annotations: READ_REMOTE,
    description:
      "Read-only: SSH to the iHPC profile host and report the on-node ihpc-sched contract version " +
      "versus the version this plugin pins. verdict=match|stale|unknown; result ok is false unless match. " +
      "Use before deploying or launching a campaign to catch a drifted/stale scheduler.",
    inputSchema: strictInput({
      profileId: PROFILE_ID,
      timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
    })
  },
  async ({ profileId, timeoutMs }) =>
    safeTool(() => schedulerVersion({ profileId, timeoutMs }))
),
```

> Match the real names for the annotation constant (e.g. `READ_REMOTE`), `strictInput`, `PROFILE_ID`, `timeoutMsField`, and `TIMEOUT_MS_STANDARD` as they appear in `index.ts`/`schemas.ts`. The test seam for SSH at the tool level is not required for Phase 1 (the handler is unit-tested directly with `options.executor`); the registered tool uses the real executor.

- [ ] **Step 5: Update the registration test** (both counters — see Conventions)

In `mcp-server/tests/integration/tool-registration.test.mjs`: add `"ihpc.scheduler.version"` to `EXPECTED_TOOL_NAMES` in sorted position, **and** change the literal at line ~88 from `assert.equal(names.length, 38, "38 table entries map to 38 unique tool names")` to `39` (update both the number and the `"38 …"` string), and the comments at lines ~28-29/~85. After this task the count is **39**.

- [ ] **Step 6: Run the targeted tests, then the full suite**

```bash
npm run build && node --test mcp-server/tests/ops/scheduler-version.test.mjs
npm test
```
Expected: new tests PASS; full suite green (baseline 391 + this phase's new tests).

- [ ] **Step 7: Commit**

```bash
git add mcp-server/src/ops/jobs/scheduler-version.ts mcp-server/src/index.ts \
  mcp-server/tests/ops/scheduler-version.test.mjs mcp-server/tests/integration/tool-registration.test.mjs
git commit -m "feat(ihpc): add ihpc.scheduler.version read-only contract handshake (C3)"
```

---

### Task 3: Adopt primitives — `pbsRowToRunRecord`, `ihpcPidToRunRecord`

Pure functions that turn external evidence into a valid `RunRecord` (no SSH, no IO). `pbsRowToRunRecord` takes raw `qstat -x -f` text + context and composes the existing parsers; `ihpcPidToRunRecord` builds a record from an observed `node`+`pid`. These are the functional-primitive layer for C1.

**Files:**
- Create: `mcp-server/src/ops/jobs/adopt.ts`
- Modify: `mcp-server/src/ops/jobs/jobs.ts` (add `export` to `parseQstatStatus`; export `sshJobArgs`, `assertAllowedHpcJobRemoteArgv`, `JobCommandExecutor`, `defaultJobCommandExecutor` for the tool in Task 4)
- Modify: `mcp-server/src/ops/jobs/accounting.ts` (export a shared `metricsToRunUsage(metrics): RunUsage`, relocating the body of jobs.ts's private `toRunUsage`)
- Test: `mcp-server/tests/ops/adopt-primitives.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// mcp-server/tests/ops/adopt-primitives.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { pbsRowToRunRecord, ihpcPidToRunRecord } from "../../dist/ops/jobs/adopt.js";

const QSTAT_RUNNING = `Job Id: 4321.cetus
    Job_Name = hpo-trial-7
    job_state = R
    queue = workq
    exec_host = node07/0*4
    resources_used.walltime = 01:00:00
    resources_used.ncpus = 4
    resources_used.cpupercent = 380
    Resource_List.ncpus = 4
`;

const now = new Date("2026-06-20T10:00:00.000Z");

test("pbsRowToRunRecord synthesizes a valid running RunRecord from qstat text", () => {
  const rec = pbsRowToRunRecord(QSTAT_RUNNING, {
    runId: "adopt-4321-cetus",
    profileId: "uts-hpc-account-a",
    platform: "uts-hpc",
    remoteJobId: "4321.cetus",
    now
  });
  assert.equal(rec.run_id, "adopt-4321-cetus");
  assert.equal(rec.platform, "uts-hpc");
  assert.equal(rec.remote_job_id, "4321.cetus");
  assert.equal(rec.status, "running");
  assert.equal(rec.rev, 0);
  assert.equal(rec.created_at, now.toISOString());
  assert.equal(rec.usage?.ncpus, 4);
  assert.ok(rec.usage?.core_hours > 0);
  assert.equal(rec.submission?.node, "node07");
  assert.equal(rec.events[0].kind, "adopted-external");
});

test("pbsRowToRunRecord tolerates queued jobs (no exec_host / no usage)", () => {
  const rec = pbsRowToRunRecord("Job Id: 99.cetus\n    job_state = Q\n", {
    runId: "adopt-99-cetus",
    profileId: "uts-hpc-account-a",
    platform: "uts-hpc",
    remoteJobId: "99.cetus",
    now
  });
  assert.equal(rec.status, "submitted"); // Q maps to submitted
  assert.equal(rec.usage, undefined);
  assert.equal(rec.submission?.node, undefined);
});

test("ihpcPidToRunRecord synthesizes a history-only iHPC record with the canonical remote_job_id", () => {
  const rec = ihpcPidToRunRecord({
    runId: "adopt-venus01-31245",
    profileId: "uts-ihpc-account-a",
    node: "venus01",
    pid: 31245,
    now
  });
  assert.equal(rec.platform, "uts-ihpc");
  // remote_job_id MUST match the format requireIhpcSupervisor expects (jobs.ts:1036) so the id is
  // well-formed even though Phase 1 leaves the run history-only (no supervisor block).
  assert.equal(rec.remote_job_id, "ihpc-adopt-venus01-31245-31245");
  assert.equal(rec.status, "running");
  assert.equal(rec.submission?.node, "venus01");
  assert.equal(rec.supervisor, undefined); // history-only in Phase 1 — see Task 4 scoping note
  assert.equal(rec.events[0].kind, "adopted-external");
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test mcp-server/tests/ops/adopt-primitives.test.mjs`
Expected: FAIL — module not found.

- [ ] **Step 3: Prep the reuse exports** (minimize the surface)

`adopt.ts` imports most things from their **canonical** modules, not by laundering through the giant `jobs.ts`:
- `getProfile` from `core/config.js`; `assertSafeRunId`, `isSafeRemoteJobId` from `core/ids.js`; `sshJobArgs` from `lib/ssh.js`; `readRunRecordSafe`, `writeRunRecord` from `core/audit.js`; the parsers from `accounting.js`.

Only three symbols genuinely live in `jobs.ts` and must be exported there:
- change `function parseQstatStatus(` → `export function parseQstatStatus(` (jobs.ts:647),
- add `export` to `assertAllowedHpcJobRemoteArgv` (local, jobs.ts:~1225) and to the `defaultJobCommandExecutor` const (jobs.ts:~1294). The `JobCommandExecutor` type is already exported (jobs.ts:63). **Do not** try to `export` the `sshJobArgs` symbol from jobs.ts — there it is an *imported* name, not a declaration; import it from `lib/ssh.js` in `adopt.ts` instead.

In `mcp-server/src/ops/jobs/accounting.ts`: add an exported `metricsToRunUsage(metrics: UsageMetrics): RunUsage` containing the body currently in jobs.ts's private `toRunUsage` (lines 206-216 — the `parseMemGb`/`round2` mapping; move those helpers too if they are local to jobs.ts). Then in jobs.ts, replace the private `toRunUsage` body with `return metricsToRunUsage(metrics);` (import it). The existing `jobs-usage.test.mjs` guards this refactor — it must stay green.

- [ ] **Step 4: Implement the primitives**

```typescript
// mcp-server/src/ops/jobs/adopt.ts
// Functional-primitive layer for C1 (open the closed world). These turn EXTERNAL evidence — a qstat -x
// row, or an observed iHPC node+pid — into a schema-valid RunRecord. Pure: no SSH, no disk. The tool
// (adoptExternalRun) fetches the evidence and persists the record; these only build it.
import {
  parsePbsUsage,
  computeUsageMetrics,
  parseExecNodes,
  metricsToRunUsage
} from "./accounting.js";
import { parseQstatStatus } from "./jobs.js";
import type { Platform, RunRecord } from "../../core/types.js";

export interface PbsAdoptContext {
  runId: string;
  profileId: string;
  platform: Platform; // "uts-hpc"
  remoteJobId: string;
  now: Date;
  project?: string;
  accountLabel?: string; // tool passes profile.account_label
  cluster?: string;      // tool passes the login host
}

export function pbsRowToRunRecord(qstatText: string, ctx: PbsAdoptContext): RunRecord {
  const parsed = parseQstatStatus(qstatText, "", 0); // { status, schedulerState?, summary }
  const usageRaw = parsePbsUsage(qstatText);
  const usage = usageRaw ? metricsToRunUsage(computeUsageMetrics(usageRaw)) : undefined;
  const execNodes = parseExecNodes(qstatText);
  const node = execNodes.length > 0 ? execNodes.join("+") : undefined;
  const at = ctx.now.toISOString();
  return {
    run_id: ctx.runId,
    profile_id: ctx.profileId,
    platform: ctx.platform,
    remote_job_id: ctx.remoteJobId,
    rev: 0,
    ...(ctx.project ? { project: ctx.project } : {}),
    status: parsed.status,
    created_at: at,
    updated_at: at,
    ...(usage ? { usage } : {}),
    ...(node
      ? { submission: { account_label: ctx.accountLabel ?? ctx.profileId, cluster: ctx.cluster ?? ctx.profileId, node, requested: {}, submitted_at: at } }
      : {}),
    events: [
      {
        at,
        kind: "adopted-external",
        summary: `Adopted external PBS job ${ctx.remoteJobId} (scheduler state ${parsed.schedulerState ?? "?"})`
      }
    ]
  };
}

export interface IhpcAdoptContext {
  runId: string;
  profileId: string;
  node: string;
  pid: number;
  now: Date;
  status?: RunRecord["status"]; // default "running"
  project?: string;
  accountLabel?: string;
  cluster?: string;
}

export function ihpcPidToRunRecord(ctx: IhpcAdoptContext): RunRecord {
  const at = ctx.now.toISOString();
  // Phase 1: HISTORY-ONLY. We give the record the canonical iHPC remote_job_id shape that
  // requireIhpcSupervisor (jobs.ts:1036) expects, but we do NOT synthesize a supervisor block —
  // an externally-started ihpc-sched process does not expose its metadata/stdout/stderr paths, and
  // requireIhpcSupervisor also validates those paths live inside the profile roots. So the adopted
  // iHPC run is DISCOVERABLE (jobs.history, WebUI) but jobs.status/logs/cancel will raise the clear
  // "does not include iHPC supervisor metadata" error until Phase 4 builds proper iHPC supervision.
  const remoteJobId = `ihpc-${ctx.runId}-${ctx.pid}`;
  return {
    run_id: ctx.runId,
    profile_id: ctx.profileId,
    platform: "uts-ihpc",
    remote_job_id: remoteJobId,
    rev: 0,
    ...(ctx.project ? { project: ctx.project } : {}),
    status: ctx.status ?? "running",
    created_at: at,
    updated_at: at,
    submission: { account_label: ctx.accountLabel ?? ctx.profileId, cluster: ctx.cluster ?? ctx.profileId, node: ctx.node, requested: {}, submitted_at: at },
    events: [{ at, kind: "adopted-external", summary: `Adopted external iHPC process pid ${ctx.pid} on ${ctx.node} (history-only)` }]
  };
}
```

> **Implementer notes:** (1) Add optional `accountLabel?`/`cluster?` to `IhpcAdoptContext` and `PbsAdoptContext`; the **tool** (Task 4) reads the real `profile.account_label` and login host from `getProfile` and passes them in, so the primitive stays pure (no IO) while `submission` carries truthful values. (2) `submission.requested` accepting `{}` is **verified schema-valid** — `run-record.schema.json` has no `required` on `requested` and its only props are optional (lines 46-55). Still, validate the synthesized record against the schema in the test: import `assertRunRecord` from `dist/core/validation.js` and assert it does not throw for both PBS and iHPC outputs. `events[].kind` is an unconstrained string, so `"adopted-external"` is fine.

- [ ] **Step 5: Run the test to verify it passes; run usage tests to confirm the refactor**

```bash
npm run build
node --test mcp-server/tests/ops/adopt-primitives.test.mjs
node --test mcp-server/tests/ops/jobs-usage.test.mjs mcp-server/tests/ops/accounting.test.mjs
```
Expected: all PASS.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/jobs/adopt.ts mcp-server/src/ops/jobs/jobs.ts \
  mcp-server/src/ops/jobs/accounting.ts mcp-server/tests/ops/adopt-primitives.test.mjs
git commit -m "feat(jobs): add adopt record-synthesis primitives + share metricsToRunUsage (C1)"
```

---

### Task 4: `jobs.adopt` tool — fetch evidence, idempotently write the record

The business-flow tool. Derives platform from the profile. **PBS:** SSH `qstat -x -f <remoteJobId>` (reusing the allowlist + executor seam), call `pbsRowToRunRecord`, write. **iHPC:** require `node`+`pid`, call `ihpcPidToRunRecord`, write. **Idempotent:** if a record with the same `run_id` exists and its `remote_job_id` matches, return it unchanged; if it exists with a conflicting `remote_job_id`, throw.

**Files:**
- Modify: `mcp-server/src/ops/jobs/adopt.ts` (add `adoptExternalRun`)
- Modify: `mcp-server/src/index.ts` (import + `TOOLS` entry, sorted before `jobs.cancel`)
- Modify: `mcp-server/src/mcp/schemas.ts` (reuse `RUN_ID`, `PROFILE_ID`; add a small `pidField` if useful)
- Modify: `mcp-server/tests/integration/tool-registration.test.mjs` (add `"jobs.adopt"`, bump count)
- Test: `mcp-server/tests/ops/jobs-adopt.test.mjs`

- [ ] **Step 1: Write the failing test** (mocked executor + temp auditDir)

```javascript
// mcp-server/tests/ops/jobs-adopt.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { readRunRecord } from "../../dist/core/audit.js";
import { adoptExternalRun } from "../../dist/ops/jobs/adopt.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

const QSTAT = `Job Id: 4321.cetus\n    job_state = R\n    exec_host = node07/0*4\n    resources_used.walltime = 01:00:00\n    resources_used.ncpus = 4\n`;
const now = new Date("2026-06-20T10:00:00.000Z");

function pbsExecutor(stdout) {
  const calls = [];
  return {
    calls,
    exec: async (program, args, t) => {
      calls.push({ program, args, t });
      return { exitCode: 0, stdout, stderr: "", timedOut: false };
    }
  };
}

test("jobs.adopt (PBS) SSHes qstat and writes a discoverable record", async () => {
  const auditDir = tempRuntimeDir("adopt-pbs");
  const { exec, calls } = pbsExecutor(QSTAT);
  const res = await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  assert.equal(res.adopted.run_id, "adopt-4321-cetus");
  assert.equal(res.adopted.status, "running");
  assert.equal(calls[0].program, "ssh");
  const onDisk = readRunRecord("adopt-4321-cetus", auditDir);
  assert.equal(onDisk.remote_job_id, "4321.cetus");
  assert.equal(onDisk.events[0].kind, "adopted-external");
});

test("jobs.adopt is idempotent for a matching re-adopt", async () => {
  const auditDir = tempRuntimeDir("adopt-idem");
  const { exec } = pbsExecutor(QSTAT);
  const first = await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  const second = await adoptExternalRun(
    { runId: "adopt-4321-cetus", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  assert.equal(second.adopted.idempotent, true);
  assert.equal(first.adopted.run_id, second.adopted.run_id);
});

test("jobs.adopt refuses a conflicting remote_job_id on an existing run", async () => {
  const auditDir = tempRuntimeDir("adopt-conflict");
  const { exec } = pbsExecutor(QSTAT);
  await adoptExternalRun(
    { runId: "adopt-x", profileId: "uts-hpc-account-a", remoteJobId: "4321.cetus" },
    { auditDir, executor: exec, now }
  );
  await assert.rejects(
    () =>
      adoptExternalRun(
        { runId: "adopt-x", profileId: "uts-hpc-account-a", remoteJobId: "9999.cetus" },
        { auditDir, executor: exec, now }
      ),
    /already exists|conflict/i
  );
});

test("jobs.adopt (iHPC) requires node+pid and writes a history-only record", async () => {
  const auditDir = tempRuntimeDir("adopt-ihpc");
  const res = await adoptExternalRun(
    { runId: "adopt-venus01-31245", profileId: "uts-ihpc-account-a", node: "venus01", pid: 31245 },
    { auditDir, now }
  );
  assert.equal(res.adopted.status, "running");
  const onDisk = readRunRecord("adopt-venus01-31245", auditDir);
  assert.equal(onDisk.remote_job_id, "ihpc-adopt-venus01-31245-31245");
  assert.equal(onDisk.platform, "uts-ihpc");
  assert.equal(onDisk.supervisor, undefined); // Phase 1: history-only, see scoping note
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npm run build && node --test mcp-server/tests/ops/jobs-adopt.test.mjs`
Expected: FAIL — `adoptExternalRun` not exported.

- [ ] **Step 3: Implement `adoptExternalRun`** (append to `adopt.ts`)

```typescript
import { assertSafeRunId, isSafeRemoteJobId } from "../../core/ids.js";
import { getProfile } from "../../core/config.js";
import { readRunRecordSafe, writeRunRecord } from "../../core/audit.js";
import { PLATFORM } from "../../core/types.js";
import { sshJobArgs } from "../../lib/ssh.js";
// Only these three genuinely live in jobs.ts (Task 3 step 3 added the exports):
import { assertAllowedHpcJobRemoteArgv, defaultJobCommandExecutor, type JobCommandExecutor } from "./jobs.js";

export interface AdoptInput {
  runId: string;
  profileId: string;
  remoteJobId?: string; // PBS: required
  node?: string;        // iHPC: required
  pid?: number;         // iHPC: required
  timeoutMs?: number;
}

export interface AdoptOptions {
  auditDir?: string;
  configPath?: string;
  executor?: JobCommandExecutor;
  now?: Date;
}

export interface AdoptResult {
  adopted: { run_id: string; remote_job_id: string; platform: Platform; status: RunRecord["status"]; idempotent: boolean };
}

export async function adoptExternalRun(input: AdoptInput, options: AdoptOptions = {}): Promise<AdoptResult> {
  assertSafeRunId(input.runId);
  const now = options.now ?? new Date();
  const profile = getProfile(input.profileId, options.configPath);

  let record: RunRecord;
  if (profile.platform === PLATFORM.HPC) {
    if (!input.remoteJobId || !isSafeRemoteJobId(input.remoteJobId)) {
      throw new Error("jobs.adopt for a PBS profile requires a valid remoteJobId");
    }
    const timeoutMs = input.timeoutMs ?? 15000;
    const executor = options.executor ?? defaultJobCommandExecutor;
    const remoteArgv = ["qstat", "-x", "-f", input.remoteJobId];
    assertAllowedHpcJobRemoteArgv(remoteArgv);
    const args = sshJobArgs(profile.login.host_alias, timeoutMs, remoteArgv);
    const res = await executor("ssh", args, timeoutMs);
    if (res.exitCode !== 0) {
      throw new Error(`qstat for ${input.remoteJobId} failed (exit ${res.exitCode}); cannot adopt`);
    }
    record = pbsRowToRunRecord(res.stdout, {
      runId: input.runId,
      profileId: input.profileId,
      platform: PLATFORM.HPC,
      remoteJobId: input.remoteJobId,
      accountLabel: profile.account_label,
      cluster: profile.login.host_alias,
      now
    });
  } else {
    if (!input.node || typeof input.pid !== "number") {
      throw new Error("jobs.adopt for an iHPC profile requires node and pid");
    }
    record = ihpcPidToRunRecord({
      runId: input.runId,
      profileId: input.profileId,
      node: input.node,
      pid: input.pid,
      accountLabel: profile.account_label,
      cluster: profile.login.host_alias,
      now
    });
  }

  // Idempotency keyed by run_id + remote_job_id.
  const existing = readRunRecordSafe(input.runId, options.auditDir);
  if (existing) {
    if (existing.remote_job_id === record.remote_job_id) {
      return {
        adopted: {
          run_id: existing.run_id,
          remote_job_id: existing.remote_job_id ?? "",
          platform: existing.platform,
          status: existing.status,
          idempotent: true
        }
      };
    }
    throw new Error(
      `Run ${input.runId} already exists with remote_job_id ${existing.remote_job_id}; refusing to overwrite (conflict)`
    );
  }

  writeRunRecord(record, options.auditDir);
  return {
    adopted: {
      run_id: record.run_id,
      remote_job_id: record.remote_job_id ?? "",
      platform: record.platform,
      status: record.status,
      idempotent: false
    }
  };
}
```

- [ ] **Step 4: Register the tool, update the registration test** (pattern from Task 2; annotation `ANNOTATIONS_EFFECTFUL_LOCAL` or the closest existing "writes local state, reads remote" set — adopt both SSHes and writes locally, so prefer an effectful-remote-read annotation; match an existing tool's annotation that best fits). Thread the test executor inside the closure only if a protocol-level integration test needs it; the handler is unit-tested directly. Add `"jobs.adopt"` to `EXPECTED_TOOL_NAMES`, bump count to 40.

- [ ] **Step 5: Run targeted + full suite**

```bash
npm run build && node --test mcp-server/tests/ops/jobs-adopt.test.mjs
npm test
```
Expected: all green.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/jobs/adopt.ts mcp-server/src/index.ts mcp-server/src/mcp/schemas.ts \
  mcp-server/tests/ops/jobs-adopt.test.mjs mcp-server/tests/integration/tool-registration.test.mjs
git commit -m "feat(jobs): add jobs.adopt tool to onboard external PBS/iHPC jobs (C1)"
```

> **Closed-world verification (do once after Task 4):**
> - **PBS (fully unlocked):** `jobs.history`, `jobs.status`, `jobs.usage`, `jobs.logs`, `jobs.cancel` work on an adopted PBS record with **zero further changes**, because they all resolve `runId → readRunRecord → requireRemoteJobId`, and a PBS `remote_job_id` like `4321.cetus` passes `isSafeRemoteJobId`. Add one integration test: adopt a PBS record into a temp `auditDir`, then call `jobsHistory({ auditDir })` and assert the adopted run appears with `total >= 1`. This is the proof that the closed world is open.
> - **iHPC (history-only in Phase 1):** an adopted iHPC record appears in `jobs.history`/WebUI, but `jobs.status`/`jobs.logs`/`jobs.cancel` will raise the clear `does not include iHPC supervisor metadata` error (jobs.ts:1028) because Phase 1 does not synthesize a supervisor block. Assert exactly that in a test (call `getJobStatus` on the adopted iHPC run and `assert.rejects(/supervisor/)`), so the limitation is pinned and honest. Full adopted-iHPC reconciliation lands in **Phase 4** (iHPC supervision). This scoping is listed in "Deliberate deviations" below.

---

## Chunk 2: Install integrity, disclosure & WebUI (Tasks 5–9)

### Task 5: C2 — wire `UTS_COMPUTING_APPROVAL_TOKEN` into the install

The gate primitive (`assertConfirmationToken`, `auth.ts:104`) already reads the env var; it is simply never set by the shipped install. **Precise gate chain (verified):** `approvals.decide` (`approvals.ts:248`) and `state.migrate.apply` (`migrations.ts:174`) call `assertConfirmationToken` directly — they hard-throw without the token. `jobs.cancel` (`jobs.ts:1183`) and `artifacts.cleanup.execute` require an *approved* approval record, which can only be produced by `approvals.decide` — so the dead token is the **upstream bottleneck** that makes every approval-gated mutation unusable, even for the plugin's own jobs. Wire the env var through `.mcp.json` (env) and `manifest.json` (`user_config`). The token **value** never enters the repo — only the `${user_config.approval_token}` placeholder.

**Files:**
- Modify: `.mcp.json` (**skip-worktree** — see Step 3; the working copy is a local override pointing at `profiles.local.yaml`)
- Modify: `manifest.json`
- Modify: `mcp-server/tests/integration/mcp-config.test.mjs`

> **Critical mechanics for this task:** `.mcp.json` has `git update-index --skip-worktree` set (`git ls-files -v .mcp.json` → `S`). The working tree intentionally points `UTS_COMPUTING_CONFIG` at the gitignored `profiles.local.yaml` (the operator's real config), while **HEAD** ships `profiles.example.yaml`. The existing `mcp-config.test.mjs` reads the **shipped** config via `git show HEAD:.mcp.json`. Two consequences: (a) the new env assertion only goes green **after commit** (the test reads HEAD, not the working tree) — this breaks the usual red→green-in-one-step ordering, which is expected and fine here; (b) you must commit the **shipped** content (`example.yaml` + token), then **restore** the working-tree override and re-set skip-worktree, so the operator's local setup is untouched.

- [ ] **Step 1: Write the failing test** (pin the wiring)

```javascript
// add to mcp-server/tests/integration/mcp-config.test.mjs
test(".mcp.json wires UTS_COMPUTING_APPROVAL_TOKEN to ${user_config.approval_token}", () => {
  const env = mcp.mcpServers["uts-compute"].env;
  assert.equal(env.UTS_COMPUTING_APPROVAL_TOKEN, "${user_config.approval_token}");
});

test("manifest.json declares an optional approval_token user_config field", () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifest.json"), "utf8"));
  assert.ok(manifest.user_config?.approval_token, "approval_token must be declared");
  assert.equal(manifest.user_config.approval_token.type, "string");
  assert.equal(manifest.user_config.approval_token.required, false);
});
```

> The existing `mcp-config.test.mjs` obtains `mcp` by reading **`git show HEAD:.mcp.json`** (the shipped config). So the new env assertion reads HEAD and will only pass **after** Step 6 commits the change — do not expect red→green before committing. Reuse the file's existing HEAD-read helper for `mcp`; read `manifest.json` from the working tree (`fs.readFileSync(path.join(repoRoot, "manifest.json"))`) for the manifest assertion.

- [ ] **Step 2: Run to verify it fails** — `npm run build && node --test mcp-server/tests/integration/mcp-config.test.mjs` → FAIL (the manifest assertion fails immediately; the `.mcp.json` env assertion fails until Step 6).

- [ ] **Step 3: Wire `.mcp.json`** (handle skip-worktree; ship `example.yaml`, preserve the local override):

```bash
# 1. lift skip-worktree so the change can be staged
git update-index --no-skip-worktree .mcp.json
```
Then edit `.mcp.json` so the `uts-compute` server's `env` block is exactly the **shipped** form — `UTS_COMPUTING_CONFIG` back to the example (NOT `profiles.local.yaml`) plus the new token line:

```json
"env": {
  "UTS_COMPUTING_CONFIG": "${CLAUDE_PLUGIN_ROOT}/profiles/profiles.example.yaml",
  "UTS_COMPUTING_APPROVAL_TOKEN": "${user_config.approval_token}"
}
```

> Steps 5–6 commit this. **After committing (end of Step 6),** restore the operator's working override and re-hide it:
> ```bash
> # set UTS_COMPUTING_CONFIG back to profiles/profiles.local.yaml in the working file (keep the token line),
> # then:
> git update-index --skip-worktree .mcp.json
> ```
> Net result: HEAD/shipped `.mcp.json` = `example.yaml` + token placeholder; the operator's working tree keeps `local.yaml` + token placeholder and stays invisible to `git status`.

- [ ] **Step 4: Wire `manifest.json`** — add to `user_config`, after `config_path`:

```json
"approval_token": {
  "type": "string",
  "title": "Approval confirmation token",
  "description": "Optional. A token you choose to gate resource-intensive operations (cancel, artifact cleanup, state migration, approval decisions). Leave empty to leave these operations gated/unavailable. The token is used only by this local MCP server and is never sent to external services.",
  "required": false
}
```

- [ ] **Step 5: Verify the secret-stripping smoke still holds** — `plugin-smoke-boundary.test.mjs` already asserts `UTS_COMPUTING_APPROVAL_TOKEN` is excluded from the shipped/example smoke env. Run `npm test` and confirm it stays green (no real token ever ships).

- [ ] **Step 6: Commit**

```bash
git add .mcp.json manifest.json mcp-server/tests/integration/mcp-config.test.mjs
git commit -m "feat(install): wire UTS_COMPUTING_APPROVAL_TOKEN through .mcp.json + manifest (C2)"
```

---

### Task 6: `approvals.list` enumeration tool (M14)

Thin business-flow wrapper over the **already-existing** `listApprovalRecords` (`approvals.ts:310`). Returns a redaction-safe summary list (id, run_id, profile_id, operation, state, requested_at, expires_at) so an operator/agent can find the approval id a token-gated op needs.

**Files:**
- Modify: `mcp-server/src/ops/approvals/approvals.ts` (add `summarizeApprovalRecords` or a list-summary function if `listApprovalRecords` returns full records)
- Modify: `mcp-server/src/index.ts` (import + `TOOLS` entry, sorted after `approvals.decide`)
- Modify: `mcp-server/tests/integration/tool-registration.test.mjs` (add `"approvals.list"`, bump count to 41)
- Test: `mcp-server/tests/ops/approvals-list.test.mjs`

- [ ] **Step 1: Write the failing test**

```javascript
// mcp-server/tests/ops/approvals-list.test.mjs
import assert from "node:assert/strict";
import test from "node:test";
import { requestApproval, listApprovals } from "../../dist/ops/approvals/approvals.js";
import { tempRuntimeDir } from "../helpers/index.mjs";

test("approvals.list returns a summary of saved approval records", () => {
  const approvalDir = tempRuntimeDir("appr-list");
  // Seed one approval via the existing request path (or write a fixture record).
  // … create at least one approval record under approvalDir …
  const { approvals } = listApprovals({ approvalDir });
  assert.ok(Array.isArray(approvals));
  assert.ok(approvals.length >= 1);
  const a = approvals[0];
  for (const k of ["approval_id", "run_id", "profile_id", "operation", "state", "requested_at"]) {
    assert.ok(k in a, `missing ${k}`);
  }
  // no secrets / no full command bodies in the summary
  assert.equal("resource_summary" in a, false);
});

test("approvals.list is empty (not an error) when no approvals exist", () => {
  const approvalDir = tempRuntimeDir("appr-empty");
  const { approvals } = listApprovals({ approvalDir });
  assert.deepEqual(approvals, []);
});
```

> Seed an approval using the real `requestApproval` (mirror `tests/ops/approval.test.mjs`'s setup: it needs a plan + quota snapshot). If that setup is heavy, instead write a minimal `ApprovalRecord` JSON straight into `approvalDir` (filename `${approval_id}.json`) — but it **must pass `assertApprovalRecord`** (which `readApproval` runs), so include all required fields: `approval_id`, `run_id`, `profile_id`, `platform`, `operation`, `state`, `plan_hash`, `quota_snapshot_id`, `reasons` (array), `requested_at`, `expires_at`, `warnings` (array). When in doubt, prefer `requestApproval` despite the heavier setup.

- [ ] **Step 2: Run to verify it fails** — module/export missing → FAIL.

- [ ] **Step 3: Implement `listApprovals`** in `approvals.ts`:

```typescript
export interface ApprovalSummary {
  approval_id: string;
  run_id: string;
  profile_id: string;
  platform: Platform;
  operation: ApprovalOperation;
  state: ApprovalState;
  requested_at: string;
  expires_at: string;
  decided_at?: string;
}

export function listApprovals(options: ApprovalOptions = {}): { approvals: ApprovalSummary[] } {
  const records = listApprovalRecords(options); // existing enumerator, sorted requested_at desc
  return {
    approvals: records.map((r) => ({
      approval_id: r.approval_id,
      run_id: r.run_id,
      profile_id: r.profile_id,
      platform: r.platform,
      operation: r.operation,
      state: r.state,
      requested_at: r.requested_at,
      expires_at: r.expires_at,
      ...(r.decided_at ? { decided_at: r.decided_at } : {})
    }))
  };
}
```

- [ ] **Step 4: Register the tool** in `index.ts` (annotation `READ_LOCAL`, empty-ish input — only optional filters if desired; keep it `strictInput({})` or with an optional `state` filter). Update `EXPECTED_TOOL_NAMES` (add `"approvals.list"`, count → 41).

- [ ] **Step 5: Run targeted + full** — `npm run build && node --test mcp-server/tests/ops/approvals-list.test.mjs && npm test` → green.

- [ ] **Step 6: Commit**

```bash
git add mcp-server/src/ops/approvals/approvals.ts mcp-server/src/index.ts \
  mcp-server/tests/ops/approvals-list.test.mjs mcp-server/tests/integration/tool-registration.test.mjs
git commit -m "feat(approvals): add approvals.list enumeration tool (M14/C2)"
```

---

### Task 7: H4/M13 — config self-disclosure (`effectiveConfigStatus` + loud fallback + envelope)

Two changes so the plugin stops silently pretending example profiles are real: (a) make **every** fallback to the bundled example write a stderr warning (today unset/empty is silent); (b) add a pure `effectiveConfigStatus()` and surface `{ using_example_profiles, config_path }` in the tool envelope via `safeTool`, so the **agent** (which reads results, not stderr) can see it.

**Files:**
- Modify: `mcp-server/src/core/config.ts` (loud fallback + `effectiveConfigStatus`)
- Modify: `mcp-server/src/index.ts` (`safeTool` injects `config_status`)
- Test: `mcp-server/tests/core/config-fallback.test.mjs` (assert warning + helper), and one envelope test

- [ ] **Step 1: Write the failing tests**

```javascript
// add to mcp-server/tests/core/config-fallback.test.mjs
import { effectiveConfigStatus } from "../../dist/core/config.js";

test("effectiveConfigStatus reports example fallback when env is unset", () => {
  const prev = process.env.UTS_COMPUTING_CONFIG;
  delete process.env.UTS_COMPUTING_CONFIG;
  try {
    const s = effectiveConfigStatus();
    assert.equal(s.using_example_profiles, true);
    assert.match(s.config_path, /profiles\.example\.yaml$/);
  } finally {
    if (prev !== undefined) process.env.UTS_COMPUTING_CONFIG = prev;
  }
});

test("unset/empty fallback now WARNS to stderr (no longer silent)", () => {
  const prev = process.env.UTS_COMPUTING_CONFIG;
  delete process.env.UTS_COMPUTING_CONFIG;
  const writes = [];
  const orig = process.stderr.write;
  process.stderr.write = (chunk, ...rest) => { writes.push(String(chunk)); return true; };
  try {
    defaultConfigPath();
    assert.ok(writes.some((w) => /bundled example profiles/i.test(w)), "expected a fallback warning");
  } finally {
    process.stderr.write = orig;
    if (prev !== undefined) process.env.UTS_COMPUTING_CONFIG = prev;
  }
});
```

For the envelope (new tiny test file `mcp-server/tests/integration/config-status-envelope.test.mjs`): call any read-only tool through the MCP client (or call `safeTool` indirectly) and assert the structured result contains `config_status: { using_example_profiles, config_path }`.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `config.ts`:
  - **Export the helper:** `bundledExampleConfigPath` is currently private (`config.ts:14` — `function bundledExampleConfigPath()`). Change it to `export function bundledExampleConfigPath()`.
  - In `defaultConfigPath()`, the unset/empty branch (`if (!env || env.includes("${"))`) currently returns silently for the unset/empty case. Split it so unset/empty also warns before falling back: `process.stderr.write("uts-compute: UTS_COMPUTING_CONFIG is unset; using the bundled example profiles. Set an absolute path to use real accounts.\n")`. Keep the existing `${…}`-still-present and file-not-found warnings exactly as they are.
  - Add:
    ```typescript
    export function effectiveConfigStatus(): { using_example_profiles: boolean; config_path: string } {
      const config_path = defaultConfigPath();
      return { using_example_profiles: config_path === bundledExampleConfigPath(), config_path };
    }
    ```
  In `index.ts safeTool`, after computing the success `body`, inject (guard against throwing — wrap in try/catch, default to omitted on error):
    ```typescript
    const config_status = safeConfigStatus(); // returns effectiveConfigStatus() or undefined on error
    return jsonContent({ ok: true, ...(config_status ? { config_status } : {}), ...body });
    ```

> **Compatibility:** the output schema is `z.object({ ok: z.boolean() }).passthrough()`, so an extra sibling key is schema-valid. Most existing tests assert specific nested keys, not whole-envelope `deepEqual`. Run the **full** suite after this change; if any test does a strict whole-object compare, relax it to check the keys it cares about. Do **not** add `config_status` to error envelopes (keep error shape minimal).

- [ ] **Step 4: Run full suite** — `npm test`. Fix any shape-strict assertions surfaced. Expected: green.

- [ ] **Step 5: Commit**

```bash
git add mcp-server/src/core/config.ts mcp-server/src/index.ts \
  mcp-server/tests/core/config-fallback.test.mjs mcp-server/tests/integration/config-status-envelope.test.mjs
git commit -m "feat(config): loud example-profile fallback + config_status in tool envelope (H4/M13)"
```

---

### Task 8: W1 — WebUI reads the same run store the server writes

`webui/server.mjs:42` defaults `runtimeDir` to `".uts-computing"` (CWD-relative), but the MCP server writes records under `runtimeRootDir()` (`~/.local/state/.uts-computing` by default). So the dashboard shows `total_runs:0` against real data. Fix: default to the shared `runtimeRootDir()` resolver and add a `UTS_WEBUI_RUNTIME_DIR` / CLI override. After this, adopted records (Task 4) appear in the dashboard with no extra WebUI work.

**Files:**
- Modify: `webui/server.mjs`
- Test: `webui/tests/webui.test.mjs` (or a new `webui/tests/runtime-dir.test.mjs`)

- [ ] **Step 1: Write the failing test**

`createWebuiServer` returns a bare `http.Server` (server.mjs:54) with **no** `runtimeDir`/`config` property, so we must prove W1 **indirectly** — which is also the truer test (it proves records are actually visible). With `UTS_COMPUTING_HOME` set and **no** `runtimeDir` option, a record seeded under `runtimeRootDir()/runs` must show up in `/api/summary`.

```javascript
// webui/tests/runtime-dir.test.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeRootDir } from "../../mcp-server/dist/core/paths.js";
import { createWebuiServer } from "../server.mjs";

// Mirror the listen+fetch helper that webui/tests/webui.test.mjs already uses (ephemeral port 0,
// fetch127.0.0.1, close in finally). Reuse that helper if it is exported; otherwise inline it.
test("WebUI default runtimeDir resolves to runtimeRootDir() so it sees real records (W1)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "webui-home-"));
  const prev = process.env.UTS_COMPUTING_HOME;
  process.env.UTS_COMPUTING_HOME = home;
  try {
    // seed one schema-valid run record under the SERVER's resolved runs dir
    const runsDir = path.join(runtimeRootDir(), "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const rec = {
      run_id: "webui-seed-1",
      profile_id: "uts-hpc-account-a",
      platform: "uts-hpc",
      remote_job_id: "1.cetus",
      status: "finished",
      created_at: "2026-06-20T10:00:00.000Z",
      updated_at: "2026-06-20T10:00:00.000Z",
      events: [{ at: "2026-06-20T10:00:00.000Z", kind: "adopted-external", summary: "seed" }]
    };
    fs.writeFileSync(path.join(runsDir, "webui-seed-1.json"), `${JSON.stringify(rec, null, 2)}\n`, "utf8");

    const server = createWebuiServer(); // NO options -> default runtimeDir must be runtimeRootDir()
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const { port } = server.address();
    try {
      const summary = await fetch(`http://127.0.0.1:${port}/api/summary`).then((r) => r.json());
      assert.ok((summary.total_runs ?? summary.total ?? 0) >= 1, "seeded record must be visible via /api/summary");
    } finally {
      await new Promise((res) => server.close(res));
    }
  } finally {
    if (prev === undefined) delete process.env.UTS_COMPUTING_HOME;
    else process.env.UTS_COMPUTING_HOME = prev;
  }
});
```

> Confirm the exact `/api/summary` field name (`total_runs` vs `total`) by reading the handler in `server.mjs`; the assertion tolerates both. Put env save/restore in try/finally (above) — do not rely on sibling-file ordering, since `webui/tests/webui.test.mjs:18` sets `UTS_COMPUTING_HOME` at module top-level.

- [ ] **Step 2: Run to verify failure.**

- [ ] **Step 3: Implement.** In `webui/server.mjs`:
  - Add import (next to the other `../mcp-server/dist/...` imports): `import { runtimeRootDir } from "../mcp-server/dist/core/paths.js";`
  - Line ~42: `const runtimeDir = options.runtimeDir ?? runtimeRootDir();`
  - CLI entry (~368): resolve `UTS_WEBUI_RUNTIME_DIR` if set and pass it:
    ```javascript
    const runtimeDirOverride = process.env.UTS_WEBUI_RUNTIME_DIR
      ? path.resolve(process.env.UTS_WEBUI_RUNTIME_DIR)
      : undefined;
    createWebuiServer({ ...(runtimeDirOverride ? { runtimeDir: runtimeDirOverride } : {}) })
      .listen(port, "127.0.0.1", () => { /* … */ });
    ```

- [ ] **Step 4: Run webui tests + full** — `npm test` (it includes `webui/tests/*.test.mjs`). Expected green; existing webui tests pass unchanged (they set `UTS_COMPUTING_HOME` and pass explicit dirs).

- [ ] **Step 5: Commit**

```bash
git add webui/server.mjs webui/tests/runtime-dir.test.mjs
git commit -m "fix(webui): default runtimeDir to runtimeRootDir() + UTS_WEBUI_RUNTIME_DIR override (W1)"
```

---

### Task 9: Policy + docs — enable cancel-of-adopted, finalize Phase 1

`docs/accounts-and-safety.md` currently lists "cancelling jobs this package did not create" as manual-only. C1 + C2 deliberately enable cancelling an **adopted** job (token-gated). Update the policy line to reflect that adopted jobs are cancellable via `jobs.cancel` with an approval token, annotated as "adopted, not plugin-originated". This is a required deliverable, not an aside.

**Files:**
- Modify: `docs/accounts-and-safety.md` (the line the spec cites at `:105`)
- Modify: `docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md` (tick Phase 1 items if it has a checklist), optional
- Modify: `README.md` / `mcp-server/README.md` tool tables if they enumerate the tool set (now 41)

- [ ] **Step 1:** Read `docs/accounts-and-safety.md` around the cited policy line; reword to: adopted external jobs may be cancelled through `jobs.cancel` once an approval token is configured; the action is recorded as acting on an adopted (non-plugin-originated) run. Keep the forbidden-behaviors section intact (no relaxation of the per-account-cap / no-rotation rules).
- [ ] **Step 2:** If `README.md` or `mcp-server/README.md` states a tool count or lists tools, update to 41 and add the three new tools with one-line descriptions.
- [ ] **Step 3:** Run `npm test` once more (docs-only, but confirm nothing references a stale count in a test).
- [ ] **Step 4: Commit**

```bash
git add docs/accounts-and-safety.md README.md mcp-server/README.md docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md
git commit -m "docs(safety): allow token-gated cancel of adopted jobs; note Phase 1 tool additions"
```

---

## Phase 1 exit criteria

- [ ] `npm test` green (baseline 391 + new tests; expect ~405+).
- [ ] Tool set is exactly 41, pinned by `tool-registration.test.mjs`.
- [ ] **Closed-world proof:** an integration test adopts a PBS job and shows it in `jobs.history` and the WebUI `/api/summary`.
- [ ] **No secrets:** `git grep` for the real account ids / hosts in tracked files returns nothing; the approval token exists only as `${user_config.approval_token}`.
- [ ] `ihpc.scheduler.version` returns `unknown` honestly against a node without the Phase 2 stamp, and `match`/`stale` against mocked stamped output (unit-tested).

## Deliberate deviations from the spec's literal Phase split (flag to the user)

1. **Python `--print-contract-version` moves to Phase 2.** The spec lists the stamp under Phase 1. It needs an in-repo home (the vendored `ihpc-scheduler/` tree) and a Python CI lane to be testable; both arrive in Phase 2. Phase 1 ships the TS half (contract primitives + the `ihpc.scheduler.version` tool that degrades to `unknown` gracefully), which is independently useful and fully unit-tested. Net: no capability is lost; the handshake is honest the day Phase 2 lands the stamp.
2. **iHPC `jobs.adopt` is history-only in Phase 1; PBS is fully unlocked.** Full iHPC reconciliation needs a synthesized `supervisor` block whose `metadata_path`/`stdout_path`/`stderr_path` pass `requireIhpcSupervisor`'s containment check against the profile roots — paths an externally-started `ihpc-sched` process does not expose. So an adopted iHPC run is **discoverable** (history/WebUI) but not status/log/cancel-reconcilable until **Phase 4** (iHPC supervision) builds proper observability. PBS adopt is the high-value path (the 2-HPC-account blindness this session) and is fully unlocked. This is honest and pinned by a test asserting the clear `/supervisor/` error.
3. **`login_host` disclosure (part of H4 in the spec) defers to Phase 3.** The spec's H4 goal also lists exposing the real `login_host`. That is a per-profile value (not an envelope-wide one) and is the natural companion of `access.doctor --export-ssh` + `login_host` in **Phase 3 (H5)**. Phase 1 delivers the envelope-wide `using_example_profiles` + `config_path` + loud stderr — enough for the agent to stop mistaking example-profile runs for VPN failures. `login_host` lands with the human-handoff work in Phase 3.
4. **H4 disclosure is delivered envelope-wide (via `safeTool`) plus loud stderr,** rather than threaded per-tool. This is the faithful reading of "mark every result," and `.passthrough()` makes it schema-safe (verified: `TOOL_OUTPUT_SCHEMA = z.object({ ok: z.boolean() }).passthrough()`, no whole-envelope `deepEqual` in the suite). If the full-suite run shows it destabilizes shape-strict tests, fall back to surfacing `config_status` only on `profiles.list` / `access.doctor` / `quotas.*` and note the reduced scope.
