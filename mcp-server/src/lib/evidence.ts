// JSON evidence-file write spine shared by every module that persists an evidence/record file
// (quotas, access, transfer, artifacts, jobs). Each module previously carried a byte-identical
// `fs.mkdirSync(recursive) + fs.writeFileSync(JSON.stringify(record, null, 2) + "\n")` tail at the
// bottom of its own write*Evidence helper; consolidated here so the copies can't drift apart.
//
// IMPORTANT: this helper captures ONLY that shared post-redaction / post-assertion tail. Per-module
// redaction (redactQuotaEvidence, redactEndpoint, …), schema assertions (assertTransferExecutionRecord,
// assertArtifact*Record, …), and id/run guards (assertSafeRunId) stay in the CALLERS and run BEFORE
// the record reaches this function — lifting any of them in here would risk silently dropping a
// token/endpoint leak to disk or weakening a traversal guard.

// Leaf module: besides node built-ins it imports only ids.ts and paths.ts, which are themselves
// pure leaves (they import nothing from src/ — only node built-ins) and never import lib/. So this
// stays acyclic: evidence -> {ids, paths} terminates and never reaches back into lib/.

import fs from "node:fs";
import path from "node:path";
import { assertSafeRunId } from "../core/ids.js";
import { assertInsideRuntime } from "../core/paths.js";

// Persist `record` as pretty-printed JSON (2-space, trailing newline) at `dir/fileName`, creating
// `dir` recursively first. `dir` MUST already be a containment-asserted runtime directory and
// `record` MUST already be redacted/asserted by the caller. `label` is a diagnostic context tag for
// the call site (e.g. "Quota evidence", "Access evidence") and is not written to disk. Returns the
// absolute path written.
export function writeEvidenceJson(
  dir: string,
  fileName: string,
  record: unknown,
  label?: string
): string {
  void label;
  fs.mkdirSync(dir, { recursive: true });
  const outputPath = path.join(dir, fileName);
  fs.writeFileSync(outputPath, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return outputPath;
}

// The per-run evidence root `<baseDir>/<runId>` for modules that nest each run's records in its own
// directory (transfer, artifacts). Asserts the run id grammar and confines `baseDir` to the runtime
// root with the caller's own `label` (so error messages stay per-module identical). Does NOT create
// the directory — callers `fs.mkdirSync` (or `writeEvidenceJson`) as before.
//
// NOTE: jobs.writeJobEvidence intentionally writes FLAT (the run id is embedded in the filename, not
// a nesting directory); migrating its on-disk layout to this nested form is a separate task and is
// deliberately NOT done here.
export function runRecordRoot(baseDir: string, runId: string, label: string): string {
  assertSafeRunId(runId);
  return path.join(assertInsideRuntime(baseDir, label), runId);
}
