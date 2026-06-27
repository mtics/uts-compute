// webui/public/run-semantics.js
//
// Single source of run-record SEMANTICS for the dashboard. The "missing information" problem was a
// data-model mismatch: the UI was built for plugin-PLANNED runs (which carry plan_hash, requested,
// project, reproducibility and accrue usage) but ~73% of real runs are ADOPTED/observed externals that
// structurally lack those fields — and the UI rendered every structural absence as an undifferentiated
// "—". This module makes the distinction STRUCTURAL rather than spread across call-site ternaries:
//
//   classifyRun(run)            -> the run's kind (planned/adopted x hpc/ihpc)
//   resolveFieldState(run, key) -> a 4-state verdict per field {state, value, reason}
//
// The four states are a function of (run-kind, run-status, field), never a property of the field alone:
//   present        — the value exists; show it.
//   pending        — expected, can still arrive (e.g. HPC usage while running); muted, not alarming.
//   not_applicable — structurally impossible for this kind (e.g. iHPC has no batch usage); "n/a · reason".
//   unknown        — the matrix says it should be present but it is absent; LOUD. Doubles as a
//                    data-integrity probe — it should be rare, and when it fires it means a real gap.
//
// Pure: no DOM, no globals. Unit-testable under `node --test`. The DOM/HTML renderers below only build
// strings, so they are pure too and import cleanly in both the browser and the test runner.

export const RUN_KIND = Object.freeze({
  PLANNED_HPC: "planned-hpc",
  PLANNED_IHPC: "planned-ihpc",
  ADOPTED_HPC: "adopted-hpc",
  ADOPTED_IHPC: "adopted-ihpc"
});

export const FIELD_STATE = Object.freeze({
  PRESENT: "present",
  PENDING: "pending",
  NOT_APPLICABLE: "not_applicable",
  UNKNOWN: "unknown"
});

// jobsHistory defaults an unscoped run's project to this marker; treat it as "no project".
const UNASSIGNED_PROJECT = "unassigned";

const TERMINAL_STATUS = new Set(["finished", "failed", "cancelled", "canceled"]);
const ACTIVE_STATUS = new Set(["submitting", "submitted", "running"]);

export function isTerminal(status) {
  return TERMINAL_STATUS.has(status);
}
export function isActive(status) {
  return ACTIVE_STATUS.has(status);
}
function isPlannedStatus(status) {
  return status === "planned";
}

function isIhpc(run) {
  return run?.platform === "uts-ihpc";
}

// runIsAdopted — is this an externally-started run we only observe, vs one we planned?
// Order of trust: an explicit server-emitted run_class / adopted flag > the raw adoption/observed blocks
// (present on full records) > inference. Inference is reliable here: a PLANNED run always carries a
// plan_hash (and usually reproducibility); an ADOPTED run never does (adoption has no plan lineage).
export function runIsAdopted(run) {
  if (typeof run?.run_class === "string") return run.run_class.startsWith("adopted");
  if (typeof run?.adopted === "boolean") return run.adopted;
  if (run?.adoption || run?.observed) return true;
  return !run?.plan_hash && !run?.reproducibility;
}

export function classifyRun(run) {
  const ihpc = isIhpc(run);
  if (runIsAdopted(run)) return ihpc ? RUN_KIND.ADOPTED_IHPC : RUN_KIND.ADOPTED_HPC;
  return ihpc ? RUN_KIND.PLANNED_IHPC : RUN_KIND.PLANNED_HPC;
}

export function isAdoptedKind(kind) {
  return kind === RUN_KIND.ADOPTED_HPC || kind === RUN_KIND.ADOPTED_IHPC;
}

// A short, human run-kind label for a badge.
export function runKindLabel(kind) {
  switch (kind) {
    case RUN_KIND.PLANNED_HPC: return "planned · HPC";
    case RUN_KIND.PLANNED_IHPC: return "planned · iHPC";
    case RUN_KIND.ADOPTED_HPC: return "adopted · HPC";
    case RUN_KIND.ADOPTED_IHPC: return "adopted · iHPC";
    default: return "run";
  }
}

function state(s, value, reason) {
  return { state: s, value: value ?? null, reason: reason || "" };
}

function nonEmptyRequested(run) {
  const r = run?.submission?.requested || run?.requested || null;
  if (!r || typeof r !== "object") return null;
  return Object.keys(r).length ? r : null;
}

function nodeOf(run) {
  return run?.node || run?.submission?.node || run?.observed?.node || "";
}

function hasProject(run) {
  const p = run?.project;
  return Boolean(p) && p !== UNASSIGNED_PROJECT;
}

// resolveFieldState — the matrix. Each field maps (kind, status, value) -> a 4-state verdict + reason.
// This is the structural home of the semantics the call sites used to re-derive inline.
export function resolveFieldState(run, field) {
  const kind = classifyRun(run);
  const status = run?.status;
  const ihpc = isIhpc(run);

  switch (field) {
    case "usage": {
      if (run?.usage) return state(FIELD_STATE.PRESENT, run.usage, "scheduler/accounting usage evidence");
      // iHPC has no PBS-style batch accounting; per-job usage cannot exist — node load is the answer.
      if (ihpc) return state(FIELD_STATE.NOT_APPLICABLE, null, "iHPC has no batch accounting — see node load");
      if (isActive(status)) return state(FIELD_STATE.PENDING, null, "appears after polling / accounting");
      if (isTerminal(status)) return state(FIELD_STATE.UNKNOWN, null, "terminal run captured no usage evidence");
      return state(FIELD_STATE.NOT_APPLICABLE, null, "run has not started");
    }

    case "requested": {
      const req = nonEmptyRequested(run);
      if (req) return state(FIELD_STATE.PRESENT, req, "requested resources from plan / submission");
      if (kind === RUN_KIND.ADOPTED_IHPC) return state(FIELD_STATE.NOT_APPLICABLE, null, "external start — request unknown");
      if (kind === RUN_KIND.ADOPTED_HPC) return state(FIELD_STATE.PENDING, null, "recoverable from qstat Resource_List");
      return state(FIELD_STATE.UNKNOWN, null, "planned run is missing its requested resources");
    }

    case "queue": {
      if (run?.queue) return state(FIELD_STATE.PRESENT, run.queue, "queue from plan / qstat evidence");
      if (ihpc) return state(FIELD_STATE.NOT_APPLICABLE, null, "iHPC has no PBS queue");
      if (kind === RUN_KIND.ADOPTED_HPC) return state(FIELD_STATE.PENDING, null, "resolvable from qstat");
      return state(FIELD_STATE.UNKNOWN, null, "planned HPC run is missing its queue");
    }

    case "node": {
      const node = nodeOf(run);
      if (node) return state(FIELD_STATE.PRESENT, node, "execution node / observed node");
      if (isPlannedStatus(status)) return state(FIELD_STATE.NOT_APPLICABLE, null, "not placed until submitted");
      if (isActive(status)) return state(FIELD_STATE.PENDING, null, "placement pending");
      return state(FIELD_STATE.UNKNOWN, null, "active/terminal run has no node evidence");
    }

    case "plan": {
      if (run?.plan_hash) return state(FIELD_STATE.PRESENT, run.plan_hash, "content-addressed plan hash");
      if (isAdoptedKind(kind)) return state(FIELD_STATE.NOT_APPLICABLE, null, "adopted run was never planned");
      return state(FIELD_STATE.UNKNOWN, null, "planned run is missing its plan hash");
    }

    case "project": {
      if (hasProject(run)) return state(FIELD_STATE.PRESENT, run.project, "git-derived project scope");
      if (isAdoptedKind(kind)) return state(FIELD_STATE.NOT_APPLICABLE, null, "adopted run has no project scope");
      return state(FIELD_STATE.UNKNOWN, null, "planned run is missing its project");
    }

    case "reproducibility": {
      if (run?.reproducibility) return state(FIELD_STATE.PRESENT, run.reproducibility, "git reproducibility block");
      if (isAdoptedKind(kind)) return state(FIELD_STATE.NOT_APPLICABLE, null, "adopted run captured no reproducibility");
      return state(FIELD_STATE.PENDING, null, "captured at plan time");
    }

    case "placement": {
      if (run?.placement) return state(FIELD_STATE.PRESENT, run.placement, "scheduler-reported placement");
      if (!ihpc) return state(FIELD_STATE.NOT_APPLICABLE, null, "PBS has no placement concept");
      return state(FIELD_STATE.PENDING, null, "supplied at adopt time when known");
    }

    // iHPC observe path (committed backend): liveness + node GPU snapshot. Both live only in a live
    // jobs.status result / node-load snapshot, so on a record read they are "pending" until refreshed.
    case "liveness": {
      if (run?.liveness) return state(FIELD_STATE.PRESENT, run.liveness, "observed pid liveness");
      if (kind === RUN_KIND.ADOPTED_IHPC) return state(FIELD_STATE.PENDING, null, "probe via observe / refresh");
      return state(FIELD_STATE.NOT_APPLICABLE, null, "only adopted iHPC runs are observed");
    }

    case "gpu": {
      if (run?.gpu_usage) return state(FIELD_STATE.PRESENT, run.gpu_usage, "node GPU snapshot");
      if (kind === RUN_KIND.ADOPTED_IHPC) return state(FIELD_STATE.PENDING, null, "refresh node load to probe");
      return state(FIELD_STATE.NOT_APPLICABLE, null, "node GPU load applies to iHPC nodes only");
    }

    default:
      return state(FIELD_STATE.UNKNOWN, null, `unknown field: ${field}`);
  }
}

// ---- pure presentation helpers (strings only; no DOM) ------------------------------------------------

// Map a 4-state verdict onto the existing evidence-chip CSS vocabulary (evidence-present /
// evidence-not-applicable / evidence-missing), adding a new muted "pending" class. Keeping the mapping
// here means call sites never re-decide it.
export function fieldStateClass(s) {
  switch (s) {
    case FIELD_STATE.PRESENT: return "evidence-present";
    case FIELD_STATE.PENDING: return "evidence-pending";
    case FIELD_STATE.NOT_APPLICABLE: return "evidence-not-applicable";
    case FIELD_STATE.UNKNOWN: return "evidence-missing";
    default: return "evidence-missing";
  }
}

// The short token a table cell / inline label shows when a field is not plainly present. Distinguishes
// the three non-present states so the user never sees an undifferentiated "—":
//   pending -> "pending"  not_applicable -> "n/a"  unknown -> "missing"
export function fieldStateToken(verdict) {
  switch (verdict.state) {
    case FIELD_STATE.PENDING: return "pending";
    case FIELD_STATE.NOT_APPLICABLE: return "n/a";
    case FIELD_STATE.UNKNOWN: return "missing";
    default: return "";
  }
}

// True when the scatter / chart should plot this run for a numeric field (present only). The Explore
// view must use this instead of silently dropping non-present rows.
export function isPlottable(run, field) {
  return resolveFieldState(run, field).state === FIELD_STATE.PRESENT;
}
