# iHPC Internalization — Phase 2 (Vendor + Deploy) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the plugin the sole control plane for the on-node `ihpc-sched` scheduler: vendor a minimal, provenance-tracked copy of the scheduler as the deploy payload; give the scheduler a dependency-light contract-version stamp; enforce vendoring provenance + run the vendored Python tests in CI (the repo's first CI); and ship a token-gated, active-state-guarded, post-deploy-verified `ihpc.scheduler.deploy` tool — implemented and **mock-tested only, never run against a real node.**

**Architecture:** Repo-root `ihpc-scheduler/` holds the vendored subtree (per spec §11). A `sync-ihpc-scheduler.sh` script re-vendors from a pinned upstream SHA, applies our two documented additions (a dependency-light `_contract.py` + a `--print-contract-version` CLI hook), and regenerates a per-file provenance manifest. A Node `check-provenance.mjs` fails on any drift from that manifest; a Node `run-pytest.mjs` runs the vendored suite. A new `.github/workflows/ci.yml` runs the JS suite + provenance check + the Python lane on push/PR. The `ihpc.scheduler.deploy` TS tool reuses the Phase-1 `ihpc.scheduler.version` handshake and the existing `transfers` rsync path, gated by three independent locks.

**Tech Stack:** Python 3.11+ (vendored scheduler; hatchling, paramiko, pyyaml; pytest in CI), Node ESM scripts (mirroring `scripts/*.mjs` conventions), TypeScript MCP tool, GitHub Actions.

---

## Key design decisions (read first)

1. **Vendor location = repo-root `ihpc-scheduler/`** (spec §11), NOT `mcp-server/src/vendored/`. The vendored source is the deploy *payload* and **must ship inside the `.mcpb`** (so the installed plugin can rsync it) — so it must NOT be added to `.mcpbignore`'s exclusion of source. Only `ihpc-scheduler/tests/` may be excluded from the `.mcpb` (not needed on-node).
2. **Vendor scope = `src/scheduler/` + `src/scanner/` + scheduler `tests/` + `configs/*.example.yaml` + `pyproject.toml` + `README`/`LICENSE`.** The scheduler imports `..scanner.infra.ssh` / `..scanner.config` (verified), so scanner is mandatory. Exclude `.claude/agents/`, `docs/intro/`, `outputs/`, `.git/`, and the campaign `configs/queue.*.yaml` (keep only `*.example.yaml`).
   - **Import namespace is `src.` (load-bearing — verified):** upstream `pyproject.toml` sets `packages = ["src"]` and `[tool.pytest.ini_options] pythonpath = ["."]`, and every vendored test imports `from src.scheduler…` / `from src.scanner…` (e.g. `test_scheduler_lock.py:3`). So the vendored layout keeps `ihpc-scheduler/src/{scheduler,scanner}/`, the import root is `ihpc-scheduler/` (NOT `ihpc-scheduler/src`), and modules import as `src.scheduler.*`. Every sanity check / CI invocation MUST anchor at `ihpc-scheduler/` and import `src.scheduler…`, OR simply `cd ihpc-scheduler && python -m pytest tests` (which picks up `pythonpath = ["."]` automatically). Do NOT use `PYTHONPATH=ihpc-scheduler/src` + bare `scheduler` imports — it breaks the suite. (`_contract.py`'s own `from .state import STATE_VERSION` is a relative import and works either way.)
3. **Provenance model = "upstream SHA + documented local additions", verified by a per-file manifest.** Pure upstream `e6883a9` plus exactly two intentional additions (`src/scheduler/_contract.py`; a minimal `cli.py` hook). `UPSTREAM` records the repo URL + SHA + sync date + the list of local additions. `check-provenance.mjs` recomputes a sha256 manifest of the vendored tree and fails on any divergence from the committed manifest — catching *silent* edits while permitting the documented additions (which are part of the recorded baseline).
4. **The contract stamp is dependency-light and locally verifiable.** `state.py`/`lock.py` do NOT import `scanner`/`paramiko`. So `ihpc-scheduler/src/scheduler/_contract.py` imports only `from .state import STATE_VERSION` and reads two sync-written constants (`_VERSION`, `_GIT_SHA`). `contract_version()` returns `f"{_VERSION}+state{STATE_VERSION}+{_GIT_SHA}"` — emitting exactly the format `mcp-server/src/lib/ihpc-contract.ts` pins (`0.1.0+state2+e6883a9`). Its core is runnable with plain `python3 -c` (no paramiko); the CLI flag works on-node where paramiko is installed.
5. **The deploy tool never runs against a real node in this work.** All three locks are unit-tested with a mock executor. The active-state probe (Lock 2) runs the scheduler's own `ihpc-sched doctor`/`status` over SSH (which already reports `stale-active`) rather than guessing a state-file path (`state_path` is configured in `queue.yaml`).
6. **Conventions:** Node scripts mirror `scripts/validate-plugin-package.mjs` (shebang, ESM, `fileURLToPath(import.meta.url)`, `{ok, checked, issues}` JSON, `exit(1)` on failure, `isCli` guard). Adding a TS tool is the **5-touch** change from Phase 1 (handler, schema, `index.ts` TOOLS group, `tool-registration.test.mjs` name+count, `mcp-protocol.test.mjs` inventory+annotation). Commit per task; do not push (the controller batches the push to PR #3).

---

## Chunk 1: Vendor the scheduler + provenance + contract stamp

### Task 1: Vendoring + `sync-ihpc-scheduler.sh` + `UPSTREAM`

Produce the `ihpc-scheduler/` subtree from the upstream clone, via a re-runnable sync script that is the single source of vendoring truth.

**Files:**
- Create: `scripts/sync-ihpc-scheduler.sh`
- Create (generated): `ihpc-scheduler/UPSTREAM`, `ihpc-scheduler/src/{scheduler,scanner}/**`, `ihpc-scheduler/tests/**`, `ihpc-scheduler/configs/*.example.yaml`, `ihpc-scheduler/pyproject.toml`, `ihpc-scheduler/README.md`
- Modify: `.gitignore` (Python artifacts), `.mcpbignore` (exclude only `ihpc-scheduler/tests/`)

- [ ] **Step 1: Write `scripts/sync-ihpc-scheduler.sh`** (bash; the only shell script — wrap-invocable later). It takes `UPSTREAM_REPO` (default `git@github.com:mtics/uts-ihpc.git`), `SHA` (default `e6883a9`), and `SRC` (optional local clone path, default the env `IHPC_UPSTREAM_SRC` or a fresh shallow clone into a temp dir). It:
  1. Resolves a source tree at `SHA` (use `SRC` if a git worktree at that SHA, else `git clone --depth 1` + `git fetch` the SHA into a temp dir; `git -C <src> checkout <SHA>`).
  2. `rm -rf ihpc-scheduler/{src,tests,configs}` then copies: `src/scheduler/` → `ihpc-scheduler/src/scheduler/`, `src/scanner/` → `ihpc-scheduler/src/scanner/`, `src/__init__.py`, `tests/test_scheduler_*.py` → `ihpc-scheduler/tests/`, `configs/*.example.yaml` → `ihpc-scheduler/configs/`, `pyproject.toml`, `README*`/`LICENSE*` if present. EXCLUDE `.claude/`, `docs/`, `outputs/`, `.git/`, `configs/queue.*.yaml` (non-example), `__pycache__`.
  3. Applies the local additions (idempotent): writes `ihpc-scheduler/src/scheduler/_contract.py` (Task 2 provides the content; here just ensure the sync writes the `_VERSION`/`_GIT_SHA` constants from the resolved pyproject version + the pinned SHA), and applies the `cli.py` `--print-contract-version` hook (Task 2).
  4. Writes `ihpc-scheduler/UPSTREAM` (see Step 2).
  5. Regenerates the provenance manifest (Task 3 provides `check-provenance.mjs --write`); calls it.
  6. Prints a summary (files vendored, SHA, LOC).

  Keep remote argv quoted; no `bash -lc`; fail (`set -euo pipefail`) on any error.

- [ ] **Step 2: `UPSTREAM` format** — the script writes:
  ```
  repo: git@github.com:mtics/uts-ihpc.git
  sha: e6883a9
  synced_at: <ISO date passed in via env SYNC_DATE>
  vendored: src/scheduler, src/scanner, tests/test_scheduler_*.py, configs/*.example.yaml, pyproject.toml
  local_additions:
    - src/scheduler/_contract.py   (contract-version stamp; not upstream)
    - src/scheduler/cli.py         (added --print-contract-version hook; documented patch)
  ```
  (Pass `SYNC_DATE` in as an env var — do not call `date` so the script output is reproducible for review; the committer sets it.)

- [ ] **Step 3: Run the sync against the local clone** (`/tmp/uts-ihpc-research` is at `e6883a9`):
  ```bash
  IHPC_UPSTREAM_SRC=/tmp/uts-ihpc-research SYNC_DATE=2026-06-20 bash scripts/sync-ihpc-scheduler.sh
  ```
  Expected: `ihpc-scheduler/` populated; `git status` shows the new tree.

- [ ] **Step 4: Wire ignores.** Append to `.gitignore`: `__pycache__/`, `*.py[cod]`, `.pytest_cache/`, `.ruff_cache/`. Append to `.mcpbignore`: `ihpc-scheduler/tests/` (tests are not part of the deploy payload; the `src/` tree IS shipped). Do NOT exclude `ihpc-scheduler/src/`. (Note: `.mcpbignore` already ends with a blanket `*.md` rule, so the vendored `README.md` is excluded from the `.mcpb` anyway — harmless, since the README is not part of the rsync payload.)

- [ ] **Step 5: Sanity-check imports without paramiko** — confirm the dependency-light modules import (anchor at `ihpc-scheduler/`, `src.` namespace):
  ```bash
  python3 -c "import sys; sys.path.insert(0,'ihpc-scheduler'); from src.scheduler.state import STATE_VERSION; print('STATE_VERSION', STATE_VERSION)"
  ```
  Expected: `STATE_VERSION 2`. (Do NOT try to import `cli`/`scheduler`/`config` — they need paramiko.)

- [ ] **Step 6: Commit**
  ```bash
  git add scripts/sync-ihpc-scheduler.sh ihpc-scheduler/ .gitignore .mcpbignore
  git commit -m "feat(vendor): vendor ihpc-scheduler subtree @ e6883a9 + sync script (Phase 2)"
  ```

> **Reviewer focus:** the vendored tree must be scheduler+scanner (scanner is a hard dependency), example configs only (no campaign `queue.*.yaml`), and the `.mcpb` must still include `ihpc-scheduler/src/` (it is the payload). Confirm no real campaign data leaked in via `configs/`.

---

### Task 2: Dependency-light contract stamp (`_contract.py` + `cli.py` hook) + golden test

**Files:**
- Create: `ihpc-scheduler/src/scheduler/_contract.py`
- Modify: `ihpc-scheduler/src/scheduler/cli.py` (minimal hook)
- Create: `ihpc-scheduler/tests/test_scheduler_contract.py`
- Modify: `scripts/sync-ihpc-scheduler.sh` (write the `_VERSION`/`_GIT_SHA` constants — already referenced in Task 1)

- [ ] **Step 1: Write the golden test first** (`ihpc-scheduler/tests/test_scheduler_contract.py`):
  ```python
  import sys, pathlib, re
  # Anchor at ihpc-scheduler/ (parents[1]); the package root is `src` per pyproject packages=["src"].
  sys.path.insert(0, str(pathlib.Path(__file__).resolve().parents[1]))
  from src.scheduler._contract import contract_version, CONTRACT_RE

  def test_contract_version_matches_the_pinned_format():
      v = contract_version()
      assert CONTRACT_RE.match(v), f"{v!r} must match {CONTRACT_RE.pattern}"
      # version + state + 7-40 lowercase hex sha
      assert "+state" in v and v.count("+") == 2

  def test_contract_version_components():
      from src.scheduler.state import STATE_VERSION
      v = contract_version()
      assert f"+state{STATE_VERSION}+" in v
  ```

- [ ] **Step 2: Implement `_contract.py`** (imports ONLY `state`, never `scanner`):
  ```python
  """Contract version stamp. Dependency-light on purpose: imports only .state so it can be
  evaluated without paramiko/pyyaml (the TS-side ihpc.scheduler.version handshake pins this exact
  format). _VERSION and _GIT_SHA are written by scripts/sync-ihpc-scheduler.sh at vendor time —
  the vendored tree has no .git, so the sha cannot be derived at runtime."""
  import re
  from .state import STATE_VERSION

  # Written by the sync script from the upstream pyproject version + the pinned UPSTREAM sha.
  _VERSION = "0.1.0"
  _GIT_SHA = "e6883a9"

  CONTRACT_RE = re.compile(r"^(\d+\.\d+\.\d+)\+state(\d+)\+([0-9a-f]{7,40})$")

  def contract_version() -> str:
      return f"{_VERSION}+state{STATE_VERSION}+{_GIT_SHA}"
  ```

- [ ] **Step 3: Add the `cli.py` hook.** In `ihpc-scheduler/src/scheduler/cli.py`, add `--print-contract-version` so it short-circuits in `main()` BEFORE any heavy/remote work. Because `cli.py`'s top-level imports pull in `scanner` (paramiko), the on-node CLI naturally has paramiko; the hook just needs to print and exit early in `main()`:
  - In `build_parser()` add `p.add_argument("--print-contract-version", action="store_true", help="Print the scheduler contract version and exit")`.
  - At the very top of `main()` (after `args = parser.parse_args(argv)`), add:
    ```python
    if getattr(args, "print_contract_version", False):
        from ._contract import contract_version
        print(contract_version())
        return
    ```
  Keep the patch minimal and clearly the only `cli.py` change (recorded in `UPSTREAM` local_additions).

- [ ] **Step 4: Make the sync script write the constants.** In `sync-ihpc-scheduler.sh`, after copying, regenerate `_contract.py` from a heredoc template substituting the resolved pyproject `version` and the pinned `SHA` (no `sed -i` — BSD sed in-place differs; see repo memory). **Heredoc caution:** the regex body contains `\d`, `\+`, and `$` anchors that the shell would mangle, so emit the file in two parts: (a) the two constant lines via an UNquoted heredoc or `printf` that substitutes `$VERSION`/`$SHA`, and (b) the imports + `CONTRACT_RE` + `contract_version()` body via a QUOTED heredoc (`cat <<'PYEOF'`) so nothing expands. Example:
  ```bash
  {
    printf '"""Contract version stamp (dependency-light; written by sync). See plan."""\n'
    printf 'from .state import STATE_VERSION\n'
    printf '_VERSION = "%s"\n' "$VERSION"
    printf '_GIT_SHA = "%s"\n' "$SHA"
    cat <<'PYEOF'
import re
CONTRACT_RE = re.compile(r"^(\d+\.\d+\.\d+)\+state(\d+)\+([0-9a-f]{7,40})$")
def contract_version() -> str:
    return f"{_VERSION}+state{STATE_VERSION}+{_GIT_SHA}"
PYEOF
  } > ihpc-scheduler/src/scheduler/_contract.py
  ```
  This keeps the stamp truthful to whatever SHA is vendored and avoids shell-expansion of the regex.

- [ ] **Step 5: Verify locally without paramiko** (anchor at `ihpc-scheduler/`, import `src.scheduler`)
  ```bash
  python3 -c "import sys; sys.path.insert(0,'ihpc-scheduler'); from src.scheduler._contract import contract_version; print(contract_version())"
  ```
  Expected: `0.1.0+state2+e6883a9`. Cross-check it equals `EXPECTED_SCHEDULER_CONTRACT` in `mcp-server/src/lib/ihpc-contract.ts`.

- [ ] **Step 6: Commit**
  ```bash
  git add ihpc-scheduler/src/scheduler/_contract.py ihpc-scheduler/src/scheduler/cli.py ihpc-scheduler/tests/test_scheduler_contract.py scripts/sync-ihpc-scheduler.sh
  git commit -m "feat(scheduler): dependency-light --print-contract-version stamp (C3 Python side)"
  ```

---

### Task 3: Provenance check (`check-provenance.mjs`) + npm script

**Files:**
- Create: `scripts/check-provenance.mjs`
- Create (generated): `ihpc-scheduler/PROVENANCE.json` (per-file sha256 manifest)
- Modify: `package.json` (script `check:provenance`)
- Modify: `scripts/sync-ihpc-scheduler.sh` (call `node scripts/check-provenance.mjs --write`)

- [ ] **Step 1: Implement `check-provenance.mjs`** (ESM, mirrors `validate-plugin-package.mjs`):
  - Exported `checkProvenance(root = repoRoot, { write = false } = {})`:
    - Walk `ihpc-scheduler/` (exclude `tests/__pycache__`, `*.pyc`, `PROVENANCE.json` itself), compute sha256 of each file → `{ path: sha256 }`.
    - If `write`: serialize sorted manifest to `ihpc-scheduler/PROVENANCE.json` (with `{ upstream_sha, generated_files: {...} }`, reading `upstream_sha` from `UPSTREAM`).
    - Else: read the committed `PROVENANCE.json`, recompute, diff. Return `{ ok, upstream_sha, issues: [{code:'provenance-drift', path, message}] }` for any added/removed/changed file. Also assert `UPSTREAM` `sha` matches `PROVENANCE.json.upstream_sha`.
  - `isCli` guard: `--write` flag; print JSON; `exit(1)` if `!ok`.
- [ ] **Step 2: Add `"check:provenance": "node scripts/check-provenance.mjs"`** to `package.json` scripts.
- [ ] **Step 3: Generate the manifest** via the sync script (`--write`) and confirm `node scripts/check-provenance.mjs` passes:
  ```bash
  node scripts/check-provenance.mjs --write && node scripts/check-provenance.mjs && echo "PROVENANCE OK"
  ```
- [ ] **Step 4: Prove drift detection** — touch a vendored file, run the check, expect `exit 1` + a `provenance-drift` issue; then restore it.
- [ ] **Step 5: Commit**
  ```bash
  git add scripts/check-provenance.mjs ihpc-scheduler/PROVENANCE.json package.json scripts/sync-ihpc-scheduler.sh
  git commit -m "feat(vendor): per-file provenance manifest + check (Phase 2)"
  ```

---

## Chunk 2: CI lane + the deploy tool

### Task 4: Python test runner + GitHub Actions CI

**Files:**
- Create: `scripts/run-pytest.mjs`
- Create: `.github/workflows/ci.yml`
- Modify: `package.json` (script `test:python`)

- [ ] **Step 1: `run-pytest.mjs`** (ESM): spawn pytest **with cwd `ihpc-scheduler/`** so the copied `pyproject.toml`'s `pythonpath = ["."]` makes `import src.scheduler…` resolve — i.e. `spawn("python3", ["-m", "pytest", "tests", "-q"], { cwd: <repo>/ihpc-scheduler })`. Do NOT set `PYTHONPATH=ihpc-scheduler/src` and do NOT `pip install -e` (both expose the wrong import namespace and break the vendored `from src.scheduler…` imports). Capture exit code; print a `{ ok, checked, issues }` summary; `exit(1)` on failure. If pytest is unavailable, print a clear `{ ok:false, issues:[{code:'pytest-missing'}] }` and exit 1 (CI fails loudly; locally a dev sees the guidance). Add `"test:python": "node scripts/run-pytest.mjs"`.
- [ ] **Step 2: `.github/workflows/ci.yml`** — the repo's first CI. Two jobs:
  - `js`: `actions/setup-node` (Node 22) → `npm ci` → `npm test` → `node scripts/check-provenance.mjs`.
  - `python`: `actions/setup-python` (3.11) → `pip install pytest pyyaml paramiko` → `cd ihpc-scheduler && python -m pytest tests -q` (relies on the vendored `pyproject.toml` `pythonpath = ["."]`; imports resolve as `src.scheduler.*`). Do NOT `pip install -e` or set `PYTHONPATH=.../src`.
  - Trigger: `on: [push, pull_request]`.
  - Keep it minimal and pinned (action versions pinned to a major).
- [ ] **Step 3: Local sanity** — `node scripts/run-pytest.mjs` will likely report `pytest-missing` in this environment; that is expected and acceptable (the CI job is the enforcement). Confirm the script exits non-zero with the clear message, and that `ci.yml` is valid YAML (`node -e "require('fs').readFileSync('.github/workflows/ci.yml','utf8')"` + a yaml parse via the repo's `yaml` dep).
- [ ] **Step 4: Commit**
  ```bash
  git add scripts/run-pytest.mjs .github/workflows/ci.yml package.json
  git commit -m "ci: add GitHub Actions (JS + provenance + vendored pytest lane) (Phase 2)"
  ```

> **Note to controller:** pushing this updates PR #3 and triggers the new CI on GitHub. The Python job verifies the vendored suite (which passes upstream @ `e6883a9`); if the CI environment surfaces a dep/version issue, fix forward in a follow-up commit.

---

### Task 5: `ihpc.scheduler.deploy` tool (three locks) — mock-tested only

**Files:**
- Create: `mcp-server/src/ops/data/scheduler-deploy.ts`
- Modify: `mcp-server/src/index.ts` (import + TOOLS entry), `mcp-server/src/mcp/schemas.ts` (reuse fields)
- Modify: `mcp-server/tests/integration/tool-registration.test.mjs` + `mcp-server/tests/integration/mcp-protocol.test.mjs` (5-touch; count 41 → 42)
- Test: `mcp-server/tests/ops/scheduler-deploy.test.mjs`

- [ ] **Step 1: Write the failing tests** (mock executor; never a real node). Cover, in order:
  1. **Lock 1 — token:** missing `UTS_COMPUTING_APPROVAL_TOKEN`/wrong token → rejects with the same messages as other token-gated tools (reuse `assertConfirmationToken`); no SSH attempted.
  2. **Lock 2 — active-state:** mock `ihpc-sched status --json` returning a FRESH `heartbeat_at` (e.g. `now - 60s`) with running/pending `counts > 0` → deploy **refuses** (no rsync executed); assert the mock rsync was never called. Add a second case: a STALE `heartbeat_at` (e.g. `now - 7200s`) ⇒ treated as safe (deploy proceeds).
  3. **Happy path:** token ok + probe returns dormant (stale/absent heartbeat) → rsync invoked once → post-deploy `ihpc.scheduler.version` mock returns the pinned contract → result `ok:true`, `post_deploy_verdict:"match"`.
  4. **Lock 3 — post-deploy verify:** token ok + dormant + rsync ok, but the post-deploy version mock returns a STALE contract → deploy result `ok:false` with a clear "deployed but verification failed" summary.
  Use a single mock executor that dispatches by argv (`ssh ... ihpc-sched status --json`, `rsync ...`, `ssh ... ihpc-sched --print-contract-version`) and records call order. Pass a fixed `now` so the 900s heartbeat check is deterministic.

- [ ] **Step 2: Implement `deployScheduler()`** in `scheduler-deploy.ts`:
  - Validate the profile is iHPC (mirror `scheduler-version.ts`).
  - **Lock 1:** `assertConfirmationToken(input.confirmationToken, options.confirmationToken, { missingMessage, mismatchMessage })`.
  - **Lock 2 — active-state (corrected):** `probeSchedulerActive(profile, timeoutMs, executor)` → SSH `ihpc-sched status --json` (the `--json` path emits `_state_summary` with `heartbeat_at` + running/pending `counts`; the plain/`doctor` paths print human dashboards with no parseable verdict — do NOT use them). Apply the spec §9 rule **client-side**: parse `heartbeat_at`; if it is present AND fresher than the 900s staleness threshold AND there is running/pending work, the scheduler is **active** → throw `Refusing to deploy: an active scheduler is running on <host> (heartbeat <N>s ago). Stop it first.` Note the semantics: a *fresh* heartbeat means active (refuse); `stale-active` (>900s) is the dormant-ish case. SSH failure, no queue/auto-detect failure, empty state, or a stale heartbeat ⇒ treat as "safe to deploy". (The 900s constant should mirror the scheduler's `cli.py:1115`; define it as a named constant.)
  - **Rsync (build argv directly — do NOT route through `executeTransfer`):** the deploy payload (`ihpc-scheduler/src/`) is NOT inside a profile workspace/scratch/project root, so `transfer.ts`'s `rsyncArgs`/`executeTransfer` path guards (`assertRemoteRootInsideProfile`, runtime-dir containment) **reject it**. Reuse only the *shape*: build `rsync -a --checksum --files-from=- -e "ssh <outer-hop-flags>" <localPayloadDir> <host>:<remoteSchedulerDir>` and feed the file list via stdin. **Executor seam:** use the 4-arg `TransferExecutor` type `(program, args, timeoutMs, stdin?)` (from `transfer.ts`) for this tool rather than the 3-arg `SchedulerCommandExecutor`, so rsync's `--files-from=-` stdin works; the post-deploy version check (Lock 3) just calls it with no stdin.
  - **Lock 3 — post-deploy verify:** immediately call `schedulerVersion({ profileId }, { executor, timeoutMs })` (it accepts an injected executor); if `verdict !== "match"`, return `ok:false` with a "deployed but verification failed" summary; never "deploy and forget".
  - Return `{ scheduler: { profile_id, deployed_at, post_deploy_verdict, verified_contract, ok, summary } }`. Write an evidence record (mirror `transfer.ts` evidence) but **never** include the token.
- [ ] **Step 3: Register** the tool (annotation `ANNOTATIONS_DESTRUCTIVE_REMOTE`, like `jobs.cancel`); input `strictInput({ profileId: PROFILE_ID, confirmationToken: z.string().min(1), timeoutMs: timeoutMsField(...) })`. Apply the **5-touch** (TOOLS group, `tool-registration.test` name + count 41→42, `mcp-protocol.test` inventory + annotation). **Match the existing `mcp-protocol.test` annotation shape, which pins only THREE fields** (like `jobs.cancel` at `mcp-protocol.test.mjs:611`): `{ readOnlyHint: false, destructiveHint: true, openWorldHint: true }` (no `idempotentHint` in the test entry, even though the `index.ts` `ANNOTATIONS_DESTRUCTIVE_REMOTE` const carries all four).
- [ ] **Step 4: Run targeted + full suite** — `npm run build && node --test mcp-server/tests/ops/scheduler-deploy.test.mjs && npm test`. All green.
- [ ] **Step 5: Commit**
  ```bash
  git add mcp-server/src/ops/data/scheduler-deploy.ts mcp-server/src/index.ts mcp-server/src/mcp/schemas.ts \
    mcp-server/tests/ops/scheduler-deploy.test.mjs mcp-server/tests/integration/tool-registration.test.mjs mcp-server/tests/integration/mcp-protocol.test.mjs
  git commit -m "feat(ihpc): add ihpc.scheduler.deploy with three locks (mock-tested) (C3/internalization)"
  ```

> **Safety (load-bearing):** there is NO step in this plan that runs `deployScheduler` against a real host. Every test uses a mock executor. The tool must never be invoked with a real profile during development.

---

### Task 6: Docs + README + spec ticks

**Files:**
- Modify: `README.md` / `mcp-server/README.md` (tool count 41 → 42; add `ihpc.scheduler.deploy`; document the `ihpc-scheduler/` vendored tree + `npm run check:provenance` / `test:python` / the sync script + CI)
- Modify: `docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md` (note Phase 2 delivered; the provenance "upstream + documented additions" model)

- [ ] **Step 1:** Update READMEs: tool inventory (42), the vendoring/provenance/CI workflow, and how to re-vendor (`IHPC_UPSTREAM_SRC=… SYNC_DATE=… bash scripts/sync-ihpc-scheduler.sh`).
- [ ] **Step 2:** Add a short "Phase 2 delivered" note to the spec; record the provenance model decision (manifest of upstream + two documented additions).
- [ ] **Step 3:** `npm test` (docs-only; ensure no stale count assertion). Commit `docs(ihpc): document the vendored scheduler, provenance, CI, and deploy tool (Phase 2)`.

---

## Phase 2 exit criteria

- [ ] `ihpc-scheduler/` vendored (scheduler+scanner+tests+example configs), `UPSTREAM` + `PROVENANCE.json` present; `node scripts/check-provenance.mjs` passes and detects drift.
- [ ] `python3 -c "...contract_version()"` prints `0.1.0+state2+e6883a9` == `EXPECTED_SCHEDULER_CONTRACT`.
- [ ] `.github/workflows/ci.yml` runs JS suite + provenance + the vendored pytest on PR #3 (the repo's first CI). (Python suite is CI-verified, not locally run — see deviations.)
- [ ] `ihpc.scheduler.deploy` registered (tool count 42), three locks unit-tested with mocks, **never run against a real node**. Full JS suite green.
- [ ] `.mcpb` still includes `ihpc-scheduler/src/` (deploy payload); `.gitignore` excludes Python build artifacts; no campaign data vendored.

## Deliberate deviations / notes

1. **The vendored Python tests are CI-verified, not locally run** (this dev environment lacks `pytest`/`pyyaml`/`paramiko`, and `paramiko` needs a crypto build on Python 3.14). The contract-stamp *logic* is locally verified via plain `python3`. CI (Task 4) is the enforcement for the full suite.
2. **The `cli.py` `--print-contract-version` hook is a documented vendored addition,** recorded in `UPSTREAM.local_additions` and covered by the provenance manifest — provenance forbids *silent* edits, not intentional recorded additions. The cleanest long-term fix is to upstream the stamp into `mtics/uts-ihpc` and re-vendor at the new SHA (future work).
3. **The deploy tool's active-state probe uses `ihpc-sched status --json`** (parsing `heartbeat_at` + running/pending counts and applying the 900s freshness rule client-side), not a fixed state-file path (`state_path` is config-driven) and not the human-readable `doctor`/`status` dashboards (which don't emit a parseable verdict). A *fresh* heartbeat with pending/running work ⇒ active ⇒ refuse; stale/absent/SSH-failure ⇒ safe. On a fresh node with no scheduler, the probe returns "dormant" (safe to deploy).
