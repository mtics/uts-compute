// Shared identifier validators — a single source for the id grammars enforced across the
// job / transfer / artifact paths, so the run-id rule can't drift between modules.

// Run ids (and retry/source run ids): 3-128 chars from `[A-Za-z0-9_.-]`, with a forced leading
// alphanumeric (no leading `.`/`-`/`_`). Mixed case, underscores, and dots are admitted so real
// campaign/sweep names (e.g. `MMPFedRec_Cards_lr0.001_mainhpo`) validate — field reports showed the
// old lowercase-hyphen-only rule rejecting ~40% of adopted runs. SAFETY: a run id is always a single
// path segment — the leading-alphanumeric anchor means it can never BE `.`/`..` or start with a dot,
// and `/` is excluded, and a leading `(?!.*\.\.)` lookahead also rejects any embedded `..` (defense-in-depth,
// mirroring assertSafeApprovalId), so no traversal is expressible even though `.` is now allowed (callers also
// confine via assertRealPathInside). The admitted set matches SAFE_REMOTE_TOKEN_PATTERN's char class,
// already deemed injection-safe. The single source of truth for the run-id grammar; reused wherever a
// run id is validated so the rule can't drift. No global/sticky flag, so sharing this RegExp across
// .test() calls is stateless.
export const SAFE_RUN_ID_PATTERN = /^(?!.*\.\.)[A-Za-z0-9][A-Za-z0-9_.-]{2,127}$/;

export function assertSafeRunId(value: string, label = "run_id"): void {
  if (!SAFE_RUN_ID_PATTERN.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
}

// Approval ids: `approval-` prefix then 1-220 chars from a bounded set; `..` is rejected separately
// so a traversal sequence can never slip through even though `.` is an allowed character.
export const SAFE_APPROVAL_ID_PATTERN = /^approval-[A-Za-z0-9_.:-]{1,220}$/;

export function assertSafeApprovalId(value: string): void {
  if (!SAFE_APPROVAL_ID_PATTERN.test(value) || value.includes("..")) {
    throw new Error(`Unsafe approval_id: ${value}`);
  }
}

// Remote scheduler token grammar (PBS job ids, iHPC node names): 1-128 chars from the bounded set
// `A-Za-z0-9_.-`. The single home for this regex, which jobs.ts (remote job id), submit.ts (parsed
// qsub job id), and quotas.ts (parsed iHPC node) each re-inlined byte-equivalently (the `_.-` vs
// `._-` ordering in those copies is equivalent — `-` is literal at the class edge either way). The
// host/node variant in access.ts (`isSafeRemoteToken`, adds `@:+`) is deliberately broader and is
// NOT folded here. No global/sticky flag, so sharing the RegExp across .test() calls is stateless.
export const SAFE_REMOTE_TOKEN_PATTERN = /^[A-Za-z0-9_.-]{1,128}$/;

export function isSafeRemoteJobId(value: string): boolean {
  return SAFE_REMOTE_TOKEN_PATTERN.test(value);
}

// PBS Pro job-id grammar — a sequence number with an OPTIONAL array suffix (`[]` for a whole array,
// `[i]` for a single subtask) and an OPTIONAL `.server` (the executing server, e.g. `hpc-head01`, not
// only the default `pbsserver`). The broad SAFE_REMOTE_TOKEN_PATTERN above deliberately omits `[` `]`,
// so a real `qsub` array id (`3852[].hpc-head01`) is rejected there; this stricter, SEPARATE predicate
// admits brackets ONLY in the exact array position and only around digits, so a parsed/stored PBS job
// id stays injection-safe. The bracket content IS shell-glob significant, so any caller that places a
// PBS job id into a remote shell command MUST shell-quote it (lib/ssh.ts sshJobArgs does this).
export const SAFE_PBS_JOB_ID_PATTERN = /^\d{1,18}(\[\d{0,9}\])?(\.[A-Za-z0-9_.-]{1,128})?$/;

export function isSafePbsJobId(value: string): boolean {
  return SAFE_PBS_JOB_ID_PATTERN.test(value);
}

// Broader SSH-argv token grammar for host/node ids: the narrow SAFE_REMOTE_TOKEN_PATTERN above plus
// `@:+` (host aliases carry `user@host`/`host:port`; some node ids carry `+`). DELIBERATELY a SEPARATE
// function from isSafeRemoteJobId — the two grammars are NOT merged (a PBS job id must not admit `@:+`).
// Relocated here from access.ts so this format predicate sits beside its narrow peer; access.ts
// re-exports it for the quotas/ihpc-start/jobs consumers that import it from there. Pure format check
// with zero policy: callers own WHICH field is validated and the failure wording.
export function isSafeRemoteToken(value: string): boolean {
  return /^[A-Za-z0-9._@:+-]{1,128}$/.test(value);
}
