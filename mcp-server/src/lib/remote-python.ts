// Single home for the byte-identical fragments shared by the embedded-Python remote helpers.
//
// artifacts.ts, ihpc-start.ts, jobs.ts and transfer.ts each build a small Python PROGRAM as a
// `String.raw` source string and ship it over SSH to run on the iHPC node. Those programs shared a
// large amount of verbatim boilerplate — the import block, the fail()/SystemExit preamble, the
// base64url argv-decode guard, the realpath-containment check, and the chunked sha256 hasher — which
// had been copy-pasted into all eight builders. This module owns each shared fragment exactly once so
// the copies cannot drift.
//
// THESE ARE WIRE BYTES. The remote programs are executed verbatim and the TypeScript callers parse
// their stdout/stderr and (critically) their exit codes. tests/remote-python-snapshot.test.mjs pins
// every builder's rendered string against a committed golden fixture, so any change here that alters a
// single byte of any helper fails CI. Two divergences are deliberate and MUST be preserved:
//
//   1. fail() has TWO variants with DIFFERENT exit-code contracts. PY_FAIL_FIXED always
//      `raise SystemExit(2)`; PY_FAIL_CODED takes `code=2` and `raise SystemExit(code)` so callers can
//      signal exit 3/4 (artifact-fetch "not a regular file" / "exceeds max_bytes"). The TS side
//      branches on these codes — do NOT merge the two into one.
//   2. Remote path-safety has TWO variants. PY_INSIDE_REALPATH uses os.path.commonpath (used by the
//      artifact/transfer file-walk helpers). ihpc-start.ts's SUPERVISOR_PY instead uses a
//      `real == root or real.startswith(root + os.sep)` membership test over a LIST of allowed roots —
//      a different policy — and keeps that check inline. The two are NOT unified.
//
// PY_SHA256_FILE keeps its 1024 * 1024 read chunk in lock-step with lib/shared.ts READ_CHUNK_BYTES
// (used by sha256File()); tests/remote-python-snapshot.test.mjs asserts the two stay identical, so a
// drift in either source fails the suite. The literal stays inline (not interpolated) so the wire
// bytes match the golden fixture.
//
// Leaf module: no domain imports, no cycles.

// The import block for a remote helper: one `import <module>` line per name, ascii-sorted, each
// newline-terminated. Every builder's import block is exactly this shape (the module SET differs per
// helper — some add hashlib, subprocess/time, or signal), and the historical source kept them
// alphabetically sorted, so sorting here reproduces each block byte-for-byte. Compose a body as
// `pyImports([...]) + "\n" + PY_FAIL_* + "\n" + PY_DECODE_SPEC(label) + "\n" + <body>`.
export function pyImports(modules: readonly string[]): string {
  return [...modules]
    .sort()
    .map((name) => `import ${name}\n`)
    .join("");
}

// The base import set shared by ALL eight helpers (base64/json/os/sys). Exposed as the canonical
// minimum; helpers that need extra modules pass the full list to pyImports() so the extras interleave
// in sorted order.
export const PY_IMPORTS_BASE: readonly string[] = ["base64", "json", "os", "sys"];

// fail() that always exits 2. Used by the artifact-list, supervisor, ihpc status/logs/cancel and
// transfer-preflight helpers. Trailing newline included so it slots between the import block and the
// decode guard.
export const PY_FAIL_FIXED = String.raw`def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)
`;

// fail() that exits with a caller-supplied code (default 2). Used by the artifact-fetch and
// artifact-cleanup-execute helpers, which raise SystemExit(3)/(4) for distinguishable failure modes.
// DO NOT merge with PY_FAIL_FIXED — the exit-code contract differs and the TS side depends on it.
export const PY_FAIL_CODED = String.raw`def fail(message, code=2):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)
`;

// The argv-count guard + base64url-pad-and-decode block that every helper runs immediately after
// defining fail(). `label` flows into the two error strings ("expected exactly one <label> spec
// argument" / "invalid <label> spec: {exc}") so each helper keeps its exact wording. Trailing newline
// included.
export function PY_DECODE_SPEC(label: string): string {
  return String.raw`if len(sys.argv) != 2:
    fail("expected exactly one ${label} spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid ${label} spec: {exc}")
`;
}

// commonpath-based realpath-containment check. Returns True iff `candidate` is `root` or sits beneath
// it. Used by the artifact-list, artifact-fetch, artifact-cleanup-execute and transfer-preflight
// helpers (operating on the REMOTE filesystem, hence a Python string and not the TS isInsideRemoteRoot).
// SUPERVISOR_PY deliberately uses a different startswith policy and does NOT use this. Trailing newline
// included.
export const PY_INSIDE_REALPATH = String.raw`def inside_realpath(candidate, root):
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:
        return False
`;

// Chunked SHA-256 of a file, reading 1 MiB at a time. The remote mirror of lib/shared.ts sha256File();
// the 1024 * 1024 chunk size is intentionally identical to lib/shared.ts READ_CHUNK_BYTES and must stay
// in lock-step — tests/remote-python-snapshot.test.mjs asserts the two match. Used by the artifact-list,
// artifact-cleanup-execute and transfer-preflight helpers. Trailing newline included.
export const PY_SHA256_FILE = String.raw`def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()
`;
