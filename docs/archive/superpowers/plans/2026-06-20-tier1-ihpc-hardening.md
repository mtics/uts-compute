# Tier 1 iHPC Hardening Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: use `superpowers:subagent-driven-development` (recommended) or `superpowers:executing-plans` to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. This plan assumes ZERO context from the conversation that produced it; everything needed is below or in the linked audit.

**Goal:** Land six cheap, high-leverage hardening fixes that close the realistic failure modes from the 2026-06-19 cross-platform HPO submission, WITHOUT building the large "plugin-owns-the-scheduler" internalization (that is a separate, deferred Tier 2 decision).

**Architecture:** Two independent tracks. Track A hardens the on-node Python scheduler `ihpc-sched` (the live launch path). Track B adds read-only / guard-rail capabilities to the `uts-compute` TypeScript MCP plugin so the in-flight campaign becomes observable and future misuse is blocked. The tracks share no code and can be executed in parallel by two sessions.

**Tech stack:** Track A = Python 3.11+, `paramiko`/`pyyaml`, `pytest`, `uv`. Track B = TypeScript/Node, MCP SDK, `ajv`, `vitest`. The plugin has a `UTS_COMPUTING_TEST_MODE` seam so tests never touch a real node; reuse it.

**Background (read first):** `docs/AUDIT_2026-06-19_ihpc-sched-internalization.md` (this repo). The problem ids P1–P10 referenced below are defined there in §2. The adversarial review in §6 already corrected two mistakes that this plan bakes in: (i) do NOT reframe the command as an execve `argv` list — the real queue command is an irreducible shell pipeline (`source && conda activate && cd && export && python ...`), so the only correct P3 fix is the wrapper-file transport plus a byte-faithful golden test; (ii) prefer a HARD block over a WARN for P1.

**Repos / locations:**
- Track A repo: `git@github.com:mtics/uts-ihpc.git`, branch `codex/minimal-scheduler-entities` (the correct, deployed branch; `origin/main` is the old broken one). On-node checkouts live at `/data/<account>/Workspace/uts-ihpc`. A clean local clone for development: `git clone … && git checkout codex/minimal-scheduler-entities`.
- Track B repo: this repo (`uts-computing-platform`), code under `mcp-server/src/`.

---

## Execution notes

- Each task below is independently shippable and independently testable. Recommended order within a track is top-to-bottom, but only A2→A-self-check and A2↔B1 have a soft dependency (B1 consumes the version string A2 emits).
- **Never run against a real cluster node in CI.** Track A tests stub SSH (the submitter already has `tests/test_scheduler_submitter.py` patterns to follow). Track B tests set `UTS_COMPUTING_TEST_MODE` and use the mock-executor fixtures under `mcp-server/tests/fixtures/`.
- Do NOT change scheduler placement semantics, do NOT auto-deploy, do NOT touch the running 42-study campaign's queues/state. These are guard-rails and read-only observers only.

---

## Track A — ihpc-sched (Python, `uts-ihpc`)

### Task A1: P3 — byte-faithful transport golden test + no-shell lint

**Why:** The old `submitter.py` built `bash -lc '{cmd}'`; a single quote inside `--param_overrides '{"k":"v"}'` closed the outer quote and main.py got an empty string → `JSONDecodeError`. The fix (base64 wrapper file in `remote_command.build_submission_command`) already exists at HEAD. This task makes the fix permanent: a golden test proving arbitrary single-quoted JSON survives byte-for-byte, and a lint making the broken pattern unrepresentable so it cannot regress.

**Files:**
- Modify/Read: `src/scheduler/remote_command.py` (the `build_wrapper_script` / `build_submission_command` functions — confirm they base64-encode the wrapper).
- Test: `tests/test_scheduler_remote_command.py` (create) and extend `tests/test_scheduler_submitter.py`.
- Create: `tests/test_no_inline_shell.py` (the lint-as-test).

- [ ] **Step 1 — Golden round-trip test.** Write a test that calls `build_submission_command` (or the lowest function that produces the remote command) with a realistic cell command containing the exact campaign payload:
  ```python
  CMD = ("source /x/conda.sh && conda activate FedVLR && cd /repo && "
         "export OMP_NUM_THREADS=2 && python main.py --model MMFedAvg --dataset Cards "
         "--gpu_id 0 --smart_hpo --comment lin.SANE "
         "--param_overrides '{\"adapter\":\"SANE\",\"parameter_space\":{\"sane_residual_budget\":{\"type\":\"choice\",\"values\":[0.0,16.0]}}}'")
  ```
  The remote command base64-encodes a wrapper; decode the base64 payload the same way the node would (`base64 -d`) and assert the decoded wrapper contains `CMD` **byte-for-byte** (the single-quoted JSON intact). Assert there is NO `bash -lc '` + raw-command construction anywhere in the produced remote string.
- [ ] **Step 2 — Run, expect PASS** (the fix already exists): `uv run pytest tests/test_scheduler_remote_command.py -v`. If it FAILS, the wrapper transport regressed — stop and report; do not "fix" by re-introducing inline shell.
- [ ] **Step 3 — No-shell lint test.** Write `tests/test_no_inline_shell.py` that greps every `.py` under `src/scheduler/` for the forbidden patterns (`bash -lc`, `sh -c` with an f-string/`.format`/`%`/`+`-built command argument) and fails listing offenders. Exempt the wrapper-file launcher line in `remote_command.py` (it runs the wrapper FILE: `setsid nohup bash -l <wrapper_path>` — that is the safe form; match on the absence of an inline command string after `-lc`/`-c`).
- [ ] **Step 4 — Run, expect PASS** on the current tree (no inline-shell offenders remain at HEAD).
- [ ] **Step 5 — Commit.**
  ```bash
  git add tests/test_scheduler_remote_command.py tests/test_no_inline_shell.py tests/test_scheduler_submitter.py
  git commit -m "test(scheduler): byte-faithful param_overrides transport golden + no-inline-shell lint (P3)"
  ```

**Acceptance:** Both tests green on HEAD; deliberately editing `remote_command.py` back to an inline `bash -lc '{cmd}'` makes BOTH tests fail.

---

### Task A2: P2 — scheduler version stamp, `--print-contract-version`, self-staleness doctor check

**Why:** The keystone failure was two accounts silently running different scheduler code (stale `git pull`). There is no version pin or self-check. This task makes the running version visible and lets any consumer (Track B / a human / `doctor`) detect staleness fail-closed.

**Files:**
- Modify: `src/scheduler/config.py` (add a module-level `SCHEDULER_VERSION` derived from `pyproject.toml` version + short git commit; expose a `scheduler_version()` helper).
- Modify: `src/scheduler/cli.py` (add a top-level `--print-contract-version` flag/subcommand that prints `scheduler_version()` and exits 0; add a `doctor` line reporting it and, if an `EXPECTED_SCHEDULER_VERSION` env var is set, a staleness verdict).
- Modify: `src/scheduler/state.py` (write `scheduler_version` into the state heartbeat block alongside the existing `heartbeat_at`/`scheduler_pid`).
- Test: `tests/test_scheduler_config.py`, `tests/test_scheduler_cli.py`, `tests/test_scheduler_state.py`.

- [ ] **Step 1 — Version source test + impl.** Test that `scheduler_version()` returns a non-empty `"<pyproject-version>+<gitshort>"` string (git part optional/`unknown` when not a repo). Implement reading `pyproject.toml` version (already parsed elsewhere, or `importlib.metadata`) + `git rev-parse --short HEAD` with a safe fallback to `"unknown"` (no try/except that hides a real error — only catch the not-a-git-repo case explicitly).
- [ ] **Step 2 — `--print-contract-version` test + impl.** Test invoking the CLI with `--print-contract-version` prints the version and exits 0 without touching nodes/state.
- [ ] **Step 3 — Heartbeat stamp test + impl.** Test that `SchedulerState.refresh_heartbeat()` (or wherever the heartbeat is written) records `scheduler_version`. Bump `STATE_VERSION` only if the schema change is not backward-readable; prefer an additive optional field so old states still load.
- [ ] **Step 4 — Self-staleness in `doctor`.** Test: with env `EXPECTED_SCHEDULER_VERSION` set to a DIFFERENT value, `doctor` prints a clearly-marked `STALE: running <x>, expected <y>` line and exits non-zero; with it equal or unset, `doctor` is unaffected. This is fail-closed when an expectation is provided.
- [ ] **Step 5 — Run all:** `uv run pytest tests/test_scheduler_config.py tests/test_scheduler_cli.py tests/test_scheduler_state.py -v`.
- [ ] **Step 6 — Commit.**
  ```bash
  git commit -am "feat(scheduler): version stamp + --print-contract-version + fail-closed staleness doctor (P2)"
  ```

**Acceptance:** `ihpc-sched --print-contract-version` prints `<ver>+<sha>`; a node whose `EXPECTED_SCHEDULER_VERSION` disagrees is reported STALE by `doctor` with non-zero exit; the running version appears in the state heartbeat.

---

### Task A3: P5 — surface legacy-state refusal in-band on start

**Why:** A legacy global `scheduler_state.json` correctly blocks startup, but the only symptom was an instantly-dying tmux session; the reason was reachable only by separately running `doctor` and manually `mv`-archiving. Make the refusal loud and actionable at the point of `start`.

**Files:**
- Modify: `src/scheduler/cli.py` (`_cmd_start` and the `tmux start` wrapper / `_blocking_state_issues`).
- Test: `tests/test_scheduler_cli.py`.

- [ ] **Step 1 — Test the surfaced message.** Simulate a legacy/blocking state present; assert that `start` (non-tmux) exits non-zero AND prints a single clearly-formatted, actionable block naming the offending file path(s) and the exact remedy command (`ihpc-sched --queue <Q> migrate-state --execute` or the archive step), rather than only raising.
- [ ] **Step 2 — Test the tmux path surfaces too.** For `tmux start`, assert that when the pre-flight blocking check fails, the command refuses BEFORE creating a tmux session (so there is no silently-dying pane) and prints the same actionable block to the caller's stdout/stderr. (Do not start a session that will immediately die.)
- [ ] **Step 3 — Implement** the pre-tmux blocking check + the formatted message. Reuse the existing `_blocking_state_issues` / `doctor` reason strings; do not duplicate the detection logic.
- [ ] **Step 4 — Run:** `uv run pytest tests/test_scheduler_cli.py -v`.
- [ ] **Step 5 — Commit.**
  ```bash
  git commit -am "fix(scheduler): surface legacy-state refusal with actionable remedy before tmux start (P5)"
  ```

**Acceptance:** With a legacy state present, `tmux start` prints a named-file + remedy block and creates no tmux session; with clean state it is unchanged.

---

## Track B — uts-compute plugin (TypeScript)

> Before starting Track B, read: `mcp-server/src/index.ts` (the 38-tool `TOOLS` registry + `safeTool` + `ToolHints`), `mcp-server/src/ops/jobs/jobs.ts` (qstat parsing, RunRecord update, `assertAllowedHpcJobRemoteArgv`), `mcp-server/src/ops/jobs/sweep.ts` + `ihpc-start.ts` (the iHPC paths), `mcp-server/src/core/audit.ts` (RunRecord lifecycle), `mcp-server/src/core/access.ts` + `core/config.ts` (host_alias / username_ref), `mcp-server/src/lib/ssh.ts`. Mirror existing patterns; the CI guard `lint-no-dup-lib-defs` forbids redefining `lib/` primitives.

### Task B1: P2 (consumer) — read-only iHPC scheduler version handshake

**Why:** Companion to A2. A read-only tool that SSHes to a profile's session node, runs `ihpc-sched --print-contract-version`, and compares to the plugin's expected pin — fail-closed (unknown/mismatch = hard `ok:false`). This is the minimal consumer; it does NOT deploy or drive the scheduler (that is Tier 2).

**Files:**
- Create: `mcp-server/src/ops/jobs/scheduler-version.ts` (the op).
- Modify: `mcp-server/src/index.ts` (register tool `ihpc.scheduler.version_check`, hint `READ_REMOTE`).
- Config: add `expected_scheduler_version` as an optional per-profile field (read in `core/config.ts`); if unset, the tool REPORTS the running version without a verdict (it cannot fail-closed without an expectation).
- Test: `mcp-server/tests/ops/scheduler-version.test.ts`.

- [ ] **Step 1 — Test (mock SSH).** With the mock executor returning a version string: (a) equal to `expected_scheduler_version` → `ok:true, status:'current'`; (b) different → `ok:false, status:'stale'` with both versions; (c) command-not-found / empty → `ok:false, status:'unknown'` (fail-closed). Use the allowlisted argv form (`ihpc-sched --print-contract-version`) and the existing two-hop SSH transport (`shell:false`).
- [ ] **Step 2 — Implement** over `lib/ssh.ts`; add `ihpc-sched --print-contract-version` to the iHPC remote-argv allowlist (mirror `assertAllowedHpcJobRemoteArgv`). No state writes; pure read.
- [ ] **Step 3 — Run:** `npm test -- scheduler-version`.
- [ ] **Step 4 — Commit:** `feat(jobs): read-only iHPC scheduler version handshake, fail-closed (P2 consumer)`.

**Acceptance:** Tool returns `current`/`stale`/`unknown`; `stale` and `unknown` are `ok:false`; never deploys or mutates.

---

### Task B2: P1 — hard-block multi-cell sweeps on the GPU-blind backend

**Why:** The naive driver oversubscribed because the only "sanctioned" iHPC path (`ihpc-start.ts`) is a single GPU-blind `Popen` with no slot accounting. A multi-GPU sweep must NOT be routed through it. Today `sweep.ts` already throws on non-HPC; this task closes the symmetric hole and upgrades any WARN to a hard refusal.

**Files:**
- Modify: `mcp-server/src/ops/jobs/sweep.ts` (confirm/keep the PBS-only guard with a clear error).
- Modify: `mcp-server/src/ops/jobs/ihpc-start.ts` (reject when the request carries sweep/multi-cell intent — e.g. a `cells`/`sweep` field or `count>1`).
- Test: `mcp-server/tests/ops/sweep.test.ts`, `mcp-server/tests/ops/ihpc-start.test.ts`.

- [ ] **Step 1 — Tests.** (a) `sweep.*` with `platform: 'uts-ihpc'` → `ok:false` with a message pointing to the (future) iHPC-sweep path, not a stack trace. (b) `ihpc-start` invoked with multi-cell/sweep intent → `ok:false` HARD refusal naming the reason ("GPU-blind single-process backend cannot place a multi-GPU sweep; one cell per call").
- [ ] **Step 2 — Implement** the explicit guards (throw a typed error caught by `safeTool` into `ok:false`). Do NOT silently warn-and-continue.
- [ ] **Step 3 — Run:** `npm test -- sweep ihpc-start`.
- [ ] **Step 4 — Commit:** `fix(jobs): hard-block multi-cell sweeps on GPU-blind iHPC backend (P1)`.

**Acceptance:** Neither path can launch a multi-GPU sweep through GPU-blind placement; the refusal is a clean `ok:false`.

---

### Task B3: P6 — adopt externally-launched PBS jobs into run-records (read-only)

**Why:** The real campaign was launched by raw `hpo_submit.sh → qsub`, so the plugin holds no RunRecords and `jobs_history`/`jobs_status` show nothing. This task lets the plugin OBSERVE jobs it did not submit, making the in-flight campaign visible without changing the launch path.

**Files:**
- Create: `mcp-server/src/ops/jobs/adopt.ts` (`jobs.adopt_pbs`).
- Modify: `mcp-server/src/index.ts` (register tool, hint `READ_REMOTE` — it WRITES local run-records but performs no remote mutation; classify per existing conventions, likely a local-write + remote-read hint).
- Reuse: the `qstat -x -f` parser and RunRecord synthesis in `ops/jobs/jobs.ts` + `core/audit.ts` (`buildRunRecord`/`updateRunRecord`, optimistic-concurrency rev). Do NOT duplicate the parser.
- Test: `mcp-server/tests/ops/adopt.test.ts`.

- [ ] **Step 1 — Test (mock qstat).** Given a mock `qstat -x -f` listing N jobs for a profile, the tool creates/updates one RunRecord per job (`remote_job_id`, `platform:'uts-hpc'`, status mapped from `job_state`, queue, exec_host), tagged `origin:'adopted'`, and is IDEMPOTENT (running it twice does not duplicate or regress terminal states — reuse the terminal-state clamp). Jobs already tracked by a real RunRecord are matched by `remote_job_id` and updated, not duplicated.
- [ ] **Step 2 — Implement** over `lib/ssh.ts` (allowlisted `qstat -x -f`) + `core/audit.ts`. Mark adopted records so they are distinguishable from natively-planned ones.
- [ ] **Step 3 — Run:** `npm test -- adopt`.
- [ ] **Step 4 — Commit:** `feat(jobs): adopt external PBS jobs into run-records for observability (P6)`.

**Acceptance:** After `jobs.adopt_pbs` on a profile with live `qsub` jobs, `jobs_history`/`jobs_status` surface them; re-running is idempotent; no remote mutation occurs.

---

### Task B4: P7 — `access.doctor --export-ssh`

**Why:** Access config (host aliases, `UTS_HPC_*_USER` refs) lives only inside the plugin; a human could not reach HPC to verify progress (`login-host` alias absent from `~/.ssh/config`). Emit a human-usable, secret-free export.

**Files:**
- Modify: the `access_doctor` op (under `mcp-server/src/ops/` — locate via `index.ts`) and `core/access.ts`.
- Test: `mcp-server/tests/ops/access.test.ts` (or the access op's existing test).

- [ ] **Step 1 — Test.** With an `--export-ssh` (or `export_ssh:true`) input, the tool returns a `~/.ssh/config` snippet per profile: `Host <alias>` / `HostName <host>` / `User <derived-from-alias>` and a list of required env-var NAMES (`UTS_HPC_U00000001_USER`, …). Assert it NEVER prints secret VALUES (only alias + ref names + hostnames). Pure derivation from the profile; no SSH, no network.
- [ ] **Step 2 — Implement** as a pure function over the loaded profiles; reuse `core/config.ts` host_alias/`*_ref` parsing (`profileAccountName`).
- [ ] **Step 3 — Run:** `npm test -- access`.
- [ ] **Step 4 — Commit:** `feat(access): doctor --export-ssh emits secret-free ssh-config + env-var names (P7)`.

**Acceptance:** Output is a paste-ready `~/.ssh/config` snippet + env-var NAMES; a test asserts no secret value (no token, no key material, no username VALUE beyond what the alias already encodes) appears.

---

### Task B5: P9 — campaign preflight gate (dataset existence + param_overrides shape)

**Why:** Cross-repo string contracts were validated only by human eyeballing before a 48h/500-trial launch. Two cheap machine checks would have caught the real bugs: the dataset alias `ML` (dir is `MovieLens`, `datasets/ML` does not exist) and a malformed/typo'd `param_overrides`. Note (from audit §6): DeepSANE's `deep_overrides()` mutates the `parameter_space` SHAPE, not just values, so the param check is structural, not flat key-membership.

**Files:**
- Create: `mcp-server/src/ops/plans/preflight.ts` (pure validators) + wire an optional preflight step into `ops/plans/planner.ts` (`planJob`) gated behind a `preflight` input so existing behavior is unchanged when omitted.
- Modify: `mcp-server/src/index.ts` if exposing a standalone `jobs.preflight` read-only tool (recommended, so it can be run before any launch).
- Test: `mcp-server/tests/ops/preflight.test.ts`.

- [ ] **Step 1 — Dataset-existence check (test + impl).** Given a target node + a dataset name + a datasets root, SSH `test -d <root>/<name>` (allowlisted); return `ok:false` naming the missing dir when absent. Test both the `MovieLens` (exists) and `ML` (missing) cases with the mock executor.
- [ ] **Step 2 — param_overrides structural check (test + impl).** Validate a supplied `param_overrides` object against a caller-supplied JSON Schema (the host model's allowed `parameter_space` keys/shape) using Ajv: reject unknown keys (catches `sane_projector_hiden` typos) and reject a `parameter_space` whose shape violates the schema. The research-specific schema is an INPUT (the generic plugin does not hardcode SANE knobs); document that NexusRec supplies it from the model YAML.
- [ ] **Step 3 — (Optional, note only) study-name consistency** is a research-repo concern (`core/hpo/study_identity.build_study_name` lives in NexusRec, not here). Add a one-line note in the preflight output recommending NexusRec route all study-name construction through that single builder; do NOT reimplement it in the plugin.
- [ ] **Step 4 — Run:** `npm test -- preflight`.
- [ ] **Step 5 — Commit:** `feat(plans): campaign preflight — dataset-dir existence + param_overrides schema (P9)`.

**Acceptance:** A launch targeting `ML` is rejected with "dataset dir not found"; a `param_overrides` with an illegal key/shape is rejected before any expensive submit; valid inputs pass unchanged.

---

## Self-review (run before handing off)

- **Spec coverage:** P1→B2, P2→A2+B1, P3→A1, P5→A3, P6→B3, P7→B4, P9→B5. P4 (placement logical slots) and P8/P10 are intentionally NOT in Tier 1 (P4 already fixed at HEAD; P8 is the deferred Tier-2 internalization; P10 is a one-line config-fallback assertion noted in the audit §7 — add it opportunistically when touching `core/config.ts` in B4/B5). P10 is the only spec item without its own task: fold "assert `${…}` templating actually substituted (no literal `${` survives) in `defaultConfigPath`" into B4 as a one-line guard + test if convenient.
- **No placeholders:** every task names exact files, a concrete test, an acceptance check, and a commit message.
- **Type/contract consistency:** the version string format `"<pyproject-version>+<gitshort>"` produced in A2 is the same string B1 compares against `expected_scheduler_version`; keep them identical.
- **Anti-regressions baked in:** A1's lint and A2's fail-closed default exist specifically so P3/P2 cannot silently return.

## Execution handoff

This plan spans two repos and is two independent tracks. Recommended:
1. **Track A** (uts-ihpc, Python) in its own clone/worktree on branch `codex/minimal-scheduler-entities`. Push A1–A3 and tag the result `scheduler-v1.0.1` so B1's `expected_scheduler_version` has a concrete pin.
2. **Track B** (this repo, TypeScript) in a worktree off the plugin's default branch. B1 should pin `expected_scheduler_version` to Track A's tag.

Use `superpowers:subagent-driven-development` per task (implementer → spec review → code-quality review). Do NOT deploy to live accounts or touch the running 42-study campaign as part of implementation; deployment of the hardened scheduler is a separate, reported step.
