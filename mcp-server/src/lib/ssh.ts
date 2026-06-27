// Single home for the SSH `-o` transport-hardening flag blocks that every remote arg-builder shares.
//
// Before this module, the 7-pair outer-hop hardening prelude (BatchMode=yes, PasswordAuthentication=no,
// KbdInteractiveAuthentication=no, NumberOfPasswordPrompts=0, StrictHostKeyChecking=yes, UpdateHostKeys=no,
// ConnectTimeout=<s>) was hand-inlined byte-for-byte inside access.ts's sshReadOnlyArgs / sshJobArgs /
// sshSupervisorArgs and the outer hop of sshOnNode. Extracting it here means the host-key/timeout policy
// for the outer (local -> login gateway) hop lives in exactly one place and cannot drift between builders.
//
// PER-HOP HOST-KEY POLICY (fixed in pass-1 step 9, preserved here verbatim):
//   - OUTER hop (local -> login gateway): StrictHostKeyChecking=yes. The gateway alias is a fixed,
//     pre-pinned known_hosts entry, so a strict check is the correct posture.
//   - INNER hop (gateway -> compute node): StrictHostKeyChecking=accept-new (TOFU). Compute nodes are
//     discovered dynamically from the scheduler/supervisor and are NOT pre-pinned in the gateway's
//     known_hosts, so =yes would break first contact. accept-new pins on first sight, then enforces.
//
// CRITICAL: tests/access.test.mjs and the ihpc supervisor-argv pin tests assert POSITIONAL argv indices
// over the output of the access.ts builders that compose these. The option ORDER below and the
// ConnectTimeout encoding (a `-o` then a `ConnectTimeout=${seconds}` token, where the caller supplies the
// integer seconds) must NOT change.

// Leaf module: imports only other pure leaves (lib/shared, the import-free ids.ts), no cycles.

import { assertSafeSshTarget, sshTimeoutSeconds } from "./shared.js";
import { isSafeRemoteToken } from "../core/ids.js";
import { pyImports, PY_FAIL_FIXED, PY_DECODE_SPEC } from "./remote-python.js";

// The TOFU host-key value for the gateway->node INNER hop. Shared by sshOnNode's inner hop and
// sshSupervisorArgs's inner hop so the accept-new policy lives in one place.
export const SSH_INNER_HOP_HOST_KEY = "StrictHostKeyChecking=accept-new";

// The 7-pair outer-hop hardening prelude (strict host-key checking for the pre-pinned gateway).
// `connectTimeoutSeconds` is the already-computed whole-second value the caller wants in the
// `ConnectTimeout=` token — callers pass `sshTimeoutSeconds(timeoutMs)` or a fixed integer so the
// per-site ConnectTimeout encoding is preserved exactly.
export function sshOuterHopFlags(connectTimeoutSeconds: number): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", "PasswordAuthentication=no",
    "-o", "KbdInteractiveAuthentication=no",
    "-o", "NumberOfPasswordPrompts=0",
    "-o", "StrictHostKeyChecking=yes",
    "-o", "UpdateHostKeys=no",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`
  ];
}

// The inner-hop (gateway -> compute node) hardening block for sshOnNode. A deliberately shorter,
// differently-ordered set than the outer hop: it re-asserts BatchMode/NumberOfPasswordPrompts and the
// accept-new TOFU host-key policy, with its own ConnectTimeout seconds. Order is preserved exactly as
// the historical inline literal (BatchMode, ConnectTimeout, NumberOfPasswordPrompts, StrictHostKeyChecking).
export function sshNodeHopFlags(connectTimeoutSeconds: number): string[] {
  return [
    "-o", "BatchMode=yes",
    "-o", `ConnectTimeout=${connectTimeoutSeconds}`,
    "-o", "NumberOfPasswordPrompts=0",
    "-o", SSH_INNER_HOP_HOST_KEY
  ];
}

// ---------------------------------------------------------------------------------------------------
// SSH argv assemblers. These are pure MECHANISM (relocated here from access.ts): they compose the
// outer-hop hardening prelude above with an already-validated host alias and a caller-supplied
// trailing argv. They own NO policy — the caller decides WHICH remote command/argv is allowed, its
// per-tool timeout default, and whether to run at all. access.ts re-exports the three named
// assemblers so its long-standing consumers (jobs, quotas, ihpc-start, doctor) keep importing them
// from there unchanged. The three remain DELIBERATELY distinct (see per-function notes); they are
// NOT merged into one.
// ---------------------------------------------------------------------------------------------------

// Single-hop remote-helper transport: the outer-hop prelude, an optional `-T` (no-pty), the host
// alias, then a caller-owned trailing argv (e.g. ["qsub"] or ["python3", "-", encodedSpec]). The
// encodedSpec-safety regex and the remote-argv allowlist stay in the caller — this primitive only
// hardens the transport and pins the host alias position. `assertSafeSshTarget(hostAlias)` runs here
// so every routed builder gets the host-alias guard. `connectTimeoutSeconds` is the already-computed
// whole-second value (callers pass `sshTimeoutSeconds(timeoutMs)`) so the ConnectTimeout encoding is
// preserved exactly.
export function sshSingleHopArgs(
  hostAlias: string,
  connectTimeoutSeconds: number,
  opts: { tty?: boolean; trailing: string[] }
): string[] {
  assertSafeSshTarget(hostAlias);
  return [
    ...sshOuterHopFlags(connectTimeoutSeconds),
    ...(opts.tty ? ["-T"] : []),
    hostAlias,
    ...opts.trailing
  ];
}

// Read-only single-hop assembler for access-probe commands. DISTINCT from sshJobArgs: this one does
// NOT re-assert assertSafeSshTarget(hostAlias) — its only access.ts caller already asserted the host
// alias upstream (checkAccessForProfile) and access.check re-validates the whole argv positionally.
// No `-T`: interactive access probes (`ssh true`, `ssh id -un`) historically ran without it.
export function sshReadOnlyArgs(hostAlias: string, timeoutMs: number, remoteCommand: string[]): string[] {
  return [
    ...sshOuterHopFlags(sshTimeoutSeconds(timeoutMs)),
    hostAlias,
    ...remoteCommand
  ];
}

// Make a remote token safe for the REMOTE login shell. OpenSSH joins the trailing argv into one
// string and the remote sshd runs it via `$SHELL -c`, so a PBS array id's `[]` glob chars would be
// expanded/mangled remotely (this is why an unquoted `qdel 3852[].hpc-head01` reached qdel as `3852`).
// Quote ONLY tokens carrying glob metachars (`[ ] * ?`). Everything else is left verbatim — crucially
// the log paths that intentionally carry `${USER}` for remote shell expansion (quoting those would
// break the path). The reachable tokens are already grammar-validated (isSafePbsJobId / isSafeRemote-
// Path), so brackets from an array id are the only glob char that legitimately appears here.
function shellQuoteRemoteToken(token: string): string {
  if (/[[\]*?]/.test(token)) {
    return `'${token.replaceAll("'", "'\\''")}'`;
  }
  return token;
}

// Job-control single-hop assembler. DISTINCT from sshReadOnlyArgs: it re-asserts
// assertSafeSshTarget(hostAlias) because its callers (jobs.cancel qdel etc.) reach it without an
// upstream host-alias guard. No `-T`, matching the historical inline form. Each remote token is
// shell-quoted (the caller's allowlist validates the UNQUOTED logical argv) so array-job ids and
// paths survive the remote `$SHELL -c` intact.
export function sshJobArgs(hostAlias: string, timeoutMs: number, remoteArgv: string[]): string[] {
  assertSafeSshTarget(hostAlias);
  return [
    ...sshOuterHopFlags(sshTimeoutSeconds(timeoutMs)),
    hostAlias,
    ...remoteArgv.map(shellQuoteRemoteToken)
  ];
}

// Two-hop supervisor assembler: outer hop to the gateway, then a nested `ssh` to a discovered compute
// node running `python3 - <encodedSpec>`. The inner hop uses StrictHostKeyChecking=accept-new (TOFU,
// nodes are not pre-pinned). Shape is positionally pinned by tests/access.test.mjs and the ihpc argv
// tests; do not change the order. Kept DISTINCT from the single-hop assemblers — it owns the node-id
// and encodedSpec guards and the inner-hop host-key option that the single-hop forms never carry.
export function sshSupervisorArgs(hostAlias: string, computeNode: string, timeoutMs: number, encodedSpec: string): string[] {
  assertSafeSshTarget(hostAlias);
  if (!isSafeRemoteToken(computeNode)) {
    throw new Error(`Unsafe iHPC compute node id: ${computeNode}`);
  }
  if (!/^[A-Za-z0-9_-]+$/.test(encodedSpec)) {
    throw new Error("Operation spec encoding is not safe for SSH argv");
  }
  return [
    ...sshOuterHopFlags(sshTimeoutSeconds(timeoutMs)),
    "-T",
    hostAlias,
    "ssh",
    "-o", SSH_INNER_HOP_HOST_KEY,
    computeNode,
    "python3",
    "-",
    encodedSpec
  ];
}

// Durable atomic JSON write on a compute node (spec §2.3 "temp → fsync(file) → rename → fsync(dir)").
// The directory fsync is mandatory: without it POSIX permits losing the rename (a directory-entry
// change) on a power loss while the file body survives, which would make a written PLAN/STATE vanish
// across a node restart. NOTE: directory fsync is Linux-valid (the iHPC nodes are Linux); on some other
// POSIX systems fsync(dirfd) is a no-op or raises EINVAL — acceptable here since the target is Linux.
// The encoded spec carries {path, contents} (base64 JSON via remote-python).
// This is pure MECHANISM (an inline micro-worker string + the two-hop argv); the brain owns WHEN to
// call it (Phase C seam/launch.ts). Built to mirror SUPERVISOR_PY's stdin-shipped python3 -c form.
export const ATOMIC_WRITE_PY = String.raw`${pyImports(["base64", "json", "os", "sys", "tempfile"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("write")}
path = spec.get("path")
contents = spec.get("contents")
if not isinstance(path, str) or not path.startswith("/"):
    fail("path must be an absolute string")
if not isinstance(contents, str):
    fail("contents must be a JSON string")
directory = os.path.dirname(path)
os.makedirs(directory, exist_ok=True)
fd, tmp = tempfile.mkstemp(dir=directory, prefix=".tmp-", suffix=".json")
try:
    with os.fdopen(fd, "w", encoding="utf-8") as handle:
        handle.write(contents)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(tmp, path)
    dir_fd = os.open(directory, os.O_RDONLY)
    try:
        os.fsync(dir_fd)
    finally:
        os.close(dir_fd)
except Exception as exc:
    try:
        os.unlink(tmp)
    except OSError:
        pass
    fail(f"durable write failed: {exc}")
print(json.dumps({"path": path, "bytes": len(contents)}, sort_keys=True))
`;

// Two-hop argv that ships ATOMIC_WRITE_PY to a compute node, identical in shape to sshSupervisorArgs
// (outer-hop hardening -> -T -> gateway -> inner ssh accept-new -> node -> python3 - <encodedSpec>).
// encodedSpec carries the base64 {path, contents}; the caller (Phase C) builds it via encodeSpec.
export function sshWriteAtomicJsonArgs(
  hostAlias: string,
  computeNode: string,
  timeoutMs: number,
  encodedSpec: string
): string[] {
  return sshSupervisorArgs(hostAlias, computeNode, timeoutMs, encodedSpec);
}
