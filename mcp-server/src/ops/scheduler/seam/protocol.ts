// seam/protocol.ts — the PLAN/STATE boundary contract (spec §2.2/§2.3/§2.7). Compiles the two grouped
// schemas with the same Ajv 2020 instance pattern as core/validation.ts, then layers the programmatic
// hardening asserts that JSON Schema cannot express: env keys must be in env_key_allowlist, env values
// may only carry KNOWN $TOKEN$ sentinels, and each job's workdir must realpath-prefix-match an
// allowed_root. Forward-compat (schema_compat_min) is the deadlock-breaker per §2.7. CLIENT-NEUTRAL:
// schemas live in schemas/, no Claude-only behavior.

import fs from "node:fs";
import type { AnySchema } from "ajv";
import * as Ajv2020Module from "ajv/dist/2020.js";
import * as addFormatsModule from "ajv-formats";
import { resolveProjectPath } from "../../../core/paths.js";
import type { IhpcJobStatus, IhpcPlan, IhpcState, LeaseOwner, RunRecord } from "../../../core/types.js";

const Ajv2020 = (Ajv2020Module as unknown as { default: typeof Ajv2020Module.Ajv2020 }).default;
const addFormats = (addFormatsModule as unknown as { default: (ajv: InstanceType<typeof Ajv2020>) => void }).default;
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);

function loadSchema(name: string): AnySchema {
  return JSON.parse(fs.readFileSync(resolveProjectPath(`schemas/${name}`), "utf8")) as AnySchema;
}

const validatePlanSchema = ajv.compile(loadSchema("ihpc-plan.schema.json"));
const validateStateSchema = ajv.compile(loadSchema("ihpc-state.schema.json"));

// The ONLY env-value sentinels the node expands (spec §2.2 "未知 $TOKEN$ 硬失败,不透传").
const KNOWN_SENTINELS = new Set(["$GPU_INDEX$", "$RUN_ID$"]);
const SENTINEL_RE = /\$[A-Z_][A-Z0-9_]*\$/g;

// THE single node-STATE-status -> RunRecord-status table (spec §2.3 vocab is the source of truth).
// Phase C (seam/reconcile.ts) and Phase D (jobs/adopt.ts) BOTH import this — they must NOT keep private
// copies of the mapping, which would silently drift (review CP-4). Every value on the right is a member
// of the live RunRecord["status"] union (core/types.ts:260, verified). placement_conflict has no
// dedicated RunRecord status, so it maps to "unknown" (the brain surfaces the conflict via STATE counts,
// not the run status). Returns "unknown" for any unrecognised input rather than throwing, so a
// newer-node STATE status never crashes an older brain's reconcile.
export function nodeStatusToRunStatus(nodeStatus: IhpcJobStatus | string): RunRecord["status"] {
  switch (nodeStatus) {
    case "pending":
      return "submitted";
    case "launching":
      return "running";
    case "running":
      return "running";
    case "done":
      return "finished";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    case "placement_conflict":
      return "unknown";
    default:
      return "unknown";
  }
}

function formatErrors(errors: typeof validatePlanSchema.errors): string {
  return (errors ?? []).map((error) => `${error.instancePath || "/"} ${error.message ?? "is invalid"}`).join("; ");
}

export function isLeaseOwnerShape(value: unknown): value is LeaseOwner {
  if (!value || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  return (v.client === "claude" || v.client === "codex")
    && typeof v.device_id === "string" && v.device_id.length > 0
    && typeof v.issued_at === "string" && v.issued_at.length > 0;
}

export function isIhpcPlanShape(value: unknown): value is IhpcPlan {
  return validatePlanSchema(value) === true;
}

// realpath-style prefix containment: reject any `..` traversal segment outright (so a string-prefix
// match cannot be escaped via "/p/../../../etc"), then require the workdir to equal a root or sit under
// root + "/". The trailing-slash normalization stops a "/" root (or any "x/") from matching as a bare
// prefix of an unrelated path.
function insideRoots(workdir: string, roots: string[]): boolean {
  if (workdir.split("/").includes("..")) return false; // no traversal segments
  return roots.some((root) => {
    const r = root.endsWith("/") ? root.slice(0, -1) : root; // normalize trailing slash ("/" => "")
    return workdir === r || workdir.startsWith(`${r}/`);
  });
}

// Schema-validate a PLAN, then apply the hardening asserts JSON Schema cannot express.
export function assertIhpcPlan(value: unknown): asserts value is IhpcPlan {
  if (validatePlanSchema(value) !== true) {
    throw new Error(`Invalid iHPC PLAN: ${formatErrors(validatePlanSchema.errors)}`);
  }
  const plan = value as IhpcPlan;
  const allowedKeys = new Set(plan.security.env_key_allowlist);
  for (const job of plan.jobs) {
    if (!insideRoots(job.workdir, plan.security.allowed_roots)) {
      throw new Error(`PLAN job ${job.seq}: workdir ${job.workdir} is outside allowed_roots`);
    }
    for (const [key, raw] of Object.entries(job.env)) {
      if (!allowedKeys.has(key)) {
        throw new Error(`PLAN job ${job.seq}: env key ${key} is not in env_key_allowlist`);
      }
      for (const match of raw.match(SENTINEL_RE) ?? []) {
        if (!KNOWN_SENTINELS.has(match)) {
          throw new Error(`PLAN job ${job.seq}: unknown token sentinel ${match} in env value for ${key}`);
        }
      }
      // Defense-in-depth (Phase C will expand env values): the only legal `$` is a KNOWN $SENTINEL$,
      // already validated and stripped of metachar meaning above. Any residual `$` or backtick is a
      // shell-expansion vector ($(...) / ${...} / `...`) — reject rather than risk passing it through.
      const sanitized = raw.replace(SENTINEL_RE, "");
      if (sanitized.includes("$") || sanitized.includes("`")) {
        throw new Error(
          `PLAN job ${job.seq}: env value for ${key} contains a shell-expansion metachar ($ or backtick)`
        );
      }
    }
  }
}

export function assertIhpcState(value: unknown): asserts value is IhpcState {
  if (validateStateSchema(value) !== true) {
    throw new Error(`Invalid iHPC STATE: ${formatErrors(validateStateSchema.errors)}`);
  }
}

// §2.7 forward-compat: a v1.x brain can read any v1.y STATE produced under a PLAN whose
// schema_compat_min ≤ the brain's own schema version, within the SAME major. A major bump (v2) or a
// compat_min the brain is older than is unreadable (the brain must be upgraded / the campaign drained).
export function brainCanReadState(input: { planCompatMin: string; brainVersion: string }): boolean {
  // Compare on [major, minor] only — patch and any further components are tolerated (§2.7 "ignore
  // unknown, y ≤ self"). A missing minor defaults to 0 ("1" => 1.0); a NON-finite major/minor (garbage
  // string) is treated as UNREADABLE — fail-closed, never NaN>=NaN === false silently masking a real
  // version (review B-4).
  const parse = (v: string): { maj: number; min: number } | null => {
    const parts = v.split(".");
    const maj = Number.parseInt(parts[0] ?? "", 10);
    const min = parts.length > 1 ? Number.parseInt(parts[1] ?? "", 10) : 0;
    if (!Number.isFinite(maj) || !Number.isFinite(min)) return null;
    return { maj, min };
  };
  const plan = parse(input.planCompatMin);
  const brain = parse(input.brainVersion);
  if (!plan || !brain) return false;
  if (plan.maj !== brain.maj) return false;
  return brain.min >= plan.min;
}
