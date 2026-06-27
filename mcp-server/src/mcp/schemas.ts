// Reusable zod field factories and constants for the MCP tool-input schemas (index.ts) and the
// prompt-argument schemas (prompts.ts). These shapes were copy-pasted across ~40 tool registrations;
// consolidating them here keeps the bounds from drifting apart. This is schema-layer DRY only — every
// factory reproduces the exact prior zod chain, so the exported JSON Schema (and runtime validation)
// is byte-identical at each call site.

import { z } from "zod";

// --- timeoutMs (3 distinct caps) ---------------------------------------------------------------
// `timeoutMs` appears 18x with three different bounds. The factory takes explicit bounds so each
// family keeps its exact min/max. NOTE: confirm_usage raises the MIN to 5000 — that floor MUST be
// passed explicitly, or a 1000-4999ms timeout would silently become valid where it was rejected.
export function timeoutMsField(bounds: { min: number; max: number }) {
  return z.number().int().min(bounds.min).max(bounds.max).optional();
}

// The standard connect/SSH timeout cap shared by all read/remote tools (1000-30000ms).
export const TIMEOUT_MS_STANDARD = { min: 1000, max: 30000 } as const;
// confirm_usage's interactive supervised hop allows a longer wait and a higher floor (5000-90000ms).
export const TIMEOUT_MS_CONFIRM_USAGE = { min: 5000, max: 90000 } as const;
// transfers.execute's rsync run gets the 10-minute (600000ms) cap (1000-600000ms).
export const TIMEOUT_MS_TRANSFER = { min: 1000, max: 600000 } as const;

// --- byte caps (3 distinct families, by VALUE not name) ----------------------------------------
// Several optional byte-cap fields happen to share the name `maxBytes` by COINCIDENCE — they are
// three different caps. Consolidate per-family by value; never collapse them because the field names
// match.

// Log/diagnose stdout-tail cap (1-200000 bytes). Used by jobs.logs.maxBytes + jobs.diagnose.maxBytes.
export function logTailBytesField() {
  return z.number().int().min(1).max(200000).optional();
}

// Artifact byte cap (1-50000000 bytes / 50 MB). Used by artifacts.list.checksumMaxBytes,
// artifacts.fetch.maxBytes, and artifacts.fetch.batch.maxBytesPerFile / maxTotalBytes.
export function artifactBytesField() {
  return z.number().int().min(1).max(50000000).optional();
}

// docs.refresh's page-byte cap keeps its DISTINCT min(1024) floor (1024-2000000 bytes). Not part of
// the other two families — do not merge.
export function docsRefreshMaxBytesField() {
  return z.number().int().min(1024).max(2000000).optional();
}

// artifacts.summarize (source:remote) reads ONE metric file capped at the 1 MB metric-file ceiling
// (MAX_METRIC_FILE_BYTES in ops/data/artifacts.ts), NOT the 50 MB artifact-byte ceiling. Its own field
// keeps the advertised range equal to the enforced one (M1) — a 50 MB field here would let a 1-50 MB
// value pass Zod only to be clamped/rejected in ops. Distinct from artifactBytesField; do not merge.
export function metricSummaryBytesField() {
  return z.number().int().min(1).max(1000000).optional();
}

// --- permissive id / hash string constants -----------------------------------------------------
// The handler-layer runId validators are mutually contradictory (lowercase {3,128} via ids.ts vs
// {1,160} mixed-case via approvals.assertSafeId), so the tool-input schema MUST stay a bare
// z.string() — promoting SAFE_RUN_ID_PATTERN here would reject ids one handler still accepts. Keep
// every id constant PERMISSIVE; the handlers own their grammar. Each is a stateless z.string() that
// can be used directly for a required field or `.optional()` for an optional one.
export const RUN_ID = z.string();
export const PROFILE_ID = z.string();
export const APPROVAL_ID = z.string();
export const QUOTA_SNAPSHOT_ID = z.string();

// plan_hash / manifest_hash are the ONLY ids tightened to sha256 at the schema layer: every handler
// already requires a 64-char lowercase-hex digest (approvals.assertPlanHash, artifacts.assertSha256,
// migrations isHexDigest), so this is a no-op tightening — anything a handler accepts is sha256, and
// a non-hex value the handler would reject is now rejected one layer earlier. The exported JSON
// Schema keeps type:"string" (with an added pattern), so introspection assertions are unaffected.
const SHA256_HEX = /^[a-f0-9]{64}$/;
export const PLAN_HASH = z.string().regex(SHA256_HEX);
export const MANIFEST_HASH = z.string().regex(SHA256_HEX);

// --- platform enums (two DISTINCT vocabularies) ------------------------------------------------
// The tool-input platform vocabulary (no 'auto'). Preserve required-vs-optional per call site:
// approvals.request requires it; jobs.track / jobs.history / projects.list make it optional.
export const PLATFORM_ENUM = z.enum(["uts-hpc", "uts-ihpc"]);
// The planning-prompt hint vocabulary — 'auto' is load-bearing for the plan-experiment prompt and
// MUST stay distinct from PLATFORM_ENUM. Used only by prompts.ts.
export const PLATFORM_HINT_ENUM = z.enum(["auto", "uts-hpc", "uts-ihpc"]);

// --- structured-input field shapes -------------------------------------------------------------
// A structured-object body (jobSpec / transferPlan / queueYaml). The wire shape stays a permissive
// record (the authoritative strict validation is the JSON Schema, ajv-enforced server-side), but an
// optional `describe` lets each tool advertise the required fields + the schema pointer in its MCP
// inputSchema, so a client need not read the repo to learn the shape.
export function jsonObjectField(describe?: string) {
  const field = z.record(z.string(), z.unknown());
  return describe ? field.describe(describe) : field;
}

// Explicit manifest artifact-id list (1-100 entries). Used by artifacts.fetch.batch and
// artifacts.cleanup.execute. Surrounding approvalId/byte-cap siblings stay per-tool (do not fold).
export function artifactIdsField() {
  return z.array(z.string()).min(1).max(100);
}

// A hyperparameter grid: each key maps to a non-empty list of string|number|boolean values. Used by
// sweep.plan.parameters and sweep.rank.parameters.
export function sweepParametersField() {
  return z.record(z.string(), z.array(z.union([z.string(), z.number(), z.boolean()])).min(1));
}
