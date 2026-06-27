// Redaction / PII-masking helpers shared by every module that persists a remote command, its
// stdout/stderr, or a failure summary to an evidence/run record (access, submit, ihpc-start, jobs,
// quotas, transfer, artifacts). Each module previously carried its own copy of these helpers at the
// bottom of the file; consolidated here so the copies can't drift apart — drift here is a
// security bug (an under-redacted argv leaks a host alias or a remote username to an audit record).
//
// `redactCommand` (the generic secret scrubber) stays in audit.ts; it is imported here rather than
// re-implemented. Path/host masking that needs a profile's declared mount prefixes delegates to
// config.maskUserRootPath at the call site — this module only owns the argv/token/summary plumbing.
//
// Leaf-module note: this is the one lib/ file that imports a domain module (audit.ts). It is still
// acyclic — audit.ts's transitive closure is {ids, paths, validation, types}, none of which import
// lib/ — so redact -> audit terminates and never loops back here. The single import is the one
// `redactCommand` symbol, kept in audit.ts deliberately (see docs/archive/duplication-audit-2026-06.md,
// step 7) rather than re-homed, so this dependency is a thin, intentional, acyclic edge.

import { redactCommand } from "../core/audit.js";

// The ONE placeholder the server uses for a collapsed local home directory. Every display/evidence
// redactor that strips an operator's `/Users/<name>/…` head from a disclosed path or error message
// emits THIS token — pinned as a const so the value lives in exactly one place. (resources.ts's tests
// and the mcp-protocol transfer-evidence assertions also pin this literal.)
export const LOCAL_HOME_PLACEHOLDER = "<local-home>";

// Collapse a real local home prefix — `/Users/<name>` (macOS) — down to LOCAL_HOME_PLACEHOLDER, so a
// disclosed config/artifact/transfer path or a sanitized error message keeps its recognizable tail
// (…/profiles.example.yaml) without leaking the operator's absolute home path (and OS username) into
// tool output or a persisted evidence record. This was copy-pasted as an inline
// `value.replace(/\/Users\/[^/\s]+/g, …)` at five sites with one site drifted to a DIFFERENT
// placeholder ("/Users/<user>"); consolidated here so the token can never drift again and the dedup
// lint protects the name. The regex matches every occurrence (a value can carry both a source and a
// destination home path) and is idempotent — the placeholder contains no `/Users/` head, so a second
// pass is a no-op. NOTE: this masks ONLY the home head; a project root that itself lives under /Users
// must be project-relativized FIRST (see redactProjectRoot) so it collapses to <project>, not
// <local-home>/work/… — every caller preserves that project-then-home order.
export function redactLocalHome(value: string): string {
  return value.replace(/\/Users\/[^/\s]+/g, LOCAL_HOME_PLACEHOLDER);
}

// Project-relativize a disclosed path by replacing every occurrence of the local project root with the
// stable `<project>` placeholder — the companion to redactLocalHome that was duplicated alongside it as
// an inline `value.replaceAll(projectRoot, "<project>")`. `projectRoot` is threaded by the caller (it
// lives in core/paths, not lib) so this stays a pure string helper. Applied BEFORE redactLocalHome so a
// project root under the operator's home collapses to <project> rather than being eaten by the home pass.
export function redactProjectRoot(value: string, projectRoot: string): string {
  return value.replaceAll(projectRoot, "<project>");
}

// Apply the caller's secret scrub plus a token-substitution pass. Both prior copies
// (quotas.redactQuotaText, jobs.redactJobText) first ran redactCommand, then replaced every
// occurrence of each non-empty token with a per-token placeholder. The placeholder is a FUNCTION of
// the token so each caller keeps its exact mapping:
//   - quotas: () => "<redacted-remote-user>"
//   - jobs:   (t) => t.startsWith("/") ? "<plan-log-path>" : "<remote-job-id>"
// Empty tokens are skipped (a blank token would replaceAll-match between every character).
export function redactWithTokens(
  text: string,
  tokens: string[],
  placeholderFor: (token: string) => string
): string {
  let redacted = redactCommand(text);
  for (const token of tokens) {
    if (token) {
      redacted = redacted.replaceAll(token, placeholderFor(token));
    }
  }
  return redacted;
}

// A single host-alias / path / spec → placeholder substitution applied to an SSH or rsync argv.
export interface ArgvReplacement {
  match: string;
  replace: string;
}

// Redact an SSH / rsync argv array, threading each caller's exact replacement set.
//
// SECURITY: `mode` is NOT cosmetic and the two modes are NOT interchangeable — picking the wrong one
// silently under-redacts an audit record:
//   - "exact":     an arg is replaced only when it EQUALS a replacement's `match` (the prior
//                  `arg === hostAlias` form). Used by submit / ihpc-start / artifacts, whose tokens
//                  (host alias, compute node, base64url spec) appear as whole standalone argv
//                  elements. Substring-replacing those would also rewrite an arg that merely
//                  CONTAINS the alias as a path prefix.
//   - "substring": every occurrence of each `match` inside each arg is replaced (the prior
//                  `arg.replaceAll(root, …)` form). Used by transfer (rsync paths embed the host
//                  alias and source/destination roots as substrings of a single `host:/root/…`
//                  argv element). Exact-matching those would leave the embedded alias/root visible.
// Replacements are applied in array order; for "substring" that order is preserved per arg so a
// caller can layer (host alias first, then roots, then project root) exactly as before.
export function maskCommandArgs(
  args: string[],
  replacements: ArgvReplacement[],
  options: { mode: "exact" | "substring" }
): string[] {
  if (options.mode === "exact") {
    return args.map((arg) => {
      for (const { match, replace } of replacements) {
        if (arg === match) {
          return replace;
        }
      }
      return arg;
    });
  }
  return args.map((arg) => {
    let masked = arg;
    for (const { match, replace } of replacements) {
      masked = masked.replaceAll(match, replace);
    }
    return masked;
  });
}

// The universal `hostAlias -> '<profile-host>'` exact-mode mask shared by every ssh command-record
// redactor (submit, ihpc-start, artifacts, jobs). Each of those builders previously open-coded the same
// `maskCommandArgs(args, [{ match: hostAlias, replace: "<profile-host>" }, ...], { mode: "exact" })`
// head; this names the one replacement that is identical at every site and threads each caller's EXTRA
// per-tool masks (compute node, supervisor / artifact spec) as `extra`, applied in order AFTER the host
// mask exactly as the prior literal arrays did. Callers keep building their OWN `{ program, args,
// remote_argv }` envelope around this (the redact-envelope builder is intentionally NOT extracted) and
// keep their own follow-on passes (jobs' per-arg redactJobText). The host alias is always a whole,
// standalone argv element, so this stays in `exact` mode — substring callers (transfer's rsync paths)
// are a different mechanism and keep calling maskCommandArgs directly.
export function maskHostAlias(
  args: string[],
  hostAlias: string,
  extra: ArgvReplacement[] = []
): string[] {
  return maskCommandArgs(args, [{ match: hostAlias, replace: "<profile-host>" }, ...extra], { mode: "exact" });
}

// Shared control flow of every `summarize*Failure` copy: a timeout short-circuits to a fixed message,
// otherwise the scrubbed stderr (if any) is wrapped, falling back to the exit code. The three wording
// pieces diverge per module (bare "command timed out"/"exit N" for artifacts/jobs/transfer vs labelled
// "<label> timed out"/"<label> failed: …"/"<label> exited with N" for submit/ihpc-start/access), so
// each caller threads its OWN strings here — the control flow is shared, the wording is not flattened.
export interface FailureSummaryWording {
  timedOut: string;
  failed: (redactedStderr: string) => string;
  exited: (exitCode: number | null) => string;
}

export function summarizeRemoteFailure(
  result: { exitCode: number | null; stderr: string; timedOut?: boolean },
  wording: FailureSummaryWording
): string {
  if (result.timedOut) {
    return wording.timedOut;
  }
  const stderr = redactCommand(result.stderr.trim());
  return stderr ? wording.failed(stderr) : wording.exited(result.exitCode);
}
