# Architectural Layering Audit — Mechanism vs Policy (2026-06-18)

> 10-dimension layering audit (42 agents). 15 conflations survived adversarial verification (confirmed REAL *and* extraction-justified — the verifier rejected over-abstraction).
> Distinct from the syntactic duplication audits (docs/duplication-audit-*.md): this asks "is a reusable mechanism trapped inside a fat business module?", which syntactic dedup cannot see.

## Summary

Mechanism trapped in business modules; SSH assemblers in access.ts, 4 builders re-inline the hardening prelude, submit/cancel lifecycles duplicated across PBS/iHPC, and missing record-write/evidence/approval/plan-gate/walltime/qstat seams.

## Root cause

Modules accreted leaf mechanism before lib/ existed; dedup2 extracted flag blocks but not assemblers; per-platform copies duplicated the crash-safe write order; the read-mutate-write bracket was never named.

| Metric | Value |
|---|---|
| Confirmed conflations | 15 |
| Primitives to extract | 6 |
| Est. business lines collapsed | ~340 |
| Fattest module after | jobs.ts |

## Target architecture

Primitive layer (lib/ssh, ids, lib/walltime, lib/redact, lib/auth, planner) owns pure assembly/parse/validate; orchestration layer (audit.withRunRecordWrite + recordOperationEvidence, submission/cancel drivers) owns sequencing. Seam: primitives take validated tokens, never own policy or event strings.

## Primitives to extract

| Risk | Effort | Primitive | Home | Absorbs |
|---|---|---|---|---|
| low | small | `ssh prelude wiring + sshSingleHopArgs` | lib/ssh.ts | findings 1,2,3,7,14: assemblers + 4 inline preludes |
| medium | medium | `withRunRecordWrite + recordOperationEvidence` | audit.ts | findings 8,9: double-write bug + 7 evidence tails |
| low | small | `assertApprovalBoundTo + readVerifiedPlan` | lib/auth.ts, planner.ts | findings 6,13: approval spine + 4 plan-gate copies |
| low | small | `walltime codec + parseQstatFields + maskHostAlias` | lib/walltime.ts, accounting.ts, lib/redact.ts | findings 11,12,15: pure parsers + host mask |

## Sequenced plan

1. **[low]** Wire 4 builders onto sshOuterHopFlags, relocate assemblers + isSafeRemoteToken
   - verify: argv tests byte-identical
2. **[low]** Add lib/walltime + parseQstatFields export + readVerifiedPlan, replacing copies
   - verify: round-trip + integrity tests pass
3. **[low]** Add assertApprovalBoundTo + maskHostAlias, refactor guards and redaction
   - verify: mismatch/redact tests pin same strings
4. **[medium]** Add withRunRecordWrite, fold stray write jobs:188/851, then recordOperationEvidence
   - verify: rev bumps by 1 after a poll (currently 2)
5. **[medium]** Extract cancel then submission drivers, collapsing PBS/iHPC
   - verify: both platforms pass; write-order invariants hold

## Deliberately NOT extracted (over-abstraction guard)

Not extracted: the redact envelope builder; the full 4-callback runSubmission orchestrator; sshOnNode signature change; merging strict/lenient parsers or token regexes; folding updateRunStatus; parsePbsQueueLimits; per-platform cancel guards.

## All 15 confirmed conflations

### [high/small] SSH transport-arg builders (sshReadOnlyArgs / sshJobArgs / sshSupervisorArgs / sshOnNode) are trapped in access.ts and sibling-imported by 5 modules
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 9 · **ops:** access.check, access.doctor, quotas.refresh/capacity, jobs.status/cancel/logs, ihpc start, confirm_usage
- **primitive:** Move the four pure SSH-argv assemblers into a new lib/ssh-args.ts (or extend lib/ssh.ts). They are already policy-free compositions of lib/ssh.ts flag blocks + lib/shared.ts helpers. Signatures stay identical: sshReadOnlyArgs(hostAlias,timeoutMs,remoteCommand)->string[]; sshJobArgs(hostAlias,timeoutMs,remoteArgv)->string[]; sshSupervisorArgs(hostAlias,computeNode,timeoutMs,encodedSpec)->string[]; 
- **policy stays in caller:** WHICH remote command/argv is allowed (quotas' qstat allowlist, access.check's [['true'],['id','-un']] remote-command allowlist at access.ts:428, jobs' qstat/qsub argv), the per-tool timeout defaults, and the decision to run at all. The builders only assemble a hardened argv from 
- **preserve:** These are already distinct functions, so the move preserves them by construction — the primitive must NOT collapse them: (1) sshReadOnlyArgs vs sshJobArgs are near-identical EXCEPT sshJobArgs re-asserts assertSafeSshTarget(hostAlias) while sshReadOnlyArgs does not (its access.ts 
- **sites:** mcp-server/src/access.ts:440, mcp-server/src/access.ts:448, mcp-server/src/access.ts:469, mcp-server/src/access.ts:519, mcp-server/src/quotas.ts:3, mcp-server/src/jobs.ts:23, mcp-server/src/ihpc-start.ts:3, mcp-server/src/doctor.ts:10

### [medium/trivial] isSafeRemoteToken (pure regex token-format primitive) lives in access.ts while its sibling validators live in lib/shared.ts
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 0 · **ops:** quotas.refresh, ihpc start/status, jobs.cancel/track
- **primitive:** Move isSafeRemoteToken(value:string):boolean into lib/shared.ts next to its exact peers assertSafeSshTarget / isSafeRemotePath / assertSafeRemotePath / isHexDigest. It is a one-line regex test (/^[A-Za-z0-9._@:+-]{1,128}$/) with zero policy and zero access-check dependency. access.ts re-exports it (or imports from lib) like it already does for assertSafeSshTarget/normalizeTimeout/sshTimeoutSeconds
- **policy stays in caller:** WHICH field is being validated and what to do on failure (quotas validates the qstat -u username argument; ihpc-start/jobs validate a compute-node id and throw their own 'Unsafe iHPC compute node id' wording). The predicate itself is pure format-checking with no business meaning.
- **preserve:** The function ALREADY parameterizes nothing — callers own (a) WHICH field is validated and (b) failure behavior, and these MUST stay caller-local: access.ts:471 / ihpc-start.ts:312 / jobs.ts:1023 each throw distinct wording ("Unsafe iHPC compute node id" vs "iHPC active compute no
- **sites:** mcp-server/src/access.ts:490, mcp-server/src/quotas.ts:597, mcp-server/src/ihpc-start.ts:312, mcp-server/src/ihpc-start.ts:422, mcp-server/src/jobs.ts:1023

### [high/small] Outer-hop SSH hardening prelude re-inlined in 4 sites that never migrated to lib/ssh.ts sshOuterHopFlags
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 4 · **ops:** artifacts.list/fetch/cleanup, jobs.submit, transfers.execute, transfers.plan(preflight)
- **primitive:** Reuse the EXISTING primitive lib/ssh.ts:sshOuterHopFlags(connectTimeoutSeconds) (and sshTimeoutSeconds for the ms->s conversion) in the four builders that still hand-inline the 7-pair `-o BatchMode=yes ... ConnectTimeout=N` block. Concretely: replace the literal 14-element array head in artifacts.sshArtifactArgs, submit.sshSubmitArgs, transfer.sshPreflightArgs, and the transfer.rsyncArgs `-e` ssh 
- **policy stays in caller:** The per-builder TAIL stays in the caller: `-T` flag, the host alias position, and the remote program (`qsub` vs `python3 - <spec>`). Only the host-key/timeout transport prelude moves to the shared primitive. The encodedSpec safety regex assertion also stays in each caller (it is 
- **preserve:** Three load-bearing per-site differences must stay in the callers (not flattened into the primitive): (1) the TAIL after the prelude differs per builder and stays as a plain caller-side array literal — artifacts.sshArtifactArgs and transfer.sshPreflightArgs use `-T, hostAlias, "py
- **sites:** mcp-server/src/artifacts.ts:1173, mcp-server/src/submit.ts:257, mcp-server/src/transfer.ts:543, mcp-server/src/transfer.ts:509

### [high/medium] Submit/start lifecycle (planned→submitting→persist-id→consume-approval→terminal) is hand-rolled twice instead of one parameterized runSubmission driver
- **kind:** orchestration-duplicated · **re-impl sites:** 2 · **ops:** jobs.submit (PBS qsub path in submit.ts), jobs.submit -> iHPC supervised start (ihpc-start.ts, dispatched from submit.ts:61-63), jobs.retry (reuses both paths via expectedOperation === 'jobs.retry')
- **primitive:** A platform-agnostic lifecycle driver in a new module (e.g. lib/run-submission.ts or submit-driver.ts):

  runSubmission(
    plan: PlannedJob,
    authz: { approval?: ApprovalRecord; quotaSnapshotId: string; authorizationNote: string; expectedOperation: SubmitApprovalOperation },
    hooks: {
      attemptEvent: { kind: string; summary: string; redacted_command: string };
      startRemote: (plan,
- **policy stays in caller:** WHICH remote command runs (ssh qsub with stdin=script vs nested ssh->ssh->python3 supervisor), how the remote job id is derived (parseRemoteJobId from qsub stdout vs `ihpc-${run_id}-${pid}` from parsed supervisor metadata), the terminal status the platform lands in (PBS->'submitt
- **preserve:** The primitive must parameterize (not flatten) these confirmed per-site differences: (1) the remote command itself — submit.ts:121-122 runs `ssh ... qsub` with stdin=plan.script via sshSubmitArgs; ihpc-start.ts:127-130 runs nested `ssh <host> ssh <node> python3 -` with stdin=SUPER
- **sites:** mcp-server/src/submit.ts:99, mcp-server/src/ihpc-start.ts:108

### [medium/medium] Cancel lifecycle (assert-non-terminal → require approval-binding → remote-kill → evidence → consume-approval → status=cancelled) is hand-rolled twice across PBS and iHPC
- **kind:** orchestration-duplicated · **re-impl sites:** 2 · **ops:** jobs.cancel (PBS qdel path), jobs.cancel (iHPC supervised killpg path)
- **primitive:** A cancel driver in jobs.ts (or the same lifecycle module): 

  runCancellation(
    runRecord, profile, remoteJobId, approvalId,
    hooks: {
      killRemote: (runRecord, profile, timeoutMs) => Promise<{ result; commandRedaction; evidencePayload }>; // qdel vs IHPC_CANCEL_PY
      evidenceKind: 'cancel' | 'ihpc-cancel';
      cancelEvent: { kind: 'live-cancel' | 'ihpc-live-cancel'; summary; redac
- **policy stays in caller:** The kill mechanism (qdel via sshJobArgs vs IHPC_CANCEL_PY/killpg via sshSupervisorArgs), the evidence kind label, and the event kind/summary wording. assertCancelApproval already correctly lives as a shared helper (jobs.ts:1172) and the terminal-guard / plan_hash+snapshot binding
- **preserve:** The primitive must parameterize exactly three axes, and only these: (1) Kill mechanism — PBS builds ["qdel", remoteJobId] -> assertAllowedHpcJobRemoteArgv -> sshJobArgs and throws on nonzero exit (jobs.ts:573-579); iHPC builds encodeSpec({pid: supervisor.pid}) -> sshSupervisorArg
- **sites:** mcp-server/src/jobs.ts:558, mcp-server/src/jobs.ts:937

### [high/small] The approval identity-binding check (run_id/profile_id/platform + plan_hash [+ quota_snapshot_id]) is re-implemented in 4 per-tool guards instead of one primitive
- **kind:** orchestration-duplicated · **re-impl sites:** 4 · **ops:** jobs.cancel, transfers.execute, artifacts.fetch, artifacts.fetch.batch, artifacts.cleanup.execute, jobs.submit, jobs.retry, ihpc start
- **primitive:** Add to lib/auth.ts: `assertApprovalBoundTo(approval, scope: { operation: string; runId: string; profileId: string; platform: string; planHash: string; quotaSnapshotId?: string })`. It calls assertApprovalUsable(approval,{operation}) then emits the identity throw ('Approval does not match the run record identity'), the plan_hash throw, and (when quotaSnapshotId is passed) the quota_snapshot_id thro
- **policy stays in caller:** Each tool's RESOURCE-SCOPE assertions (transfer resource_summary direction/source/destination/files+max_total_bytes; artifacts batch/cleanup artifact_ids/manifest_hash/delete_mode/max_*; the retry-vs-submit operation selection via expectedApprovalOperationForPlan) stay in the cal
- **preserve:** Primitive must parameterize, not flatten: (1) identity throw-message noun varies 3 ways — jobs/artifacts 'does not match the run record identity', submission 'does not match the planned run identity', transfer 'Transfer approval does not match the plan identity'; (2) plan_hash me
- **sites:** jobs.ts:1172, transfer.ts:566, artifacts.ts:1049, submission-approval.ts:28

### [high/small] SSH→python3-helper argv builder reinvented in artifacts.ts and transfer.ts instead of reusing access.ts's sshJobArgs over the existing lib/ssh.sshOuterHopFlags primitive
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 2 · **ops:** artifacts.list, artifacts.fetch, artifacts.fetch.batch, artifacts.cleanup.execute, transfers.execute (preflight/postflight)
- **primitive:** Add ONE remote-helper argv builder, `sshPythonHelperArgs(hostAlias, timeoutMs, encodedSpec)`, co-located with the existing `sshJobArgs`/`sshReadOnlyArgs` in access.ts (or a new lib/ssh-argv.ts). Signature sketch: `(hostAlias: string, timeoutMs: number, encodedSpec: string) => string[]` returning `[...sshOuterHopFlags(sshTimeoutSeconds(timeoutMs)), '-T', hostAlias, 'python3', '-', encodedSpec]`, wi
- **policy stays in caller:** Which Python helper program text runs (ARTIFACT_LIST_PY / ARTIFACT_FETCH_PY / ARTIFACT_CLEANUP_EXECUTE_PY / TRANSFER_PREFLIGHT_PY), the per-module timeout bounds (artifacts 10s/30s vs transfer 30s/600s), and the encoded spec payload all stay in the caller. The primitive only owns
- **preserve:** The primitive must stay narrow because the four cited sites are NOT the same shape: (1) submit.ts:255 sshSubmitArgs ends in `qsub` — it has NO encodedSpec param, NO `python3 - <spec>` tail, and NO base64url spec guard; it shares only the 7-pair `-o` prelude, so it is not an insta
- **sites:** mcp-server/src/artifacts.ts:1168, mcp-server/src/transfer.ts:538, mcp-server/src/access.ts:469, mcp-server/src/submit.ts:255

### [high/medium] No transactional read-mutate-write primitive: readRunRecord->mutate->updateRunRecord hand-assembled in every business op (and it has already caused a double-write bug)
- **kind:** missing-primitive · **re-impl sites:** 9 · **ops:** jobs.status, jobs.track, jobs.cancel, jobs.logs, jobs.submit, ihpc start, jobs.retry_plan, artifacts.fetch, artifacts.fetch_batch, artifacts.cleanup_execute
- **primitive:** withRunRecord(runId, mutator, options?) in audit.ts: `function withRunRecord<T>(runId: string, mutate: (rec: RunRecord) => T, opts?: { auditDir?: string }): { result: T; runRecordPath: string }` that does readRunRecord -> mutate(rec) -> updateRunRecord, returning both the mutator's value and the written path. The optimistic-concurrency rev guard already lives in updateRunRecord; this seam just gua
- **policy stays in caller:** All status-transition logic (planned->submitting->submitted, terminal-state guards, the `!terminal || observed==='finished'` clamp in updateRunStatus), which event kind/summary to push, and which fields to set. The seam only brackets read+update so the two halves stay paired and 
- **preserve:** The primitive MUST NOT take the proposed `withRunRecord(runId, mutate)` shape that reads by id, because the real sites diverge in load-bearing ways: (1) READ/WRITE DECOUPLING in the status path — getJobStatus reads at jobs.ts:90, then the record flows by reference through reconci
- **sites:** mcp-server/src/jobs.ts:188, mcp-server/src/jobs.ts:851, mcp-server/src/jobs.ts:702, mcp-server/src/submit.ts:67, mcp-server/src/ihpc-start.ts:81, mcp-server/src/retry.ts:229, mcp-server/src/artifacts.ts:282

### [medium/small] Evidence-bound run-record update tail (writeXEvidence -> mutate updated_at -> events.push{artifact_path:evidencePath} -> updateRunRecord) re-composed across 7 jobs/artifacts operations
- **kind:** orchestration-duplicated · **re-impl sites:** 7 · **ops:** jobs.logs, jobs.cancel, jobs.status, jobs.track, artifacts.fetch, artifacts.fetch_batch, artifacts.cleanup_execute
- **primitive:** recordOperationEvidence(runRecord, { event, evidencePath, now }, opts?) in audit.ts (layered on withRunRecord): given an already-written evidence file path and a half-built event, it sets runRecord.updated_at = now.toISOString(), pushes the event with artifact_path: evidencePath attached, and calls updateRunRecord — returning runRecordPath. Signature sketch: `recordOperationEvidence(rec: RunRecord
- **policy stays in caller:** The evidence file's content, schema assertion (assertArtifact*Record), per-module redaction (redactRemotePath/redactedCommand), and on-disk layout (flat writeJobEvidence vs nested writeArtifactEvidence) ALL stay in the caller and run before this seam. The event's kind, summary, a
- **preserve:** All three event-object literals (kind, summary, redacted_command) are caller-computed and must be injected via the `ev` param — they differ at every site (pbs-logs/live-cancel/ihpc-logs/ihpc-live-cancel/artifact-fetch/artifact-fetch-batch/artifact-cleanup-execute). Status mutatio
- **sites:** mcp-server/src/jobs.ts:517, mcp-server/src/jobs.ts:609, mcp-server/src/jobs.ts:898, mcp-server/src/jobs.ts:983, mcp-server/src/jobs.ts:694, mcp-server/src/artifacts.ts:368, mcp-server/src/artifacts.ts:562, mcp-server/src/artifacts.ts:763

### [medium/medium] Live-submission lifecycle state machine (planned->submitting->[persist remote_job_id]->terminal, 3 sequential record writes + approval consume) duplicated between submit.ts and ihpc-start.ts
- **kind:** orchestration-duplicated · **re-impl sites:** 2 · **ops:** jobs.submit, ihpc start
- **primitive:** A parameterized live-submission orchestrator, e.g. runLiveSubmission(plan, profile, { markSubmitting, performRemote, onRemoteJobId, finalize }, options) OR (lighter, lower-risk) two shared record-transition helpers: markSubmitting(runRecord, { planHash, quotaSnapshotId, kind, summary }, now) and persistRemoteJobId(runRecord, remoteJobId, now), both built on finding 1's withRunRecord. The orchestra
- **policy stays in caller:** Remote transport (sshSubmitArgs+qsub vs sshSupervisorArgs+SUPERVISOR_PY), the success parser, the autonomous-conformance-vs-approval branch, the terminal status value, and the approval-record / submission-context construction. Only the crash-safe write SEQUENCE and the identical 
- **preserve:** A primitive MUST parameterize (not flatten) these per-site differences: (1) terminal status value: "submitted" (submit.ts:150) vs "running" (ihpc-start.ts:158); (2) remote transport + success parser + remote_job_id derivation: sshSubmitArgs/qsub/parseRemoteJobId where stdout IS t
- **sites:** mcp-server/src/submit.ts:107, mcp-server/src/submit.ts:130, mcp-server/src/submit.ts:150, mcp-server/src/ihpc-start.ts:115, mcp-server/src/ihpc-start.ts:138, mcp-server/src/ihpc-start.ts:158

### [medium/small] Walltime HH:MM:SS parse/format is hand-rolled in 4 places instead of one mechanism module
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 4 · **ops:** approvals.request (approval-policy reasons), jobs.retry.plan (escalateResources walltime bump), submit/conformance walltime-exceeded check, jobs.usage / jobs.status accounting, jobs.rightsize
- **primitive:** A tiny pure walltime codec module (e.g. lib/walltime.ts or a 'pbs walltime' section of a lib/pbs.ts) exporting the canonical PBS-walltime mechanism: parseWalltimeSeconds(value: string): number | undefined (strict HH:MM:SS), parseHmsSeconds(value: string): number (lenient [DD:]HH:MM:SS, hours may exceed 24, for resources_used.* fields) and formatWalltime(seconds: number): string (the inverse: secon
- **policy stays in caller:** All thresholds and decisions stay in callers: approval-policy keeps LONG_WALLTIME_HOURS=24 and the 'Long walltime' reason wording; retry keeps the walltime_factor clamp (1..4) and the Math.round(seconds * factor) escalation arithmetic; conformance keeps the 'walltime-exceeded' vi
- **preserve:** 1) Strict vs lenient is a TRUE mechanism split that must stay as TWO named functions, never flattened: parseWalltimeSeconds (quota-limits.ts:43) is strict — regex ^(\d+):(\d{2}):(\d{2})$, exactly 3 colon-groups with 2-digit MM/SS, returns number|undefined, for USER-SUPPLIED reque
- **sites:** mcp-server/src/quota-limits.ts:43, mcp-server/src/accounting.ts:86, mcp-server/src/approval-policy.ts:43, mcp-server/src/retry.ts:205

### [low/small] PBS `qstat -f` key=value record reader (parseQstatFields) is trapped private in accounting.ts; jobs.ts re-scans the same record with raw regexes
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 2 · **ops:** jobs.status (parseQstatStatus state->RunRecord.status mapping), jobs.usage / jobs.status (parsePbsUsage, parseExecNodes)
- **primitive:** Export the existing parseQstatFields(text: string): Map<string,string> from accounting.ts (or relocate it into a lib/pbs.ts alongside parsePbsUsage/parseExecNodes) as THE shared `qstat -f`/`qstat -x -f` record reader. Its grammar /^\s+([A-Za-z0-9_.]+)\s*=\s*(.*\S)\s*$/ already covers job_state and Exit_status. parseQstatStatus in jobs.ts would then read fields.get('job_state') and fields.get('Exit
- **policy stays in caller:** ALL the PBS-state-to-lifecycle policy stays in jobs.ts parseQstatStatus: the Q/H/W/T->submitted, R/E/S->running, C/F + nonzero Exit_status->failed/finished mapping, the timed-out and nonzero-exit-code short-circuits, and every summary string. Only the byte-level 'turn the record 
- **preserve:** After parseQstatStatus reads from the shared field map, four caller-side behaviors must be preserved, none forcing a wider primitive interface: (1) case-insensitivity — the raw regexes use /i but parseQstatFields keys are case-sensitive; safe because real PBS and every fixture em
- **sites:** mcp-server/src/accounting.ts:74, mcp-server/src/jobs.ts:659, mcp-server/src/jobs.ts:670

### [medium/small] Plan self-integrity gate (read artifact -> recompute planHashForPlan -> compare -> throw) is a missing primitive re-implemented in 5 sites
- **kind:** missing-primitive · **re-impl sites:** 6 · **ops:** jobs.cancel, jobs.status, ihpc start, artifacts.fetch/list/summarize/cleanup, jobs.submit, jobs.retry.plan, approvals.request
- **primitive:** Add `readVerifiedPlan(runId: string, planDir?: string): PlannedJob` to plan-store.ts (next to readPlanArtifact, the module that already owns plan I/O), and a sibling pure form `assertPlanHashMatchesContent(plan: PlannedJob): void`. readVerifiedPlan = `const plan = readPlanArtifact(runId, planDir); assertPlanHashMatchesContent(plan); return plan;` where assertPlanHashMatchesContent does `if (planHa
- **policy stays in caller:** Only the self-consistency check (does the artifact's plan_hash match its own rendered content) is extracted. The cross-entity IDENTITY and OPERATION policy stays in the callers: approvals.assertPlanMatchesApprovalRequest keeps run_id/profile_id/platform + plan_hash-vs-request + o
- **preserve:** Two load-bearing forms the primitive must keep, which is why the finding's two-function split is correct: (1) pure-assert form — retry.ts assertSourcePlanHash (127-132) and approvals.ts assertPlanMatchesApprovalRequest (168-171) verify a plan they already hold, with NO read; jobs
- **sites:** mcp-server/src/jobs.ts:638, mcp-server/src/ihpc-start.ts:231, mcp-server/src/artifacts.ts:794, mcp-server/src/submit.ts:53, mcp-server/src/retry.ts:127, mcp-server/src/approvals.ts:168

### [high/small] MISSING PRIMITIVE: a single-hop remote-helper transport (sshOuterHopFlags-based python3/qsub argv builder) — 4 modules re-inline the 7-pair outer-hop hardening block byte-for-byte
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 4 · **ops:** jobs.submit, transfers.execute, transfers.plan(preflight), artifacts.list, artifacts.fetch, artifacts.fetch.batch, artifacts.cleanup.execute
- **primitive:** Home: lib/ssh.ts (already owns sshOuterHopFlags). Add `sshSingleHopArgs(hostAlias: string, connectTimeoutSeconds: number, opts: { tty?: boolean; trailing: string[] }): string[]` returning `[...sshOuterHopFlags(s), ...(opts.tty?['-T']:[]), hostAlias, ...opts.trailing]` with `assertSafeSshTarget(hostAlias)` inside. The encodedSpec-safety regex and remote-argv shape (`python3 - <spec>`, `qsub`, etc.)
- **policy stays in caller:** Each tool's allowlist of the remote argv (qsub vs python3 - spec vs rsync via -e), the encodedSpec-safety regex (`^[A-Za-z0-9_-]+$`), and the rsync-specific `-e "ssh ..."` string assembly stay in the caller. The primitive owns ONLY the 7 hardening -o pairs + ConnectTimeout + host
- **preserve:** Four real, verified divergences the primitive must NOT flatten: (1) rsyncArgs (transfer.ts:509) is structurally unlike the other three — it does NOT build an ssh argv; it builds a `-e` STRING via `["ssh", ...7pairs, "-T"].join(" ")` with NO host alias in the block (the alias is e
- **sites:** mcp-server/src/submit.ts:257, mcp-server/src/transfer.ts:509, mcp-server/src/transfer.ts:543, mcp-server/src/artifacts.ts:1173

### [medium/small] MISSING PRIMITIVE: maskHostAlias / redactSshCommandRecord — the {program:'ssh', args: maskCommandArgs(host->'<profile-host>'), remote_argv} command-record builder is re-hand-rolled in 6 modules
- **kind:** mechanism-trapped-in-business · **re-impl sites:** 6 · **ops:** jobs.submit, ihpc start, artifacts.* (all), jobs.status/logs/cancel, transfers.execute
- **primitive:** Home: lib/redact.ts (already owns maskCommandArgs). Add `maskHostAlias(args: string[], hostAlias: string, extra: ArgvReplacement[] = []): string[]` = `maskCommandArgs(args, [{match:hostAlias, replace:'<profile-host>'}, ...extra], {mode:'exact'})`, plus `buildRedactedCommand(program, args, hostAlias, extra, remoteArgv)` returning the `{program, args, remote_argv}` shape. The host->'<profile-host>' 
- **policy stays in caller:** The EXTRA per-tool token masks (spec/node/job-id/path placeholders), the remote_argv literal, and transfer's substring-mode root masking (which is a genuinely different mode) stay in the caller. Only the universal `hostAlias -> '<profile-host>'` exact replacement and the `{progra
- **preserve:** The primitive MUST preserve these load-bearing per-site differences, and they are what kills the envelope (buildRedactedCommand) half:
1) MASK MODE. transfer.ts:629 uses mode:'substring' (rsync embeds host alias + roots as substrings of one `host:/root/...` token); the other 5 us
- **sites:** mcp-server/src/submit.ts:294, mcp-server/src/ihpc-start.ts:376, mcp-server/src/artifacts.ts:1196, mcp-server/src/jobs.ts:1245, mcp-server/src/jobs.ts:1147, mcp-server/src/transfer.ts:622
