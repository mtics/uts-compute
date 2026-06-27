# iHPC Scheduler Internalization — Architecture Research Synthesis (Final)

## 0. REVISION NOTE — what changed and why

This final report revises an earlier draft after two critiques (adversarial + completeness) were checked against the source tree (`mcp-server/src`, `ihpc-scheduler/src`, `docs/AUDIT_2026-06-19_*`, `skills/`). **Most load-bearing critique claims were confirmed in code** and are integrated. The corrections are material — two of them touch the draft's central justification:

- **Usage-monitoring is NOT a node-residency force (CONFIRMED).** The vendored scheduler has no inbound-mail / `confirm_usage` capability at all — only outbound `send_mail` (`ihpc-scheduler/src/scheduler/monitor.py:63`). Usage-confirmation is a client-side, human-in-the-loop, single-SSH path (`access.confirm_usage` + the `confirm-usage` skill). It does **not** distinguish the candidates. The draft's "(A) handles usage-monitoring in-loop natively ✓ / (B),(D) disqualified" was wrong and is struck.
- **The scheduler is itself an SSH poller (CONFIRMED).** Liveness (`kill -0`), exit-harvest, `nvidia-smi` GPU probe, kill, and mail all run through paramiko `SSHClient`/`SSHPool` (`monitor.py:18-77`, `scheduler.py:16,337-341`). They are **not** SSH-free local syscalls. The real residency requirement is narrower: *a loop + state that outlives the client, plus SIGHUP-surviving detached launch.*
- **The audit recommends C-grafting-A, not A (CONFIRMED).** `docs/AUDIT_2026-06-19_ihpc-sched-internalization.md` scores **A=39, B=32, C=41** and recommends **方案 C(契约优先混合)+ 嫁接 A**. The draft misattributed 41 to A and framed C as a deferred "Tier-2." This is reconciled below: the recommendation is **re-derived as the audit's C-grafting-A**, with the override (vs. the audit's own §6.2 adversarial reviewer who rejects C as scope-creep) made explicit.
- **Slot-accounting is an inverted trade-off (CONFIRMED).** Ban-critical per-account node caps live entirely in TS today (`mcp-server/src/ops/quotas/{fairuse,quota-limits,conformance,campaign}.ts`). The scheduler's `placement.py` only does **intra-node GPU slot packing**, and it is *also* non-atomic over SSH. "Atomicity hard across SSH" is not a (B)-specific con.
- **Deploy Lock 2 has a clobber hazard (CONFIRMED).** `scheduler-deploy.ts:9,147` treat `stale / absent / ssh-failed / unparseable` as **"safe to deploy."** A crashed-mid-campaign scheduler whose `status --json` is momentarily unparseable reads as safe-to-clobber.
- **Counts corrected:** **46 tools** (authoritative — `tests/integration/tool-registration.test.mjs:99`), **478 tests** (`node --test`, not "~484"). The completeness critique's "41/419" was stale memory; the adversarial critique's doubt was right to flag "~484" but the tool figure 46 is correct.
- **Contract pin is a Phase-1 placeholder (CONFIRMED):** `EXPECTED_SCHEDULER_CONTRACT = "0.1.0+state2+e6883a9"`, comment "Phase 2 will regenerate this" (`lib/ihpc-contract.ts:38-40`). `ContractVerdict = "match" | "stale" | "unknown"` and the remote argv is fixed (`REMOTE_ARGV`, "no interpolation", `scheduler-version.ts:36`).
- **`runner: uv` field does not exist in the design spec (CONFIRMED).** `grep` of `2026-06-20-ihpc-internalization-design.md` returns nothing for `runner`/`uv`/`console`. The reframe specifies **net-new** surface and now says so.

Critiques **partially rejected** (with reasons, below): the completeness critique's count claims (Gap 8) were themselves stale; the adversarial critique's specific line cite `scheduler-deploy.ts:73` did not resolve (the real fixed-PATH assumption is `REMOTE_ARGV` near `scheduler-version.ts:36`) — citations are corrected, not propagated.

---

## 1. SUMMARY

The on-node scheduler `ihpc-sched` (vendored from `mtics/uts-ihpc @ e6883a9`) is a **persistent per-queue loop** that runs in a **tmux session** on a user's active iHPC compute node (`scheduler.py:3,65`). It launches experiments via `setsid nohup` wrapper scripts (writing exit codes to `<log>.exitcode`), then — crucially — **drives the node over paramiko SSH from within that loop**: it polls `kill -0 <pid>` for liveness (`monitor.py:18-22`), harvests exit codes via `cat` (`monitor.py:25`), probes `nvidia-smi` for GPU-aware least-loaded placement with intra-node slot accounting (`scheduler.py:341`, `placement.py`), tails logs, and sends *outbound* progress/done/blocked mail (`monitor.py:63`). It persists versioned JSON state (`STATE_VERSION=2`), hot-reloads placement policy from `queue.yaml`, and exposes ~14 dry-run-by-default CLI subcommands.

**Corrected characterization of what is "irreducibly node-resident":** NOT the per-operation syscalls — `kill -0`, `nvidia-smi`, exit-code `cat`, log-tail are **SSH-issued commands a TS process could issue identically**. The genuinely node-resident core is exactly two things:
1. **A long-lived orchestration loop + its in-memory/on-disk state that outlives client disconnect** (laptop sleep, VPN drop, MCP crash). This is what the tmux session buys, and it is the real, narrow residency requirement.
2. **Detached job launch that survives SIGHUP** (`setsid nohup`) so the *job* outlives the launching transport.

What is **NOT** a residency force: **usage-monitoring**. The scheduler cannot read the admin mailbox and has no `confirm_usage` path; the iHPC "confirm you're still using this node" token is single-use, admin-issued, and answerable only by a human pasting it. The plugin does this client-side via `access.confirm_usage` + the `confirm-usage` skill. This is satisfied identically under every candidate and must be removed from the discriminating-force set.

The current plugin boundary is already a **thin-launcher hybrid for single supervised runs** that does *not* drive `ihpc-sched` (it ships four inline Python micro-workers over SSH stdin — `SUPERVISOR_PY` Popen+detach, status `os.kill(pid,0)`, logs tail, cancel `killpg`; stateless, no daemon — `ihpc-start.ts`). Separately the plugin **vendors** the full scheduler and **deploys** it via `ihpc.scheduler.deploy` (three locks: token gate → active-state heartbeat probe → post-deploy contract-version verify) and handshakes via `ihpc.scheduler.version` against the pinned `EXPECTED_SCHEDULER_CONTRACT`. **46 tools / 478 tests** ship today. The deploy tool has only ever been **mock-tested, never run against a real node** (`scheduler-deploy.ts` header).

## 2. FORCES

| Force | Description | HARD / soft | Source (verified) |
|---|---|---|---|
| **Survive-logout / loop-and-state continuity** | The *orchestration loop and its state* must outlive VPN drops, laptop sleep, MCP crashes. SIGHUP kills non-detached processes. **This is loop/state continuity, NOT SSH-independence** — the resident loop still dials the node over SSH. | **HARD** | `scheduler.py:16,50-92`; AUDIT §0 (韧性 = 调度器存在的全部意义) |
| **Detached launch (SIGHUP survival)** | The launched job itself must detach (`setsid nohup`) to outlive the launching transport. | **HARD** | scheduler wrapper; [5] Dask/Parsl anti-pattern |
| **No on-node batch scheduler** | iHPC is interactive — no Slurm/PBS authority on the node. Any design must supply its *own* durable node-side state authority. | **HARD** | AUDIT; [5] archetype crux |
| **User-space only, no inbound ports, single-user** | No root, no privileged daemon, no inbound listener. Only `setsid`/`nohup`/`tmux`/`systemd --user`+linger. | **HARD** | AUDIT; [3]§3 |
| **Per-account node limits = ban trigger** | Research group = 2 nodes total/account; exceeding a per-account family cap **triggers an account ban**. **Enforced entirely in TS today** (`quotas/{fairuse,quota-limits,conformance,campaign}.ts`) — never in the scheduler. | **HARD** | MEMORY (iHPC node limits); `ops/quotas/*` (verified) |
| **Profile-root security boundary** | Every remote write/log/metadata path must realpath-resolve inside declared roots. The supervisor block is proof-of-lineage; `jobs.adopt` is history-only and explicitly does **not** synthesize one (`adopt.ts:85-89`). | **HARD** | `adopt.ts` (verified); [2]§3 |
| **~~Usage-monitoring~~** | ~~node-resident responder~~ — **STRUCK.** No inbound-mail capability exists; client-side human-in-the-loop only. Satisfied identically by all candidates. | **n/a (struck)** | `monitor.py` has only `send_mail`; `access/confirm-usage.ts` (verified) |
| **Version-drift detectability** | Two accounts silently ran different scheduler versions ⇒ divergent placement / GPU oversubscription. Drift must be detectable and fail-closed. | soft (mitigated) | AUDIT P2 |
| **Multiple submission paths** | Research code submits via raw `qsub` / `ihpc-sched start` outside the plugin; the plugin is not the sole originator. **This is why scheduler-reported paths are not lineage-proven** (see §5 Feature B). | soft | AUDIT; [4] |
| **Two-runtime maintenance tax** | Every state field needs Python dataclass + TS type + Ajv schema ×3. Pulls toward minimizing the cross-language contract surface — the axis on which **C beats A** (AUDIT: C maintainability 8 vs A 6). | soft | AUDIT §6.2 |

**The HARD forces that jointly bind the architecture (corrected):** **loop-and-state continuity + detached-launch + no-on-node-scheduler + user-space.** Together they make a **node-resident loop** non-optional — but the binding is narrower than the draft's four-force conjunction (which leaned on a non-existent usage-monitoring force). A resident loop is still mandated; the *gap over a thin-client poller* is "continuity," not "SSH-free operation."

## 3. CANDIDATE APPROACHES

Effort/risk columns **normalized**: real-node deploy validation is a **shared** line item charged to A and C equally (it is the same deploy path), not a C-only penalty. (A)'s "done" is honestly "~0 to ship, unknown-but-real days to *validate*."

| | **(A) Vendor+deploy Python scheduler, harden SSH** | **(B) Reimplement control logic in TS, minimal node launcher** | **(C) Contract-first hybrid (vendor+deploy, but explicit machine-checked contract + golden tests)** | **(D) Stateless-client + node state files, no resident loop** |
|---|---|---|---|---|
| **Moves into plugin** | Nothing new | Placement, slot accounting, liveness loop, exit harvest, hot-reload, least-loaded policy → TS | Nothing new in *runtime*; adds a **versioned schema + cross-language golden corpus** governing the on-node↔local seam | All control logic → TS |
| **Stays on node** | Full `ihpc-sched` loop (tmux) | ~80-line launcher (setsid/Popen + PID file) | Full `ihpc-sched` loop, but pinned via `VENDOR.json{version,commit,sha256}` + tag | Detached processes + node-written state files; **no resident loop** |
| **Resilience (AUDIT axis)** | **10** (resident loop) | **4** (client loop dies on sleep/VPN; new keeper is load-bearing+untested) | **10** (resident loop) | partial (jobs survive; loop/state does not) |
| **Maintainability (AUDIT axis)** | **6** (ad-hoc bridge will drift; vendoring freezes hot-patch unless submodule+sha256) | high-ish (single runtime) but safety-critical rewrite | **8** (projection governed by versioned schema + golden tests, not ad-hoc bridge) | low (weak lineage) |
| **AUDIT total** | **39** | **32** | **41 (winner)** | not scored |
| **Pros** | Already built+shipped; loop survives client disconnect natively; battle-tested placement | Single runtime; drift solved by elimination | Same resilience as A; **minimizes the two-runtime tax** A pays; drift fail-closed by construction | Simplest client |
| **Cons** | Two-runtime tax permanent; ad-hoc adopt bridge "new, load-bearing, will drift" (A's own self-assessment per AUDIT); deploy untested on real node | **Loses loop/state continuity**; re-solves SIGHUP-detach; re-derives placement slot logic; keeper is the project's biggest risk on its most speculative component | Adds schema+golden-test machinery; distribution needs vendoring (grafted from A) | **No resident loop ⇒ no durable state authority**; orphan-job reconciliation undefined |
| **Node-limits (ban-critical)** | **Already TS (quotas/*), independent of this choice** | Already TS | Already TS | Already TS |
| **Intra-node GPU slot packing** | scheduler, non-atomic over SSH | would need rebuild, non-atomic over SSH | scheduler, non-atomic over SSH | absent |
| **Closest precedent [5]** | Globus Compute single-user endpoint; Open OnDemand session — *but they keep a resident component largely for **inbound/broker** reasons iHPC's no-inbound-ports force removes* | Nextflow/Snakemake fat-client-poller — *only works atop a real scheduler iHPC lacks* | same residency precedent as A, with an explicit contract seam (closer to Ray Jobs API client/agent split) | Slurm `slurmrestd`/`sacct` stateless front-end — *presupposes a durable state authority* |

**Corrected cross-cutting evidence from [5]:** systems matching iHPC's *loop-continuity* need (Globus Compute, OOD, Ray Jobs) keep a **node-resident loop** and make the *client* thin/reconnect-by-ID. **Caveat (per critique):** they keep that component substantially for **inbound-connectivity / multi-user brokering** — Globus Compute needs a **cloud AMQP broker** to feed its resident endpoint while the client is offline — which iHPC's *single-user, outbound-only, no-inbound-ports* forces explicitly remove. So the precedent proves "a resident loop for continuity," **not** "a multi-tenant endpoint for everything iHPC needs." Pure fat-client-pollers (Nextflow/Slurm CLI) only work because an authoritative scheduler already lives below them — which iHPC lacks. Net: (B)/(D) must re-create the node-resident *state authority* they try to remove; (A)/(C) already have it. This is real but **narrower** evidence than the draft claimed.

## 4. RECOMMENDATION

**Keep the scheduler on-node. Adopt the audit's actual recommendation — Approach (C): a contract-first hybrid, grafting A's vendoring/version-pinned-deploy/fail-closed handshake onto C's explicit machine-checked contract seam — with the TS plugin as a stateless, reconnect-by-ID orchestrator/validator/control-plane. Do not pursue (B) now. (A) is the acceptable fallback if the contract+golden-test machinery is judged not worth its build cost — but (A) and (C) are composable, not a binary.**

**On overriding the audit's adversarial reviewer:** the audit's own §6.2 reviewer REJECTs C as scope-creep ("a job scheduler the plugin shouldn't be") and notes the C+A graft presupposes a large TS plugin codebase. That objection is **moot here**: the uts-compute plugin codebase the §6.2 reviewer assumed absent **exists** (46 tools, 478 tests, `mcp-server/src`). The C-vs-A maintainability delta the audit scores (8 vs 6) is therefore live and worth capturing. We adopt C-grafting-A and record the override explicitly: *we are not building a new control plane; we are putting a versioned, golden-tested contract on a seam that already exists and is currently bridged ad-hoc.*

**Rationale, grounded in the corrected HARD forces:**
- **loop-and-state continuity + detached-launch + no-on-node-scheduler + user-space** make a node-resident loop mandatory. (A)/(C) provide it (AUDIT resilience 10); (B) forfeits it for a ~80-line untested keeper (resilience 4) at 24–38 dev-days serving 4 accounts; (D) has no durable state authority.
- **The slot-accounting "don't rewrite safety-critical logic" argument is corrected, not deleted:** the *ban-critical* per-account caps are **already in TS** (`quotas/*`) and are unaffected by A/B/C. The scheduler's `placement.py` governs only **intra-node GPU packing**, which is non-atomic over SSH in *every* candidate. So the case against (B) is **resilience + redundant-rebuild**, NOT "you'd lose atomic ban-safe accounting" (you wouldn't — it was never in the scheduler).
- (C) beats (A) precisely on the **two-runtime tax**: it governs the TS↔Python projection with a versioned schema + cross-language golden corpus instead of the "new, load-bearing, will-drift" ad-hoc adopt bridge that (A) self-describes.

**Target boundary (explicit and durable):**
- **Node owns:** the `ihpc-sched` tmux loop (placement, intra-node GPU slot packing, liveness, exit harvest, hot-reload, *outbound* mail) and authoritative state files. **Promote the resident loop from bare tmux to `systemd --user` + linger** so it survives node login-session reaping / reboot — bare tmux does NOT (the draft's "survives everything natively" is struck; see §4-risk).
- **Plugin owns:** all *policy* (approval/quota/**per-account ban-critical conformance gates** — these stay TS regardless), profile-root enforcement, plan-hash verification; *control* (version-pinned deploy with three locks); and *observation* (reconnect-by-ID via SSH reads — never a held connection).
- **Contract surface (the C discipline):** the TS↔Python coupling is exactly (1) the contract-version string, (2) `status --json` state read, (3) the deploy payload + `VENDOR.json{version,commit,sha256}`. Govern it with a **versioned schema + golden round-trip corpus**; resist widening it.
- **The plugin is an eventual-consistency observer, not a strong-consistency coordinator** — it checks/adopts/verifies and fails safe (stale-snapshot reject) when SSH is down, never guesses.

**Honest risk rating for the incumbent (A/C shared):** **Low steady-state risk, HIGH unvalidated-deploy risk.** The three locks are mock-tested only; the contract is pinned to a Phase-1 placeholder (`"0.1.0+state2+e6883a9"`, "Phase 2 will regenerate this"); and Lock 2 treats `ssh-failed/unparseable/absent` as safe-to-clobber. "Survives everything natively" is false (tmux dies on reboot/eviction/OOM). These are unquantified, not absent.

## 5. REFRAMING THE IN-FLIGHT WORK

### Feature A — uv-run-from-checkout deploy + version handshake

**Verdict: right next step; it directly serves C-grafting-A by hardening the *only untested control path*. Ship it, but treat it as net-new surface (the `runner` field is NOT in the spec yet) and surface the security trade explicitly.**

It closes the most load-bearing *unvalidated* gap. The current boundary hardcodes a console-script assumption — the fixed `REMOTE_ARGV = ["ihpc-sched", "--print-contract-version"]` (`scheduler-version.ts:36`) and the deploy's PATH assumption — which breaks on uv/editable nodes. The proposed `node_scheduler.runner: console|uv` profile field, deploy-to-independent-plugin-dir, and baked-SHA stamp are the correct shape. (Correction to the draft: this field **does not yet exist** in `2026-06-20-ihpc-internalization-design.md`; specify it as net-new, not as partly-spec'd.)

Modifications (with the §9-style tension resolved):
1. **Deploy to an independent plugin-owned dir + on-node SHA256 stamp — mandatory.** Under uv-from-checkout with concurrent campaigns, the wrapper SHA check stops being the redundant optimization it was under pip: it becomes what distinguishes "the version I deployed" from "whatever `git checkout` last ran," and **enables keep-N-deploys rollback** (see migration gap below). Promote from deferred into Feature A scope.
2. **`runner` is a stored profile field whose value is *verified by probe*, not trusted blindly — resolve the draft's self-contradiction.** Build it as: the profile *declares* `runner: console|uv` (Mod 1's stored field), and the version handshake *invokes through the declared runner and checks the result agrees*; a mismatch (declared `uv`, only console resolves, or vice-versa) is a distinct **`runner-drift`** verdict feeding Lock 3. The field is stored *and* probe-verified — not either/or.
3. **Surface the security trade `runner-probe` introduces — do not fold it in as polish.** `ContractVerdict` is currently `"match" | "stale" | "unknown"` and `compareContract` is pure/IO-free; the remote argv is *fixed* with "no interpolation" as a stated injection-safety property (`scheduler-version.ts:36`). Invoking through a profile-declared runner means **interpolating `uv run …` vs `ihpc-sched` into the remote argv — reversing that hardening**, and widening the verdict union touches every `verdict ===` consumer (`scheduler-version.ts:54-65`). Scope it as: (a) a typed verdict-union change with test coverage for every consumer, and (b) a re-established injection guarantee — a **strict allow-list of runner forms, no user-controlled interpolation**. This is a security decision with its own review, not "two hardening tweaks."

**Migration / rollback / state-schema (was entirely missing — now in scope):**
- **Rollback.** Lock 3 verifies the *new* contract reads `match`, but there is no revert path if the new scheduler misbehaves at *runtime*. The independent-dir + baked-SHA modification *enables* keep-N-deploys rollback — state rollback as an explicit goal.
- **State-schema migration.** The contract embeds `STATE_VERSION` (`state2`). A deploy that bumps `STATE_VERSION` against a node holding live `state2` files is the audit's **P5 failure** (stale global state ⇒ `tmux start` dies silently). **Wire deploy to the existing `state.migrate.apply` tool** with reasons surfaced (AUDIT Tier-1 item 6). Without this, Feature A could ship a deploy that bricks a running node on first start.
- **Downgrade / newer-than-expected.** `compareContract` treats any parseable-but-different string as `stale` *symmetrically*; add a decision rule distinguishing "older-than-expected" (safe to redeploy) from "newer-than-expected" (a node rolled forward by another account — refuse, do not silently clobber).

**Fix the Lock 2 clobber hazard (CONFIRMED in code):** `scheduler-deploy.ts:9,147` treat `stale / absent / ssh-failed / unparseable` as "safe to deploy." A scheduler that **crashed with running jobs** leaves orphaned `setsid` jobs alive on GPUs but a stale/unparseable `status --json` ⇒ reads as safe-to-clobber ⇒ **destructive-deploy-over-live-work**. Before treating unparseable/ssh-failed as safe, require a positive "no orphaned `setsid` jobs on the node's GPUs" check (an independent `nvidia-smi`/`pgrep` probe), and distinguish "absent" from "crash-with-live-work."

**Land Feature A behind the first real-node deploy validation**, plus the verification corpus below (this is shared with C, not A-only).

### Feature B — `jobs.adopt` "full supervisor reconciliation"

**Verdict: keep it strictly history-only. The draft's redirect ("reconcile from the scheduler's own state, paths are then real and root-checkable") is REJECTED as written — it trusts a weaker oracle. Re-scope per the boundary argument below.**

`adopt.ts` is evidence-fetch + persist only and explicitly does **not** synthesize a supervisor block (`adopt.ts:85-89`: "we do NOT synthesize a supervisor block… 'does not include iHPC supervisor metadata' error until Phase 4"). Fabricating one would require *guessing* `metadata_path`/`stdout_path`/`stderr_path` and asserting profile-root containment — violating the proof-of-lineage HARD boundary. That stays rejected.

**Why the draft's redirect is wrong:** sourcing paths from the scheduler's `status --json` does **not** make them lineage-proven. Jobs enter the scheduler via raw `ihpc-sched start` *outside* the plugin (the "multiple submission paths" force), and the scheduler's reported paths come from a user-controlled `queue.yaml`/launch config the plugin never validated at launch. A scheduler-reported `metadata_path` is **exactly as un-vetted as a guessed one** — it merely *looks* authoritative because it arrived as JSON. The redirect silently upgrades adopt from history-only to scheduler-state-ingest while claiming it "preserves the boundary" — the same category of change the deferral rejected, repackaged.

**Correct scope:**
- Keep `jobs.adopt` **history-only**.
- If scheduler-state discovery is pursued later, treat scheduler-reported paths as **untrusted input** subject to the **full** profile-root realpath gate **and** carry an explicit **"not launched under plugin lineage" provenance flag** on the record — never co-mingled with plugin-launched runs such that downstream tools treat them as lineage-proven. Make the trust argument a **tested invariant, not prose**.
- This makes any future Feature B dependent on Feature A (trust the deployed version before trusting its reported state) and pushes it to the deferred Tier-2 "SchedulerState ingest" decision.

**Orphan-job reconciliation is the legitimate near-term core of Feature B** (and the answer to the Lock 2 hazard): a node can have plugin-supervised Popen jobs (`ihpc-start.ts`) *and* an absent/crashed scheduler with live `setsid` jobs. The plugin's "eventual-consistency observer" framing needs a defined path for "scheduler absent but jobs running" — detect orphaned GPU processes, surface them, never auto-clobber. Scope this as *discovery + provenance-flagged surfacing*, not lineage fabrication.

**Net sequencing:** Feature A (hardened: independent-dir + SHA stamp, runner stored-and-probed with re-established injection guarantee, Lock 2 anti-clobber, deploy→`state.migrate` wiring, newer-than-expected rule) → first real-node deploy smoke test + verification corpus → only then reconsider Feature B as provenance-flagged scheduler-state discovery, never supervisor fabrication.

## 6. VERIFICATION STRATEGY (was missing; the case for keeping placement on-node demands a test that it stays correct)

"Land behind a real-node smoke test" is necessary but not sufficient. Required:

1. **Phase-0 dispatch-oracle golden corpus (AUDIT's explicit "graft from B").** Prove the *vendored* `placement.py` still places correctly across the versions deploy ships — byte-for-byte round-trip of single-quoted `--param_overrides` JSON to catch the **P3 quoting class** (`json.dumps(separators)+shlex.quote`). This is the *only* test protecting the safety-critical placement logic the recommendation says (A)/(C) keep on-node; omitting it undercuts the whole "don't rewrite placement" argument.
2. **No-shell-string CI lint** (AUDIT §5/§8): forbid `bash -lc` so the P3 quoting-injection class is mechanically unrepresentable. This is the audit's single "cheap and valuable" item.
3. **Cross-language golden round-trip for the contract seam** (the C discipline): one corpus, validated by both the Python dataclasses and the TS Ajv schema, fails CI on drift.
4. **`runner-drift` verdict coverage**: a test for every consumer of the widened verdict union, plus an injection test asserting the runner allow-list rejects user-controlled interpolation.
5. **First real-node deploy smoke test** on a non-campaign node, exercising all three locks against a live `ihpc-sched`, plus a `state.migrate` dry-run when `STATE_VERSION` differs.

## 7. CLIENT-NEUTRALITY (Codex) NOTE (was unaddressed; it is a HARD project rule)

`CLAUDE.md` and `AGENTS.md` make client-neutrality binding. The recommendation must not add Claude-only behavior:
- The new `node_scheduler.runner` field lands in the **shared** profile surface (`profiles/profiles.example.yaml`); both Codex and Claude Code must tolerate it. Make it **optional with a `console` default** so existing Codex profiles validate unchanged.
- The resilience argument assumes a *thin, reconnect-by-ID client*. Codex and Claude Code have **different session/lifetime models** — "survive client sleep" is automatically satisfied by the recommended design *because the durable loop is on the node*, but the reconnect-by-ID observation path must be implemented in the **client-neutral core** (`ops/`/`core/`), not in `.claude-plugin/`.
- Shared skills (`uts-compute:confirm-usage`, `select-profile`) front the deploy/version UX; any handshake-UX change must keep the SKILL.md surface client-neutral. Note that `confirm-usage` is the client-side, human-in-the-loop usage-confirmation path — unchanged by this recommendation (and unchanged across all candidates).

## 8. RESIDUAL UNVERIFIED CONSTANTS (flag, don't assert)

- **Tool/test counts (verified):** **46 tools** (`tests/integration/tool-registration.test.mjs:99`), **478 test cases** (`node --test`). The draft's "~484" is corrected to 478; the completeness critique's "41/419" was stale memory and is *not* adopted.
- **Idle TTL for usage-monitoring (~24h):** an unverified binding constant — but since usage-monitoring is client-side human-in-the-loop for *all* candidates, it no longer affects the architecture choice (only operational guidance). Confirm against `docs/fact-registry.md` before quoting.
- **(D) effort "10–15 days":** the draft's own invention with no cited basis — treat as unsubstantiated; (D) is dominated on the no-state-authority axis regardless.
- **Shared-daemon cross-account attribution:** a single resident `ihpc-sched` serving two collaborators' independent allocations must keep per-account slot accounting **attributable**, since cross-account oversubscription is the ban mechanism. The ban-critical caps are TS (`quotas/*`), so attribution is enforced plugin-side at submit/conformance time — but confirm no path lets a shared on-node daemon place work that bypasses the per-account TS gate. Real binding-constraint interaction; verify before any multi-account shared-daemon deployment.

---

### Bottom line
The directional conclusion — **keep a node-resident loop; do not do a full TS rewrite now** — survives the critiques, but the justification is re-derived on the *correct* forces (loop/state-continuity + detached-launch + no-on-node-scheduler + user-space), not the draft's two false premises (usage-monitoring residency; SSH-free local syscalls) or its inverted slot-accounting trade-off. The recommendation is realigned to the audit's actual **C-grafting-A (41 > A 39 > B 32)** with the §6.2-reviewer override made explicit (the plugin it assumed absent exists). Feature A is the right hardening step (with rollback/state-migration/Lock-2-anti-clobber/runner-security additions); Feature B stays history-only, with the scheduler-state "redirect" rejected as a weaker oracle and re-scoped to provenance-flagged discovery.

**Relevant files (absolute):**
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/docs/AUDIT_2026-06-19_ihpc-sched-internalization.md` — A=39/B=32/C=41, "C 嫁接 A" recommendation, §6.2 adversarial reject of C
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/ihpc-scheduler/src/scheduler/monitor.py` (`:18-77` SSH-based liveness/exit/mail) and `.../scheduler/scheduler.py` (`:16,65,337-341` SSHPool loop, tmux, nvidia-smi)
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/lib/ihpc-contract.ts` (`:14` verdict union, `:38-40` placeholder pin)
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/jobs/scheduler-version.ts` (`:36` fixed REMOTE_ARGV / no-interpolation), `.../ops/data/scheduler-deploy.ts` (`:9,147` clobber-on-unparseable hazard)
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/quotas/{fairuse,quota-limits,conformance,campaign}.ts` — ban-critical per-account caps live here (TS), not in the scheduler
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/jobs/adopt.ts` (`:85-89` history-only, no supervisor synthesis) and `.../jobs/ihpc-start.ts` (independent single-Popen path)
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/mcp-server/src/ops/access/confirm-usage.ts` + `skills/confirm-usage/SKILL.md` — client-side usage confirmation
- `/Users/lizhw/Documents/Workspace/Product/uts-computing-platform/docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md` — confirms `runner`/`uv` field is net-new (not yet spec'd)