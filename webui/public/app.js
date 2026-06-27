// uts-compute experiment dashboard — a dependency-free vanilla SPA over the /api JSON.
// Tabler for layout/components, ApexCharts for charts, List.js for table sort/search (both optional —
// the UI degrades gracefully if a CDN is slow). See docs/dashboard-design.md.
import {
  classifyRun, runIsAdopted, runKindLabel, resolveFieldState,
  fieldStateToken, isPlottable, FIELD_STATE
} from "./run-semantics.js";

const view = () => document.getElementById("view");

// ---------- api ----------
async function api(path, opts) {
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({ ok: false, error: `bad response (${res.status})` }));
  if (!data.ok) throw new Error(data.error || `request failed (${res.status})`);
  return data;
}
function post(path, body) {
  return api(path, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

// ---------- helpers ----------
const esc = (s) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const STATUS = {
  planned: { color: "secondary", dot: "" },
  submitting: { color: "yellow", dot: "status-dot-animated" },
  submitted: { color: "yellow", dot: "status-dot-animated" },
  running: { color: "blue", dot: "status-dot-animated" },
  finished: { color: "green", dot: "" },
  failed: { color: "red", dot: "" },
  cancelled: { color: "orange", dot: "" },
  unknown: { color: "secondary", dot: "" }
};
const TERMINAL = new Set(["finished", "failed", "cancelled"]);
const STATUS_TOKEN = {
  planned: "--ops-status-planned",
  submitting: "--ops-status-submitting",
  submitted: "--ops-status-submitted",
  running: "--ops-status-running",
  finished: "--ops-status-finished",
  failed: "--ops-status-failed",
  cancelled: "--ops-status-cancelled",
  unknown: "--ops-status-unknown"
};
const STATUS_COLOR_FALLBACK = {
  planned: "#64748b", submitting: "#b7791f", submitted: "#b7791f", running: "#2563eb",
  finished: "#2b8a3e", failed: "#c92a2a", cancelled: "#d9480f", unknown: "#667085"
};
const STATUS_CHART_COLOR = {
  planned: ["--ops-chart-category-4", "#475569"],
  submitting: ["--ops-risk-warning", "#f59f00"],
  submitted: ["--ops-risk-attention", "#d9480f"],
  running: ["--ops-risk-safe", "#2b8a3e"],
  finished: ["--ops-chart-category-2", "#0f766e"],
  failed: ["--ops-risk-danger", "#c92a2a"],
  cancelled: ["--ops-chart-category-6", "#db2777"],
  unknown: ["--ops-chart-category-3", "#7c3aed"]
};
const STATUS_ICON = {
  planned: "ti-file-description",
  submitting: "ti-loader",
  submitted: "ti-clock-hour-4",
  running: "ti-player-play",
  finished: "ti-circle-check",
  failed: "ti-alert-triangle",
  cancelled: "ti-ban",
  unknown: "ti-help-circle"
};
const countBy = (arr, key) => arr.reduce((m, x) => ((m[x[key]] = (m[x[key]] || 0) + 1), m), {});
const ACTIVE_STATUSES = new Set(["submitting", "submitted", "running"]);
const ATTENTION_STATUSES = new Set(["failed", "unknown"]);
const COMPARE_STORAGE_KEY = "uts-compare-runs";
const MAX_COMPARE_RUNS = 8;
const REFRESH_INTERVAL_MS = 10000;
const REFRESH_SCOPE_LABELS = {
  runs: "Runs",
  runDetail: "Run detail"
};
const RUN_COLUMN_STORAGE_KEY = "uts-runs-columns";
const RUN_COLUMN_STORAGE_VERSION_KEY = "uts-runs-columns-version";
const RUN_COLUMN_DEFAULT_VERSION = "5";
const RUN_VIEW_STORAGE_KEY = "uts-runs-saved-views";
const RUN_DENSITY_STORAGE_KEY = "uts-runs-density";
const MAX_SAVED_RUN_VIEWS = 8;
const RUN_SORT_KEYS = new Set(["name", "status", "project", "platform", "queue", "cluster", "node", "created"]);
const RUN_SORT_DEFAULT = { key: "created", dir: "desc" };
const RUN_PRIORITY_COLUMN_COUNT = 4;
const RUN_OPTIONAL_COLUMNS = [
  { key: "project", label: "Project", defaultVisible: true },
  { key: "platform", label: "Platform", defaultVisible: false },
  { key: "queue", label: "Queue", defaultVisible: false },
  { key: "cluster", label: "Cluster", defaultVisible: false },
  { key: "node", label: "Node", defaultVisible: false },
  { key: "evidence", label: "Evidence", defaultVisible: false },
  { key: "created", label: "Created", defaultVisible: false },
  { key: "duration", label: "Duration", defaultVisible: false }
];
const RUN_OPTIONAL_COLUMN_KEYS = new Set(RUN_OPTIONAL_COLUMNS.map((column) => column.key));
const RUN_COLUMN_WIDTH_REM = {
  compare: 3.25,
  run: 12.75,
  status: 7.5,
  resources: 12.5,
  project: 13,
  platform: 6.75,
  queue: 6.25,
  cluster: 5.5,
  node: 5.5,
  evidence: 10.5,
  created: 6,
  duration: 5
};
const STATUS_SORT_ORDER = {
  failed: 0,
  unknown: 1,
  running: 2,
  submitting: 3,
  submitted: 4,
  planned: 5,
  cancelled: 6,
  finished: 7
};
const PROJECT_STATUS_ORDER = ["failed", "unknown", "running", "submitting", "submitted", "planned", "cancelled", "finished"];
const PROJECT_STATUS_LABELS = {
  failed: "failed",
  unknown: "unknown",
  running: "running",
  submitting: "submitting",
  submitted: "queued",
  planned: "planned",
  cancelled: "cancelled",
  finished: "finished"
};
const EXPLORE_GROUP_DEFAULT = "status";
const EXPLORE_GROUP_OPTIONS = [
  { key: "status", label: "Status" },
  { key: "project", label: "Project" },
  { key: "platform", label: "Platform" },
  { key: "queue", label: "Queue" }
];
const EXPLORE_GROUP_KEYS = new Set(EXPLORE_GROUP_OPTIONS.map((option) => option.key));
const EXPLORE_GROUP_PALETTE = [
  "--ops-chart-category-1",
  "--ops-chart-category-3",
  "--ops-chart-category-5",
  "--ops-status-finished",
  "--ops-risk-warning",
  "--ops-chart-category-6",
  "--ops-chart-category-4",
  "--ops-chart-category-2"
];
const CAPACITY_FORM_STORAGE_KEY = "uts-capacity-form";
const LEGACY_QUEUE_FORM_STORAGE_KEY = "uts-queue-form";

function cssToken(name, fallback = "") {
  if (typeof window === "undefined") return fallback;
  return window.getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;
}
function statusChartColor(status) {
  const key = STATUS_CHART_COLOR[status] ? status : "unknown";
  const [token, fallback] = STATUS_CHART_COLOR[key];
  return cssToken(token, fallback);
}
function chartToken(name, fallback = "") {
  return cssToken(name, fallback);
}

function statusBadge(status, reason = "") {
  const normalized = status || "unknown";
  const statusKey = String(normalized).toLowerCase().replace(/[^a-z0-9-]/g, "-") || "unknown";
  const s = STATUS[normalized] || STATUS.unknown;
  const icon = STATUS_ICON[normalized] || STATUS_ICON.unknown;
  const label = reason ? `Lifecycle status: ${normalized}. ${reason}` : `Lifecycle status: ${normalized}`;
  return `<span class="status status-${s.color} lifecycle-status lifecycle-status-${esc(statusKey)}" data-lifecycle-status="${esc(normalized)}" title="${esc(label)}" aria-label="${esc(label)}">
    <i class="ti ${esc(icon)} lifecycle-status-icon" aria-hidden="true"></i><span class="status-dot ${s.dot}" aria-hidden="true"></span><span class="lifecycle-status-label">${esc(normalized)}</span>
  </span>`;
}
function lifecycleStatusReason(run) {
  if (!run) return "";
  if (run.status === "failed") return attentionReason(run) || "Review failure evidence.";
  if (run.status === "unknown") return attentionReason(run) || "Status evidence is incomplete.";
  if (run.status === "running") {
    if (run.remote_job_id) return `Remote job ${run.remote_job_id}.`;
    if (run.supervisor?.id) return `Supervisor ${run.supervisor.id}.`;
    return "Remote execution id is pending.";
  }
  if (run.status === "submitted" || run.status === "submitting") {
    return run.remote_job_id ? `Remote job ${run.remote_job_id}.` : "Submission is waiting for scheduler evidence.";
  }
  if (run.status === "planned") return run.plan_hash ? "Plan hash evidence is present." : "Plan hash evidence is missing.";
  if (run.status === "finished") return run.usage ? "Usage evidence is captured." : "Usage evidence is not captured yet.";
  if (run.status === "cancelled") return "Cancellation evidence should be reviewed when present.";
  return "";
}
function runStatusBadge(run) {
  return statusBadge(run?.status, lifecycleStatusReason(run));
}
function isActiveStatus(status) {
  return ACTIVE_STATUSES.has(status);
}
function isOverRequested(run) {
  return Boolean(resourceFitCandidate(run)?.reasons?.length);
}
function hasDirtyGit(run) {
  return run.git_dirty === true || run.reproducibility?.git?.dirty === true;
}
function hasMissingEvidence(run) {
  const activeOrTerminal = isActiveStatus(run.status) || TERMINAL.has(run.status);
  return (
    !run.event_count ||
    (run.status === "planned" && !run.plan_hash) ||
    (activeOrTerminal && !run.remote_job_id && !run.supervisor) ||
    (TERMINAL.has(run.status) && !run.usage)
  );
}
function needsAttention(run) {
  return ATTENTION_STATUSES.has(run.status) || hasMissingEvidence(run) || hasDirtyGit(run) || isOverRequested(run);
}
function attentionReasons(run) {
  const reasons = [];
  if (run.status === "failed") reasons.push({ label: "Review failure evidence", severity: "danger" });
  if (run.status === "unknown") reasons.push({ label: "Status evidence incomplete", severity: "danger" });
  if (isActiveStatus(run.status) && !run.remote_job_id && !run.supervisor) reasons.push({ label: "Remote id pending", severity: "attention" });
  if (hasDirtyGit(run)) reasons.push({ label: "Dirty git evidence", severity: "warning" });
  const fit = resourceFitCandidate(run);
  if (fit?.reasons?.length) {
    reasons.push(...fit.reasons.map((reason) => ({ label: reason || "Resource request needs review", severity: "attention" })));
  }
  if (hasMissingEvidence(run)) reasons.push({ label: "Evidence incomplete", severity: "danger" });
  const seen = new Set();
  return reasons.filter((reason) => {
    const key = `${reason.severity}:${reason.label}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
function attentionReason(run) {
  return attentionReasons(run)[0]?.label || "";
}
function attentionSeverity(run) {
  const reasons = attentionReasons(run);
  if (reasons.some((reason) => reason.severity === "danger")) return "danger";
  if (reasons.some((reason) => reason.severity === "warning")) return "warning";
  if (reasons.some((reason) => reason.severity === "attention")) return "attention";
  return "none";
}
function attentionIcon(severity) {
  return {
    danger: "ti-alert-triangle",
    warning: "ti-git-compare",
    attention: "ti-alert-circle",
    info: "ti-info-circle"
  }[severity] || "ti-info-circle";
}
function attentionReasonHtml(run) {
  const reasons = attentionReasons(run);
  if (!reasons.length) return "";
  const [primary, ...extra] = reasons;
  const severity = attentionSeverity(run);
  const title = reasons.map((reason) => reason.label).join(" · ");
  return `<div class="status-detail status-detail-${esc(severity)}" title="${esc(title)}" data-attention-count="${reasons.length}">
    <i class="ti ${esc(attentionIcon(severity))}"></i><span class="status-detail-text">${esc(primary.label)}</span>${extra.length ? `<span class="status-detail-more">+${extra.length}</span>` : ""}
  </div>`;
}
function evidenceChip(run, label, state, icon, source, detail = "", options = {}) {
  const stateLabel = state === "present" ? "present" : state;
  const visibleLabel = options.shortLabel || label;
  return `<button type="button" class="evidence-chip evidence-${esc(state)}" data-evidence-chip
    data-run-id="${esc(run.run_id)}"
    data-profile-id="${esc(run.profile_id || "—")}"
    data-platform="${esc(run.platform || "—")}"
    data-state="${esc(state)}"
    data-label="${esc(label)}"
    data-evidence-type="${esc(options.type || "")}"
    data-source-kind="${esc(options.sourceKind || "")}"
    data-route-target="${esc(options.routeTarget || "")}"
    data-source="${esc(source)}"
    data-detail="${esc(detail)}"
    data-observed-at="${esc(run.updated_at || run.created_at || "")}"
    title="${esc(`${label}: ${detail || source}`)}"
    aria-label="${esc(`${label} evidence ${stateLabel}`)}">
    <i class="ti ${esc(icon)}"></i><span class="evidence-chip-label">${esc(visibleLabel)}</span>
  </button>`;
}
function capacityEvidenceChip(cap, label, state, icon, source, detail = "", options = {}) {
  const stateLabel = state === "present" ? "present" : state;
  const scopeKind = options.scopeKind || "snapshot";
  const scopeId = options.scopeId || cap.snapshot_id || "—";
  const visibleLabel = options.shortLabel || label;
  return `<button type="button" class="evidence-chip evidence-${esc(state)}" data-evidence-chip
    data-scope-kind="${esc(scopeKind)}"
    data-scope-id="${esc(scopeId)}"
    data-snapshot-id="${esc(cap.snapshot_id || "—")}"
    data-profile-id="${esc(cap.profile_id || "—")}"
    data-platform="${esc(cap.platform || "—")}"
    data-state="${esc(state)}"
    data-label="${esc(label)}"
    data-evidence-type="${esc(options.type || "quota")}"
    data-source-kind="${esc(options.sourceKind || "quota-snapshot")}"
    data-route-target="${esc(options.routeTarget || "Capacity Snapshot")}"
    data-source="${esc(source)}"
    data-detail="${esc(detail)}"
    data-observed-at="${esc(cap.observed_at || "")}"
    title="${esc(`${label}: ${detail || source}`)}"
    aria-label="${esc(`${label} evidence ${stateLabel}`)}">
    <i class="ti ${esc(icon)}"></i><span class="evidence-chip-label">${esc(visibleLabel)}</span>
  </button>`;
}
function tableScrollHint(label) {
  return "";
}
function tableScrollRegionId(label) {
  return `scroll-region-${String(label).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "table"}`;
}
function tableScrollRegionAttrs(label) {
  return `tabindex="0" role="region" aria-label="${esc(`${label} scroll region`)}" id="${esc(tableScrollRegionId(label))}"`;
}
const TABLE_SCROLL_FRAME_SELECTOR = ".runs-table-frame, .compare-table-frame, .artifact-table-frame, .explore-table-frame, .capacity-queue-frame, .project-index-frame, .storage-headroom-frame";
let tableScrollHintObserver = null;

function tableScrollFrames() {
  return [...document.querySelectorAll(TABLE_SCROLL_FRAME_SELECTOR)];
}
function tableScrollEdgeTolerance(frame) {
  return Math.max(8, Math.round(frame.clientWidth * 0.015));
}
function syncTableScrollHints() {
  tableScrollFrames().forEach((frame) => {
    const maxScrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
    const edgeTolerance = tableScrollEdgeTolerance(frame);
    const scrollable = maxScrollLeft > edgeTolerance;
    const scrollLeft = Math.max(0, frame.scrollLeft);
    frame.dataset.scrollable = scrollable ? "true" : "false";
    frame.dataset.scrollMoreLeft = scrollable && scrollLeft > edgeTolerance ? "true" : "false";
    frame.dataset.scrollMoreRight = scrollable && scrollLeft < maxScrollLeft - edgeTolerance ? "true" : "false";
  });
}
function scheduleTableScrollHintSync() {
  requestAnimationFrame(syncTableScrollHints);
  setTimeout(syncTableScrollHints, 0);
}
function boundedTableScrollLeft(frame, requestedLeft) {
  const maxScrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const edgeTolerance = tableScrollEdgeTolerance(frame);
  const bounded = Math.max(0, Math.min(maxScrollLeft, requestedLeft));
  if (bounded <= edgeTolerance) return 0;
  if (maxScrollLeft - bounded <= edgeTolerance) return maxScrollLeft;
  return bounded;
}
function scrollTableFrameFromKey(frame, key) {
  const amount = Math.max(240, Math.round(frame.clientWidth * 0.65));
  const maxScrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
  const next = {
    ArrowLeft: frame.scrollLeft - amount,
    ArrowRight: frame.scrollLeft + amount,
    PageUp: frame.scrollLeft - amount,
    PageDown: frame.scrollLeft + amount,
    Home: 0,
    End: maxScrollLeft
  }[key];
  if (next == null) return false;
  frame.scrollLeft = boundedTableScrollLeft(frame, next);
  scheduleTableScrollHintSync();
  return true;
}
function tableScrollDragTarget(event) {
  return event.target?.closest?.("button, a, input, select, textarea, summary, label, [role='button'], [data-no-table-drag]");
}
function wireTableScrollDrag(frame) {
  if (frame.dataset.scrollDragWired === "true") return;
  let dragState = null;
  frame.addEventListener("pointerdown", (event) => {
    if (event.button !== 0 || tableScrollDragTarget(event)) return;
    const maxScrollLeft = Math.max(0, frame.scrollWidth - frame.clientWidth);
    if (maxScrollLeft <= tableScrollEdgeTolerance(frame)) return;
    dragState = {
      pointerId: event.pointerId,
      startX: event.clientX,
      startScrollLeft: frame.scrollLeft,
      moved: false
    };
    frame.classList.add("table-scroll-dragging");
    frame.setPointerCapture?.(event.pointerId);
  });
  frame.addEventListener("pointermove", (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    const delta = event.clientX - dragState.startX;
    if (Math.abs(delta) > 3) dragState.moved = true;
    frame.scrollLeft = boundedTableScrollLeft(frame, dragState.startScrollLeft - delta);
    scheduleTableScrollHintSync();
    if (dragState.moved) event.preventDefault();
  });
  const endDrag = (event) => {
    if (!dragState || dragState.pointerId !== event.pointerId) return;
    frame.releasePointerCapture?.(event.pointerId);
    frame.classList.remove("table-scroll-dragging");
    dragState = null;
    scheduleTableScrollHintSync();
  };
  frame.addEventListener("pointerup", endDrag);
  frame.addEventListener("pointercancel", endDrag);
  frame.addEventListener("lostpointercapture", () => {
    frame.classList.remove("table-scroll-dragging");
    dragState = null;
  });
  frame.dataset.scrollDragWired = "true";
}
function wireTableScrollFrame(frame) {
  if (frame.dataset.scrollHintWired === "true") return;
  frame.addEventListener("scroll", scheduleTableScrollHintSync, { passive: true });
  wireTableScrollDrag(frame);
  frame.addEventListener("keydown", (event) => {
    if (event.target !== frame) return;
    if (!scrollTableFrameFromKey(frame, event.key)) return;
    event.preventDefault();
  });
  frame.dataset.scrollHintWired = "true";
}
function observeTableScrollHints() {
  tableScrollHintObserver?.disconnect();
  const frames = tableScrollFrames();
  if (!frames.length) return;
  frames.forEach(wireTableScrollFrame);
  if (window.ResizeObserver) {
    tableScrollHintObserver = new ResizeObserver(scheduleTableScrollHintSync);
    frames.forEach((frame) => {
      tableScrollHintObserver.observe(frame);
      frame.querySelectorAll("table, .storage-grid, .storage-empty-state").forEach((content) => tableScrollHintObserver.observe(content));
    });
  }
  scheduleTableScrollHintSync();
}
function runEventCount(run) {
  return run.event_count ?? (Array.isArray(run.events) ? run.events.length : 0);
}
function runEvidenceChips(run) {
  const activeOrTerminal = isActiveStatus(run.status) || TERMINAL.has(run.status);
  const eventCount = runEventCount(run);
  return `<div class="evidence-chips" aria-label="Run evidence">
    ${evidenceChip(run, eventCount ? `${eventCount} events` : "events missing", eventCount ? "present" : "missing", eventCount ? "ti-list-check" : "ti-list-x", "RunRecord.events", eventCount ? `${eventCount} saved event summaries` : "No event summaries recorded in the run list projection")}
    ${evidenceChip(run, run.remote_job_id ? "remote id" : activeOrTerminal ? "remote missing" : "remote n/a", run.remote_job_id ? "present" : activeOrTerminal ? "missing" : "not-applicable", run.remote_job_id ? "ti-link" : activeOrTerminal ? "ti-link-off" : "ti-minus", "RunRecord.remote_job_id / supervisor", run.remote_job_id ? `remote id ${run.remote_job_id}` : activeOrTerminal ? "Active run has no remote id in saved local state" : "Remote execution evidence is not applicable yet")}
    ${evidenceChip(run, run.node ? "node" : "node missing", run.node ? "present" : "missing", run.node ? "ti-server" : "ti-server-off", "RunRecord.submission.node / scheduler evidence", run.node ? `observed node ${run.node}` : "No node or execution host recorded")}
    ${evidenceChip(run, run.retry_of ? "lineage" : "no lineage", run.retry_of ? "present" : "not-applicable", run.retry_of ? "ti-git-branch" : "ti-minus", "RunRecord.retry_of", run.retry_of ? `retry source ${run.retry_of.source_run_id}` : "This run is not recorded as a retry or clone")}
  </div>`;
}
function runEvidenceSummaryText(run) {
  const activeOrTerminal = isActiveStatus(run.status) || TERMINAL.has(run.status);
  const eventCount = runEventCount(run);
  const parts = [
    eventCount ? `${eventCount} event summaries` : "events missing",
    run.remote_job_id ? `remote id ${run.remote_job_id}` : activeOrTerminal ? "remote id missing" : "remote id not applicable",
    run.node ? `node ${run.node}` : "node missing",
    run.retry_of ? `retry source ${run.retry_of.source_run_id}` : "no retry lineage"
  ];
  return `Evidence: ${parts.join("; ")}.`;
}
function runProjectSummaryText(run) {
  const parts = [`Project: ${run.project || "—"}`];
  if (run.job_type) parts.push(`job type: ${run.job_type}`);
  if (run.project_hash) parts.push(`hash: ${run.project_hash}`);
  return parts.join("; ");
}
function runDetailEvidenceChips(run, context = {}) {
  const activeOrTerminal = isActiveStatus(run.status) || TERMINAL.has(run.status);
  const eventCount = runEventCount(run);
  const git = run.reproducibility?.git;
  const manifest = context.manifest;
  const plan = context.plan;
  const logs = context.logs;
  const planPresent = Boolean(run.plan_hash && plan?.normalized_job_spec);
  const remotePresent = Boolean(run.remote_job_id || run.supervisor);
  const usagePresent = Boolean(run.usage);
  const approvalState = run.approval?.state;
  const readiness = actionReadinessModel(run, context);
  const conformanceLabel = readiness.state?.startsWith("blocked")
    ? "conformance blocked"
    : readiness.state === "requires-token-confirmation"
      ? "token required"
      : readiness.state === "local-dry-run"
        ? "local dry-run"
        : readiness.state === "not-applicable"
          ? "conformance n/a"
          : "conformance ready";
  const manifestFiles = manifest?.files || manifest?.artifacts || [];
  const artifactLabel = `${manifestFiles.length} artifact${manifestFiles.length === 1 ? "" : "s"}`;
  const logsEvidence = logs?.evidence || [];
  const logsFailed = logsEvidence.filter(logEvidenceIsPartial).length;
  const logsState = logsEvidence.length ? (logsFailed ? "partial" : "present") : TERMINAL.has(run.status) ? "missing" : "not-applicable";
  const logsLabel = logsEvidence.length ? `${logsEvidence.length} log ${logsEvidence.length === 1 ? "entry" : "entries"}` : TERMINAL.has(run.status) ? "logs missing" : "logs n/a";
  const logsDetail = logsEvidence.length
    ? `${logsEvidence.length} saved bounded log evidence entr${logsEvidence.length === 1 ? "y" : "ies"}${logsFailed ? `; ${logsFailed} partial` : ""}.`
    : logs?.note || (TERMINAL.has(run.status) ? "No saved log evidence was found for this terminal run." : "Log evidence is not expected until execution evidence exists.");
  const nodeValue = run.node || run.submission?.node || "";
  const gitDetail = git?.sha
    ? `${git.sha.slice(0, 12)} on ${git.branch || "unknown branch"}${git.dirty ? "; dirty working tree" : "; clean working tree"}`
    : "Git reproducibility evidence has not been recorded for this run.";
  const approvalShort = approvalState === "not_required" ? "auth n/a" : approvalState ? `auth ${approvalState}` : "auth n/a";
  return `<div class="run-detail-evidence-strip mb-3" aria-label="Run detail evidence packet">
    <div class="section-kicker">Evidence packet</div>
    <div class="run-detail-evidence-chips">
      ${evidenceChip(run, remotePresent ? "remote evidence" : activeOrTerminal ? "remote missing" : "remote n/a", remotePresent ? "present" : activeOrTerminal ? "missing" : "not-applicable", remotePresent ? "ti-link" : activeOrTerminal ? "ti-link-off" : "ti-minus", "RunRecord.remote_job_id / supervisor", run.remote_job_id ? `remote id ${run.remote_job_id}` : run.supervisor ? "Supervisor metadata captured." : activeOrTerminal ? "Active or terminal run lacks remote execution evidence." : "Remote execution evidence is not expected yet.", { type: "remote-execution", sourceKind: "run-record", routeTarget: "overview", shortLabel: remotePresent ? "remote" : activeOrTerminal ? "remote missing" : "remote n/a" })}
      ${evidenceChip(run, eventCount ? `${eventCount} lifecycle events` : "events missing", eventCount ? "present" : "missing", eventCount ? "ti-list-check" : "ti-list-x", "RunRecord.events", eventCount ? `${eventCount} lifecycle events available in the detail record.` : "No lifecycle event evidence recorded.", { type: "events", sourceKind: "run-record", routeTarget: "Lifecycle", shortLabel: eventCount ? `${eventCount} events` : "events missing" })}
      ${evidenceChip(run, planPresent ? "plan captured" : run.plan_hash ? "plan partial" : "plan missing", planPresent ? "present" : "missing", planPresent ? "ti-file-check" : "ti-file-alert", "RunRecord.plan_hash + saved plan", planPresent ? `plan ${run.plan_hash.slice(0, 16)} with saved normalized job spec` : run.plan_hash ? "Plan hash exists but saved normalized plan was not loaded." : "No plan hash evidence recorded.", { type: "plan", sourceKind: "saved-plan", routeTarget: "Plan & Resources", shortLabel: planPresent ? "plan" : "plan missing" })}
      ${evidenceChip(run, conformanceLabel, readiness.state?.startsWith("blocked") ? "missing" : readiness.state === "not-applicable" ? "not-applicable" : "present", readiness.state?.startsWith("blocked") ? "ti-shield-x" : "ti-shield-check", "server conformance", readiness.detail || "Action readiness is derived from saved local evidence and still checked by server-side MCP gates.", { type: "conformance", sourceKind: "derived-client-state", routeTarget: "overview", shortLabel: readiness.state?.startsWith("blocked") ? "blocked" : readiness.state === "requires-token-confirmation" ? "token" : "ready" })}
      ${evidenceChip(run, approvalState ? `authorization ${approvalState}` : "authorization n/a", approvalState ? "present" : "not-applicable", approvalState ? "ti-key" : "ti-minus", "RunRecord.approval", approvalState ? `approval state ${approvalState}${run.approval?.bound_plan_hash ? `; bound plan ${String(run.approval.bound_plan_hash).slice(0, 16)}` : ""}` : "No token-confirmed approval record is attached to this run.", { type: "authorization", sourceKind: "approval-record", routeTarget: "overview", shortLabel: approvalShort })}
      ${evidenceChip(run, usagePresent ? "usage captured" : TERMINAL.has(run.status) ? "usage missing" : "usage n/a", usagePresent ? "present" : TERMINAL.has(run.status) ? "missing" : "not-applicable", usagePresent ? "ti-chart-bar" : TERMINAL.has(run.status) ? "ti-chart-bar-off" : "ti-minus", "RunRecord.usage", usagePresent ? "Scheduler/accounting usage evidence is available for right-sizing." : TERMINAL.has(run.status) ? "Terminal run has no saved usage evidence." : "Usage evidence appears after polling or accounting.", { type: "usage", sourceKind: "run-record", routeTarget: "overview", shortLabel: usagePresent ? "usage" : TERMINAL.has(run.status) ? "usage missing" : "usage n/a" })}
      ${evidenceChip(run, git?.dirty ? "git dirty" : git?.sha ? "git clean" : "git missing", git?.sha ? "present" : "missing", git?.dirty ? "ti-git-compare" : git?.sha ? "ti-git-commit" : "ti-git-branch-deleted", "RunRecord.reproducibility.git", gitDetail, { type: "reproducibility", sourceKind: "run-record", routeTarget: "overview", shortLabel: git?.dirty ? "dirty git" : git?.sha ? "git clean" : "git missing" })}
      ${evidenceChip(run, logsLabel, logsState, logsEvidence.length ? "ti-file-text" : TERMINAL.has(run.status) ? "ti-file-alert" : "ti-minus", "Saved job-operation log evidence", logsDetail, { type: "logs", sourceKind: "job-operation", routeTarget: "Logs", shortLabel: logsEvidence.length ? `${logsEvidence.length} logs` : TERMINAL.has(run.status) ? "logs missing" : "logs n/a" })}
      ${evidenceChip(run, manifest ? artifactLabel : "manifest missing", manifest ? (manifestFiles.length ? "present" : "partial") : "missing", manifest ? "ti-package" : "ti-package-off", "Artifact manifest", manifest ? `${manifestFiles.length} artifact row${manifestFiles.length === 1 ? "" : "s"} listed from saved manifest.` : "Artifact manifest evidence has not been captured yet.", { type: "artifacts", sourceKind: "artifact-manifest", routeTarget: "Artifacts", shortLabel: manifest ? "artifacts" : "manifest missing" })}
      ${evidenceChip(run, nodeValue ? "node evidence" : activeOrTerminal ? "node missing" : "node n/a", nodeValue ? "present" : activeOrTerminal ? "missing" : "not-applicable", nodeValue ? "ti-server" : activeOrTerminal ? "ti-server-off" : "ti-minus", "RunRecord.submission.node / scheduler evidence", nodeValue ? `observed node ${nodeValue}` : "No node or execution-host evidence recorded.", { type: "remote-execution", sourceKind: "run-record", routeTarget: "overview", shortLabel: nodeValue ? "node" : activeOrTerminal ? "node missing" : "node n/a" })}
      ${evidenceChip(run, run.retry_of?.source_run_id ? "lineage captured" : "lineage n/a", run.retry_of?.source_run_id ? "present" : "not-applicable", run.retry_of?.source_run_id ? "ti-git-branch" : "ti-minus", "RunRecord.retry_of", run.retry_of?.source_run_id ? `retry source ${run.retry_of.source_run_id}` : "This run is not recorded as a retry or clone.", { type: "lineage", sourceKind: "run-record", routeTarget: "Lifecycle", shortLabel: run.retry_of?.source_run_id ? "lineage" : "lineage n/a" })}
    </div>
  </div>`;
}
function actionReadinessModel(run, context = {}) {
  const plan = context.plan;
  const planLoaded = Boolean(plan?.normalized_job_spec);
  if (run.status === "planned") {
    const hasPlanHash = Boolean(run.plan_hash);
    const hasRequiredPlan = context.plan ? hasPlanHash && planLoaded : hasPlanHash;
    return {
      action: "submit",
      actionLabel: "Submit",
      modalTitle: "Submit run",
      state: hasRequiredPlan ? "autonomous-conformant" : "blocked-nonconformant",
      label: hasRequiredPlan ? "conformance ready" : "blocked",
      detail: hasRequiredPlan
        ? "Fresh quota check runs on submit"
        : hasPlanHash
          ? "Saved plan payload missing"
          : "Plan hash evidence missing",
      icon: hasRequiredPlan ? "ti-shield-check" : "ti-alert-triangle",
      buttonIcon: "ti-rocket",
      buttonTone: "primary",
      disabled: !hasRequiredPlan,
      disabledReason: hasRequiredPlan ? "" : hasPlanHash ? "Saved plan payload missing" : "Plan hash evidence missing",
      evidence: [
        hasPlanHash ? `<code>plan ${esc(run.plan_hash.slice(0, 12))}</code>` : `<span class="text-secondary">plan hash missing</span>`,
        context.plan ? (planLoaded ? `<span>saved plan</span>` : `<span class="text-secondary">saved plan missing</span>`) : `<span>list projection</span>`,
        `<span>${esc(requestedText(run, context))}</span>`
      ]
    };
  }
  if (isActiveStatus(run.status)) {
    const hasRemote = Boolean(run.remote_job_id || run.supervisor);
    return {
      action: "abort",
      actionLabel: "Cancel",
      modalTitle: "Cancel run",
      state: hasRemote ? "requires-token-confirmation" : "blocked-nonconformant",
      label: hasRemote ? "approval required" : "blocked",
      detail: hasRemote ? "Needs approval token before cancelling" : "Remote execution evidence missing",
      icon: hasRemote ? "ti-shield-lock" : "ti-link-off",
      buttonIcon: "ti-ban",
      buttonTone: "outline-danger",
      disabled: !hasRemote,
      disabledReason: hasRemote ? "" : "Remote execution evidence missing",
      evidence: [
        run.remote_job_id ? `<code>${esc(run.remote_job_id)}</code>` : `<span class="text-secondary">remote id missing</span>`,
        run.supervisor ? `<span>supervisor metadata</span>` : `<span class="text-secondary">supervisor missing</span>`,
        run.approval?.state ? `<span>approval ${esc(run.approval.state)}</span>` : `<span class="text-secondary">approval unknown</span>`
      ]
    };
  }
  if (TERMINAL.has(run.status)) {
    return {
      action: "clone",
      actionLabel: "Clone / Rerun",
      modalTitle: "Clone run",
      state: "advisory-only",
      label: "local dry-run",
      detail: "Creates a retry plan only",
      icon: "ti-copy",
      buttonIcon: "ti-copy",
      buttonTone: "outline-primary",
      disabled: false,
      disabledReason: "",
      evidence: [
        run.plan_hash ? `<code>source plan ${esc(run.plan_hash.slice(0, 12))}</code>` : `<span class="text-secondary">source plan missing</span>`,
        run.retry_of?.source_run_id ? `<span>retry lineage present</span>` : `<span>new clone allowed</span>`
      ]
    };
  }
  return {
    action: "",
    actionLabel: "",
    modalTitle: "Action readiness",
    state: "not-applicable",
    label: "n/a",
    detail: "No action is available for this state.",
    icon: "ti-minus",
    buttonIcon: "ti-minus",
    buttonTone: "outline-secondary",
    disabled: true,
    disabledReason: "No WebUI action is available",
    evidence: []
  };
}
function runRequestedResources(run) {
  return run.submission?.requested || run.requested || {};
}
function runUsageSummaryLine(run) {
  const usage = run.usage;
  if (!usage && isActiveStatus(run.status) && run.remote_job_id && run.platform === "uts-ihpc") {
    return "runtime active · usage pending";
  }
  return usage
    ? [
        usage.core_hours != null && `${usage.core_hours} core-h`,
        usage.gpu_hours != null && `${usage.gpu_hours} gpu-h`,
        usage.cpu_efficiency_percent != null && `${usage.cpu_efficiency_percent}% CPU`,
        usage.mem_gb != null && `${usage.mem_gb} GB used`
      ].filter(Boolean).join(" · ") || "usage captured"
    : "usage missing";
}
function runResourceFitLine(run) {
  const fit = resourceFitCandidate({ ...run, requested: runRequestedResources(run) });
  if (fit) return fit.reasons[0];
  if (!run.usage && isActiveStatus(run.status) && run.remote_job_id && run.platform === "uts-ihpc") {
    return "iHPC runtime evidence only";
  }
  return run.usage ? "no clear issue" : "waiting for usage evidence";
}
function runResourceSummaryText(run) {
  return `Requested: ${requestedText(run)}. Usage: ${runUsageSummaryLine(run)}. Fit: ${runResourceFitLine(run)}.`;
}
function runResourceSummary(run) {
  const req = runRequestedResources(run);
  const summary = runResourceSummaryText(run);
  const usage = run.usage;
  const requested = requestedText(run);
  const usageLine = runUsageSummaryLine(run);
  const fitHtml = usage ? resourceFitCell({ ...run, requested: req }) : "";
  const requestedIcon = requested === "—" && isActiveStatus(run.status) && run.remote_job_id ? "ti-terminal-2" : "ti-adjustments";
  return `<div class="runs-resource-summary">
    <div class="runs-resource-requested" title="${esc(summary)}"><i class="ti ${esc(requestedIcon)}"></i><span>${esc(requested === "—" && isActiveStatus(run.status) && run.remote_job_id ? "runtime only" : requested)}</span></div>
    <div class="runs-resource-usage ${usage ? "" : "text-secondary"}" title="${esc(summary)}"><i class="ti ${usage ? "ti-chart-bar" : "ti-database-off"}"></i><span>${esc(usageLine)}</span></div>
    ${fitHtml}
  </div>`;
}
function runViewCount(runs, viewName) {
  return viewName === "all" ? runs.length : runs.filter((run) => runViewMatches(run, viewName)).length;
}
function runViewMatches(run, viewName) {
  if (!viewName || viewName === "all") return true;
  if (viewName === "active") return isActiveStatus(run.status);
  if (viewName === "attention") return needsAttention(run);
  if (viewName === "over-requested") return isOverRequested(run);
  if (viewName === "dirty-git") return hasDirtyGit(run);
  if (viewName === "missing-evidence") return hasMissingEvidence(run);
  if (viewName === "queued") return run.status === "submitted" || run.status === "submitting";
  return run.status === viewName;
}
function normalizeRunSort(key, dir) {
  const safeKey = RUN_SORT_KEYS.has(key) ? key : RUN_SORT_DEFAULT.key;
  const safeDir = dir === "asc" || dir === "desc" ? dir : (safeKey === "created" ? "desc" : "asc");
  return { key: safeKey, dir: safeDir };
}
function runSortLabel(key) {
  return {
    name: "Run",
    status: "Status",
    project: "Project",
    platform: "Platform",
    queue: "Queue",
    cluster: "Cluster",
    node: "Node",
    created: "Created"
  }[key] || key;
}
function runColumnLabel(key) {
  return RUN_OPTIONAL_COLUMNS.find((column) => column.key === key)?.label || runSortLabel(key);
}
function runSortValue(run, key) {
  if (!run) return "";
  if (key === "name") return run.run_id || "";
  if (key === "status") return STATUS_SORT_ORDER[run.status] ?? 99;
  if (key === "project") return run.project || "—";
  if (key === "platform") return run.platform || "";
  if (key === "queue") return runQueue(run);
  if (key === "cluster") return run.cluster || "—";
  if (key === "node") return run.node || "—";
  if (key === "created") return new Date(run.created_at || 0).getTime() || 0;
  return "";
}
function compareRunSortValues(a, b, key) {
  const av = runSortValue(a, key);
  const bv = runSortValue(b, key);
  if (typeof av === "number" && typeof bv === "number") return av - bv;
  return String(av).localeCompare(String(bv), undefined, { numeric: true, sensitivity: "base" });
}
function compareRunsForSort(a, b, sort) {
  const primary = compareRunSortValues(a, b, sort.key);
  const value = primary || compareRunSortValues(a, b, "name");
  return sort.dir === "desc" ? -value : value;
}
function nextRunSort(current, key) {
  const nextDir = current.key === key
    ? (current.dir === "asc" ? "desc" : "asc")
    : (key === "created" ? "desc" : "asc");
  return normalizeRunSort(key, nextDir);
}
function runSortFromQuery(query = routeQuery()) {
  return normalizeRunSort(query.get("sort") || RUN_SORT_DEFAULT.key, query.get("dir") || RUN_SORT_DEFAULT.dir);
}
function runSortHeading(key, label, activeSort, title = "", columnKey = "") {
  const active = activeSort.key === key;
  const next = nextRunSort(activeSort, key);
  const ariaSort = active ? (activeSort.dir === "asc" ? "ascending" : "descending") : "none";
  const icon = active ? (activeSort.dir === "asc" ? "ti-sort-ascending" : "ti-sort-descending") : "ti-arrows-sort";
  return `<th class="runs-sort-heading ${active ? "runs-sort-active" : ""}" data-sort="${esc(key)}" aria-sort="${ariaSort}"${title ? ` title="${esc(title)}"` : ""}${columnKey ? ` data-run-column="${esc(columnKey)}"` : ""}>
    <button type="button" class="runs-sort-button" data-run-sort="${esc(key)}" data-next-dir="${esc(next.dir)}" aria-label="Sort runs by ${esc(label)} ${esc(next.dir === "asc" ? "ascending" : "descending")}">
      <span>${esc(label)}</span><i class="ti ${esc(icon)}"></i>
    </button>
  </th>`;
}
function runActiveFilterLabel(viewDefs, { statusF, projF, platformF, queueF, searchF }) {
  const parts = [];
  const activeLabel = viewDefs.find(([value]) => value === statusF)?.[1] || statusF;
  if (statusF && statusF !== "all") parts.push(activeLabel);
  if (projF) parts.push(`Project ${projF}`);
  if (platformF) parts.push(platformLabel(platformF));
  if (queueF) parts.push(`Queue ${queueF}`);
  if (searchF) parts.push(`Search "${searchF}"`);
  return parts.length ? parts.join(" · ") : "All runs";
}
function runsHasActiveFilters({ statusF = "all", projF = "", platformF = "", queueF = "", searchF = "", sort } = {}) {
  const currentSort = sort ? normalizeRunSort(sort.key, sort.dir) : RUN_SORT_DEFAULT;
  return Boolean(
    (statusF && statusF !== "all") ||
    projF ||
    platformF ||
    queueF ||
    searchF ||
    currentSort.key !== RUN_SORT_DEFAULT.key ||
    currentSort.dir !== RUN_SORT_DEFAULT.dir
  );
}
function runTableWidthRem(visibleColumns = loadRunColumnSet()) {
  const fixed = ["compare", "run", "status", "resources"];
  const baseWidth = fixed.reduce((sum, key) => sum + RUN_COLUMN_WIDTH_REM[key], 0);
  const optionalWidth = RUN_OPTIONAL_COLUMNS
    .filter((column) => visibleColumns.has(column.key))
    .reduce((sum, column) => sum + (RUN_COLUMN_WIDTH_REM[column.key] || 0), 0);
  return Number((baseWidth + optionalWidth).toFixed(2));
}
function runsViewSummaryBody(viewDefs, filters, matching, total) {
  const sort = normalizeRunSort(filters.sort?.key, filters.sort?.dir);
  const filterLabel = runActiveFilterLabel(viewDefs, filters);
  const nonDefaultSort = sort.key !== RUN_SORT_DEFAULT.key || sort.dir !== RUN_SORT_DEFAULT.dir;
  if (filterLabel === "All runs" && !nonDefaultSort) return "";
  return `<div class="runs-view-summary-title">
      <span class="section-kicker">View</span>
      <strong>${esc(filterLabel)}${nonDefaultSort ? ` · sorted ${esc(runSortLabel(sort.key))} ${esc(sort.dir)}` : ""}</strong>
    </div>`;
}
function syncRunsViewSummary(viewDefs, filters, matching, total) {
  const summary = document.getElementById("runs-view-summary");
  const workbench = document.getElementById("runs-workbench");
  if (!summary || !workbench) return;
  workbench.dataset.viewFilters = JSON.stringify({
    statusF: filters.statusF || "all",
    projF: filters.projF || "",
    platformF: filters.platformF || "",
    queueF: filters.queueF || "",
    searchF: filters.searchF || "",
    sort: normalizeRunSort(filters.sort?.key, filters.sort?.dir)
  });
  workbench.dataset.viewDefs = JSON.stringify(viewDefs);
  workbench.dataset.viewMatching = String(matching);
  workbench.dataset.viewTotal = String(total);
  summary.innerHTML = runsViewSummaryBody(viewDefs, filters, matching, total);
}
function syncRunsViewSummaryFromWorkbench() {
  const workbench = document.getElementById("runs-workbench");
  if (!workbench?.dataset.viewFilters || !workbench.dataset.viewDefs) return;
  try {
    syncRunsViewSummary(
      JSON.parse(workbench.dataset.viewDefs),
      JSON.parse(workbench.dataset.viewFilters),
      Number(workbench.dataset.viewMatching || 0),
      Number(workbench.dataset.viewTotal || 0)
    );
  } catch {
    // Ignore corrupt transient DOM state; the next filter pass will rebuild it.
  }
}
function syncRunsSortHeadings(sort) {
  document.querySelectorAll("[data-run-sort]").forEach((button) => {
    const key = button.dataset.runSort;
    const th = button.closest("th");
    const active = key === sort.key;
    const next = nextRunSort(sort, key);
    const label = runSortLabel(key);
    th?.classList.toggle("runs-sort-active", active);
    th?.setAttribute("aria-sort", active ? (sort.dir === "asc" ? "ascending" : "descending") : "none");
    button.dataset.nextDir = next.dir;
    button.setAttribute("aria-label", `Sort runs by ${label} ${next.dir === "asc" ? "ascending" : "descending"}`);
    const icon = button.querySelector("i");
    if (icon) icon.className = `ti ${active ? (sort.dir === "asc" ? "ti-sort-ascending" : "ti-sort-descending") : "ti-arrows-sort"}`;
  });
}
function defaultRunColumnSet() {
  return new Set(RUN_OPTIONAL_COLUMNS.filter((column) => column.defaultVisible).map((column) => column.key));
}
function hasSavedRunColumnPreference() {
  return Boolean(localStorage.getItem(RUN_COLUMN_STORAGE_KEY)) &&
    localStorage.getItem(RUN_COLUMN_STORAGE_VERSION_KEY) === RUN_COLUMN_DEFAULT_VERSION;
}
function loadRunColumnSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(RUN_COLUMN_STORAGE_KEY) || "null");
    if (Array.isArray(raw)) {
      const filtered = raw.filter((key) => RUN_OPTIONAL_COLUMN_KEYS.has(key));
      if (localStorage.getItem(RUN_COLUMN_STORAGE_VERSION_KEY) !== RUN_COLUMN_DEFAULT_VERSION) {
        const nextDefault = defaultRunColumnSet();
        saveRunColumnSet(nextDefault);
        return nextDefault;
      }
      return new Set(filtered);
    }
  } catch {
    // Ignore corrupt local preferences and fall back to the curated default set.
  }
  return defaultRunColumnSet();
}
function recommendedRunColumnSet(runs = []) {
  const columns = defaultRunColumnSet();
  const meaningfulProjects = uniqueSorted(runs.map((run) => run.project).filter((project) => project && project !== "unassigned"));
  const platforms = uniqueSorted(runs.map((run) => run.platform).filter(Boolean));
  const queues = uniqueSorted(runs.map(runQueue).filter((queue) => queue && queue !== "—"));
  const clusters = uniqueSorted(runs.map((run) => run.cluster || run.account_label).filter(Boolean));
  const nodes = uniqueSorted(runs.map((run) => run.node).filter(Boolean));
  const evidenceNeedsTable = runs.some((run) => run.status === "failed" || hasMissingEvidence(run) || hasDirtyGit(run));
  if (!meaningfulProjects.length) columns.delete("project");
  if (platforms.length > 1 || runs.some((run) => run.platform === "uts-ihpc")) columns.add("platform");
  if (queues.length > 1) columns.add("queue");
  if (clusters.length > 1 && nodes.length <= 1) columns.add("cluster");
  if (nodes.length > 1) columns.add("node");
  if (evidenceNeedsTable) columns.add("evidence");
  return columns;
}
function initialRunColumnSet(runs = []) {
  return hasSavedRunColumnPreference() ? loadRunColumnSet() : recommendedRunColumnSet(runs);
}
function saveRunColumnSet(visibleColumns) {
  localStorage.setItem(RUN_COLUMN_STORAGE_KEY, JSON.stringify([...visibleColumns].filter((key) => RUN_OPTIONAL_COLUMN_KEYS.has(key))));
  localStorage.setItem(RUN_COLUMN_STORAGE_VERSION_KEY, RUN_COLUMN_DEFAULT_VERSION);
}
function runColumnMenu(visibleColumns = defaultRunColumnSet()) {
  const visibleCount = RUN_OPTIONAL_COLUMNS.filter((column) => visibleColumns.has(column.key)).length;
  return `<details class="runs-column-menu" id="runs-column-menu">
    <summary class="btn btn-sm btn-outline-secondary runs-column-summary">
      <i class="ti ti-columns-3 me-1"></i>Columns <span class="badge bg-secondary-lt ms-1" id="runs-column-count">${visibleCount}</span>
    </summary>
    <div class="runs-column-panel" role="group" aria-label="Optional run table columns">
      <div class="runs-column-panel-head">
        <span class="section-kicker">Optional columns</span>
        <button type="button" class="btn btn-sm btn-link p-0" id="runs-column-reset" aria-label="Reset visible run table columns" title="Reset visible columns">Reset</button>
      </div>
      ${RUN_OPTIONAL_COLUMNS.map((column) => `<label class="form-check runs-column-option">
        <input class="form-check-input" type="checkbox" data-run-column-toggle="${esc(column.key)}" ${visibleColumns.has(column.key) ? "checked" : ""}>
        <span class="form-check-label">${esc(column.label)}</span>
      </label>`).join("")}
    </div>
  </details>`;
}
function applyRunColumnVisibility(visibleColumns) {
  const workbench = document.getElementById("runs-workbench");
  if (!workbench) return;
  document.getElementById("runs-table")?.style.setProperty("--runs-table-width", `${runTableWidthRem(visibleColumns)}rem`);
  const hidden = [];
  RUN_OPTIONAL_COLUMNS.forEach((column) => {
    const isVisible = visibleColumns.has(column.key);
    if (!isVisible) hidden.push(column.key);
    document.querySelectorAll(`[data-run-column="${column.key}"]`).forEach((el) => {
      el.classList.toggle("runs-column-hidden", !isVisible);
      el.setAttribute("aria-hidden", isVisible ? "false" : "true");
    });
    document.querySelectorAll(`[data-run-column-toggle="${column.key}"]`).forEach((input) => {
      input.checked = isVisible;
    });
  });
  workbench.dataset.hiddenColumns = hidden.join(" ");
  const countEl = document.getElementById("runs-column-count");
  if (countEl) countEl.textContent = String(RUN_OPTIONAL_COLUMNS.length - hidden.length);
  syncRunsViewSummaryFromWorkbench();
  scheduleTableScrollHintSync();
}
function wireRunsColumnVisibility(initialColumns = null) {
  if (!document.getElementById("runs-column-menu")) return;
  let visibleColumns = initialColumns ? new Set(initialColumns) : loadRunColumnSet();
  applyRunColumnVisibility(visibleColumns);
  document.querySelectorAll("[data-run-column-toggle]").forEach((input) => {
    input.addEventListener("change", () => {
      const key = input.dataset.runColumnToggle;
      if (!RUN_OPTIONAL_COLUMN_KEYS.has(key)) return;
      if (input.checked) visibleColumns.add(key);
      else visibleColumns.delete(key);
      saveRunColumnSet(visibleColumns);
      applyRunColumnVisibility(visibleColumns);
      announceStatus(`Runs table columns updated: ${[...visibleColumns].map(runColumnLabel).join(", ") || "priority columns only"}.`);
    });
  });
  document.getElementById("runs-column-reset")?.addEventListener("click", () => {
    visibleColumns = initialColumns ? new Set(initialColumns) : defaultRunColumnSet();
    saveRunColumnSet(visibleColumns);
    applyRunColumnVisibility(visibleColumns);
    announceStatus("Runs table columns reset to the default view.");
  });
}
function wireRunsToolbarMenus() {
  const menus = [...document.querySelectorAll(".runs-column-menu, .runs-saved-views")];
  const closeMenus = ({ restoreFocus = false } = {}) => {
    let closed = false;
    let focusTarget = null;
    document.querySelectorAll(".runs-column-menu, .runs-saved-views").forEach((menu) => {
      if (!menu.open) return;
      closed = true;
      focusTarget ||= menu.querySelector("summary");
      menu.open = false;
    });
    if (restoreFocus && focusTarget instanceof HTMLElement) {
      focusTarget.focus({ preventScroll: true });
    }
    return closed;
  };
  menus.forEach((menu) => {
    if (menu.dataset.runsMenuBound === "true") return;
    menu.dataset.runsMenuBound = "true";
    menu.addEventListener("toggle", () => {
      if (!menu.open) return;
      menus.forEach((other) => {
        if (other !== menu) other.open = false;
      });
    });
  });
  if (document.body.dataset.runsToolbarMenusGlobalBound === "true") return;
  document.body.dataset.runsToolbarMenusGlobalBound = "true";
  document.addEventListener("click", (event) => {
    if (event.target.closest(".runs-column-menu, .runs-saved-views")) return;
    closeMenus();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    const activeInMenu = event.target.closest(".runs-column-menu, .runs-saved-views");
    const closed = closeMenus({ restoreFocus: Boolean(activeInMenu) });
    if (closed && activeInMenu) event.preventDefault();
  });
}
function sanitizeRunSavedView(raw, index = 0) {
  if (!raw || typeof raw !== "object") return null;
  const filters = raw.filters && typeof raw.filters === "object" ? raw.filters : {};
  const columns = Array.isArray(raw.columns)
    ? raw.columns.filter((key) => RUN_OPTIONAL_COLUMN_KEYS.has(key))
    : [...defaultRunColumnSet()];
  return {
    id: String(raw.id || `view-${index}`).replace(/[^\w-]/g, "").slice(0, 40) || `view-${index}`,
    name: String(raw.name || `Runs view ${index + 1}`).trim().slice(0, 48) || `Runs view ${index + 1}`,
    filters: {
      statusF: String(filters.statusF || "all").slice(0, 64),
      projF: String(filters.projF || "").slice(0, 96),
      platformF: String(filters.platformF || "").slice(0, 64),
      queueF: String(filters.queueF || "").slice(0, 96),
      searchF: String(filters.searchF || "").slice(0, 120)
    },
    sort: normalizeRunSort(raw.sort?.key, raw.sort?.dir),
    columns,
    density: raw.density === "compact" ? "compact" : "comfortable",
    created_at: raw.created_at || new Date().toISOString()
  };
}
function loadRunSavedViews() {
  try {
    const raw = JSON.parse(localStorage.getItem(RUN_VIEW_STORAGE_KEY) || "[]");
    if (Array.isArray(raw)) {
      return raw.map(sanitizeRunSavedView).filter(Boolean).slice(0, MAX_SAVED_RUN_VIEWS);
    }
  } catch {
    // Ignore corrupt local preferences and start from an empty local view set.
  }
  return [];
}
function saveRunSavedViews(views) {
  localStorage.setItem(RUN_VIEW_STORAGE_KEY, JSON.stringify(views.map(sanitizeRunSavedView).filter(Boolean).slice(0, MAX_SAVED_RUN_VIEWS)));
}
function runSavedViewParams(savedView) {
  const params = new URLSearchParams();
  const filters = savedView.filters || {};
  if (filters.statusF && filters.statusF !== "all") params.set("view", filters.statusF);
  if (filters.projF) params.set("project", filters.projF);
  if (filters.platformF) params.set("platform", filters.platformF);
  if (filters.queueF) params.set("queue", filters.queueF);
  if (filters.searchF) params.set("q", filters.searchF);
  const sort = normalizeRunSort(savedView.sort?.key, savedView.sort?.dir);
  if (sort.key !== RUN_SORT_DEFAULT.key || sort.dir !== RUN_SORT_DEFAULT.dir) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  return params;
}
function runsSavedViewsMenu(savedViews = []) {
  return `<details class="runs-saved-views" id="runs-saved-views">
    <summary class="btn btn-sm btn-outline-secondary runs-saved-summary">
      <i class="ti ti-bookmarks me-1"></i>Views <span class="badge bg-secondary-lt ms-1" id="runs-saved-view-count">${savedViews.length}</span>
    </summary>
    <div class="runs-saved-panel" aria-label="Saved run views">
      <div class="runs-saved-panel-head">
        <span class="section-kicker">Saved views</span>
        <span class="text-secondary small">local only</span>
      </div>
      <div class="input-group input-group-sm">
        <input class="form-control" id="runs-saved-view-name" maxlength="48" placeholder="View name" aria-label="Saved view name">
        <button class="btn btn-outline-primary" type="button" data-runs-save-view aria-label="Save current run filters and columns" title="Save current view">Save current</button>
      </div>
      <div class="runs-saved-list">
        ${savedViews.length ? savedViews.map((savedView) => `<div class="runs-saved-row">
          <button type="button" class="runs-saved-apply" data-runs-apply-view="${esc(savedView.id)}" title="${esc(savedView.name)}">
            <span>${esc(savedView.name)}</span>
            <small>${esc(runSortLabel(savedView.sort.key))} ${esc(savedView.sort.dir)} · ${esc(savedView.density)}</small>
          </button>
          <button type="button" class="btn btn-icon btn-sm btn-ghost-secondary runs-saved-delete" data-runs-delete-view="${esc(savedView.id)}" aria-label="Delete saved view ${esc(savedView.name)}"><i class="ti ti-trash"></i></button>
        </div>`).join("") : `<div class="runs-saved-empty text-secondary small">No saved views yet.</div>`}
      </div>
    </div>
  </details>`;
}
function wireRunsSavedViews(getState) {
  const menu = document.getElementById("runs-saved-views");
  if (!menu) return;
  const rerenderRuns = () => router();
  menu.querySelector("[data-runs-save-view]")?.addEventListener("click", () => {
    const state = getState();
    const existing = loadRunSavedViews();
    const input = document.getElementById("runs-saved-view-name");
    const defaultName = `Runs view ${existing.length + 1}`;
    const savedView = sanitizeRunSavedView({
      id: `view-${Date.now().toString(36)}`,
      name: input?.value.trim() || defaultName,
      filters: {
        statusF: state.statusF || "all",
        projF: state.projF || "",
        platformF: state.platformF || "",
        queueF: state.queueF || "",
        searchF: state.searchF || ""
      },
      sort: normalizeRunSort(state.sort?.key, state.sort?.dir),
      columns: [...loadRunColumnSet()],
      density: localStorage.getItem(RUN_DENSITY_STORAGE_KEY) === "compact" ? "compact" : "comfortable",
      created_at: new Date().toISOString()
    }, existing.length);
    saveRunSavedViews([savedView, ...existing.filter((view) => view.name !== savedView.name)].slice(0, MAX_SAVED_RUN_VIEWS));
    announceStatus(`Runs view saved: ${savedView.name}.`);
    rerenderRuns();
  });
  menu.querySelectorAll("[data-runs-apply-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const savedView = loadRunSavedViews().find((view) => view.id === button.dataset.runsApplyView);
      if (!savedView) return;
      saveRunColumnSet(new Set(savedView.columns));
      localStorage.setItem(RUN_DENSITY_STORAGE_KEY, savedView.density);
      history.replaceState(null, "", routeUrl("/runs", runSavedViewParams(savedView)));
      announceStatus(`Runs view applied: ${savedView.name}.`);
      rerenderRuns();
    });
  });
  menu.querySelectorAll("[data-runs-delete-view]").forEach((button) => {
    button.addEventListener("click", () => {
      const remaining = loadRunSavedViews().filter((view) => view.id !== button.dataset.runsDeleteView);
      saveRunSavedViews(remaining);
      announceStatus("Runs saved view deleted.");
      rerenderRuns();
    });
  });
}
function cleanPath(path = location.pathname) {
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized === "/" ? "/runs" : normalized;
}
function canonicalPath(path = location.pathname) {
  const cleaned = cleanPath(path);
  return cleaned === "/queue" ? "/capacity" : cleaned;
}
function routePath() {
  return canonicalPath();
}
function routeQuery() {
  return new URLSearchParams(location.search);
}
function routeUrl(path, params = new URLSearchParams()) {
  const qs = params.toString();
  return `${path}${qs ? `?${qs}` : ""}`;
}
function replaceRouteQuery(path, params) {
  history.replaceState(null, "", routeUrl(path, params));
}
function navigateTo(path, params = new URLSearchParams(), { replace = false } = {}) {
  const next = routeUrl(canonicalPath(path), params);
  if (`${location.pathname}${location.search}` === next) return;
  history[replace ? "replaceState" : "pushState"](null, "", next);
  router();
}
function isAppRoutePath(pathname) {
  return /^\/(?:runs(?:\/[^/]+)?|compare|explore|capacity|queue|projects|node-load)$/.test(cleanPath(pathname));
}
function appNavElements() {
  const nav = document.getElementById("nav");
  const toggle = document.querySelector(".navbar-toggler[data-bs-target=\"#nav\"]");
  return { nav, toggle };
}
function setAppNavExpanded(expanded) {
  const { nav, toggle } = appNavElements();
  if (!nav) return;
  nav.classList.toggle("show", expanded);
  toggle?.classList.toggle("collapsed", !expanded);
  toggle?.setAttribute("aria-expanded", expanded ? "true" : "false");
}
function collapseAppNav() {
  const { nav } = appNavElements();
  if (!nav?.classList.contains("show")) return;
  setAppNavExpanded(false);
}
function wireAppNavToggle() {
  const { nav, toggle } = appNavElements();
  if (!nav || !toggle) return;
  setAppNavExpanded(nav.classList.contains("show"));
  toggle.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    setAppNavExpanded(!nav.classList.contains("show"));
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") collapseAppNav();
  });
}
function wireInternalNavigation() {
  document.addEventListener("click", (event) => {
    const link = event.target.closest?.("a[href]");
    if (!link || link.target || link.hasAttribute("download")) return;
    const url = new URL(link.href, location.origin);
    if (url.origin !== location.origin || !isAppRoutePath(url.pathname)) return;
    event.preventDefault();
    const shouldCollapseNav = Boolean(link.closest("#nav"));
    navigateTo(cleanPath(url.pathname), new URLSearchParams(url.search));
    if (shouldCollapseNav) collapseAppNav();
  });
}
function migrateLegacyHashRoute() {
  if (!location.hash.startsWith("#/")) return false;
  const legacy = location.hash.slice(1) || "/runs";
  const [rawPath, rawQuery = ""] = legacy.split("?");
  const path = canonicalPath(rawPath || "/runs");
  const next = `${path}${rawQuery ? `?${rawQuery}` : ""}`;
  history.replaceState(null, "", next);
  return true;
}
function migrateLegacyPageRoute() {
  const path = cleanPath();
  const canonical = canonicalPath(path);
  if (path === canonical) return false;
  history.replaceState(null, "", routeUrl(canonical, routeQuery()));
  return true;
}
function compareSet() {
  try {
    const raw = JSON.parse(localStorage.getItem(COMPARE_STORAGE_KEY) || "[]");
    return new Set(Array.isArray(raw) ? raw.filter(Boolean).slice(0, MAX_COMPARE_RUNS) : []);
  } catch {
    return new Set();
  }
}
function saveCompareSet(set) {
  localStorage.setItem(COMPARE_STORAGE_KEY, JSON.stringify([...set].slice(0, MAX_COMPARE_RUNS)));
}
function compareHref(set = compareSet()) {
  const ids = [...set].slice(0, MAX_COMPARE_RUNS);
  return `/compare${ids.length ? `?runs=${ids.map(encodeURIComponent).join(",")}` : ""}`;
}
function compareBarHtml(selectedCompare) {
  return `<div class="compare-bar">
       <div class="compare-bar-summary"><span class="compare-count" id="compare-count">${selectedCompare.size} selected for compare</span><span class="compare-helper text-secondary small">Visibility only · no batch actions</span></div>
       <div class="btn-list">
         <a class="btn btn-sm btn-outline-primary compare-action-button" id="compare-open" aria-disabled="false" aria-label="Open selected runs comparison" title="Compare selected" href="${esc(compareHref(selectedCompare))}"><span class="compare-action-label">Compare selected</span><span class="compare-action-short" aria-hidden="true">Open</span></a>
         <button class="btn btn-sm btn-outline-secondary compare-action-button" id="compare-clear" type="button" aria-label="Clear selected runs comparison" title="Clear compare"><span class="compare-action-label">Clear compare</span><span class="compare-action-short" aria-hidden="true">Clear</span></button>
       </div>
     </div>`;
}
function compareParams(ids, { mode = "diff", ref = "" } = {}) {
  const params = new URLSearchParams();
  const selectedIds = [...ids].filter(Boolean).slice(0, MAX_COMPARE_RUNS);
  if (selectedIds.length) params.set("runs", selectedIds.join(","));
  if (mode === "all") params.set("mode", "all");
  if (ref) params.set("ref", ref);
  return params;
}
function compareIdsFromRoute() {
  const raw = routeQuery().get("runs") || "";
  return [...new Set(raw.split(",").map((id) => decodeURIComponent(id).trim()).filter(Boolean))].slice(0, MAX_COMPARE_RUNS);
}
function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? esc(iso) : d.toLocaleString();
}
function fmtDuration(a, b) {
  if (!a || !b) return "—";
  const ms = new Date(b).getTime() - new Date(a).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}
// Compact relative time ("3m ago", "in 2h"). Absolute string stays available via fmtTime (tooltip).
function fmtRel(iso) {
  if (!iso) return "—";
  const t = new Date(iso).getTime();
  if (Number.isNaN(t)) return esc(iso);
  let s = Math.round((Date.now() - t) / 1000);
  const future = s < 0;
  s = Math.abs(s);
  if (s < 5) return "just now";
  for (const [label, secs] of [["y", 31536000], ["mo", 2592000], ["d", 86400], ["h", 3600], ["m", 60], ["s", 1]]) {
    if (s >= secs) {
      const str = `${Math.floor(s / secs)}${label}`;
      return future ? `in ${str}` : `${str} ago`;
    }
  }
  return "just now";
}
function setActiveNav() {
  const section = routePath().split("/")[1] || "runs";
  const hash = section === "compare" ? "runs" : section;
  document.querySelectorAll("#nav-links .nav-link").forEach((a) => {
    a.classList.toggle("active", a.getAttribute("href") === `/${hash}`);
  });
}
let navInsightsRequest = 0;
function compactCount(value, suffix = "") {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return "";
  if (n >= 1000) return `${Math.floor(n / 100) / 10}k${suffix}`;
  return `${n}${suffix}`;
}
function setNavInsight(section, value, { tone = "neutral", title = "" } = {}) {
  const badge = document.querySelector(`[data-nav-insight="${section}"]`);
  const link = document.querySelector(`[data-nav-link="${section}"]`);
  const linkLabel = link?.querySelector(".nav-link-title")?.textContent?.trim() || section;
  if (!badge) return;
  const text = String(value || "").trim();
  badge.hidden = !text;
  if (!text) {
    badge.textContent = "";
    badge.removeAttribute("title");
    badge.removeAttribute("aria-label");
    badge.removeAttribute("aria-hidden");
    badge.removeAttribute("data-nav-insight-tone");
    link?.removeAttribute("title");
    link?.removeAttribute("aria-label");
    return;
  }
  badge.textContent = text;
  badge.dataset.navInsightTone = tone;
  badge.title = title || text;
  badge.setAttribute("aria-label", title || text);
  badge.setAttribute("aria-hidden", "true");
  if (link && title) link.title = title;
  if (link) link.setAttribute("aria-label", title ? `${linkLabel}: ${title}` : `${linkLabel}: ${text}`);
}
function totalFromPayload(payload, keys) {
  for (const key of keys) {
    const value = Number(payload?.[key]);
    if (Number.isFinite(value)) return value;
  }
  return 0;
}
async function refreshNavInsights() {
  const request = ++navInsightsRequest;
  const [summaryResult, projectsResult, capacityResult] = await Promise.allSettled([
    api("/api/summary"),
    api("/api/projects"),
    api("/api/capacity/snapshots")
  ]);
  if (request !== navInsightsRequest) return;

  if (summaryResult.status === "fulfilled") {
    const summary = summaryResult.value;
    const total = totalFromPayload(summary, ["total_runs", "counted"]);
    const active = totalFromPayload(summary, ["active"]);
    const failed = Number(summary.by_status?.failed || 0);
    const tone = failed ? "attention" : active ? "active" : total ? "ready" : "neutral";
    const label = active ? `${compactCount(active)} live` : total ? compactCount(total) : "";
    const title = `${total} local run${total === 1 ? "" : "s"}${active ? `; ${active} active` : ""}${failed ? `; ${failed} failed` : ""}.`;
    setNavInsight("runs", label, { tone, title });
    setNavInsight("explore", total ? "fit" : "", {
      tone: total ? "ready" : "neutral",
      title: total ? "Resource-fit exploration is available for local run evidence." : "No local run evidence is available for exploration yet."
    });
  }

  if (projectsResult.status === "fulfilled") {
    const total = totalFromPayload(projectsResult.value, ["total_projects"]);
    setNavInsight("projects", total ? compactCount(total) : "", {
      tone: total ? "ready" : "neutral",
      title: `${total} local project group${total === 1 ? "" : "s"}.`
    });
  }

  if (capacityResult.status === "fulfilled") {
    const total = totalFromPayload(capacityResult.value, ["total", "returned"]);
    setNavInsight("capacity", total ? compactCount(total) : "", {
      tone: total ? "ready" : "neutral",
      title: `${total} saved capacity snapshot${total === 1 ? "" : "s"} available.`
    });
  }
}
function header(title, sub, actions = "", options = {}) {
  const className = options.className ? ` ${esc(options.className)}` : "";
  const actionsHtml = actions ? `<div class="col-auto ms-auto page-header-actions">${actions}</div>` : "";
  return `<div class="page-header d-print-none mb-3${className}"><div class="row align-items-center">
    <div class="col"><h1 class="page-title">${esc(title)}</h1>${sub ? `<div class="text-secondary mt-1">${sub}</div>` : ""}</div>
    ${actionsHtml}</div></div>`;
}
function uniqueValues(values) {
  return [...new Set(values.map((value) => String(value || "").trim()).filter(Boolean))].sort((a, b) => a.localeCompare(b));
}
function scopeValue(values, fallback = "mixed") {
  const unique = uniqueValues(values);
  if (!unique.length) return "scope unknown";
  if (unique.length === 1) return unique[0];
  return `${unique.length} ${fallback}`;
}
function safetyContextChip(label, value, icon, title = "") {
  return `<span class="app-safety-chip" data-safety-scope-chip="${esc(label)}" title="${esc(title || `${label}: ${value}`)}" aria-label="${esc(`${label}: ${value}`)}">
    <i class="ti ${esc(icon)}"></i><span class="app-safety-chip-label">${esc(label)}</span><span class="app-safety-chip-value">${esc(value)}</span>
  </span>`;
}
function setSafetyContext(items = []) {
  const scope = document.getElementById("app-safety-scope");
  if (!scope) return;
  const context = scope.closest(".app-safety-context");
  const visibleItems = items.filter((item) => item && item.value);
  scope.hidden = !visibleItems.length;
  context?.classList.toggle("app-safety-context-scoped", Boolean(visibleItems.length));
  scope.innerHTML = visibleItems
    .map((item) => safetyContextChip(item.label, item.value, item.icon || "ti-info-circle", item.title))
    .join("");
  scope.setAttribute(
    "aria-label",
    visibleItems.length
      ? `Current data scope: ${visibleItems.map((item) => `${item.label} ${item.value}`).join(", ")}`
      : "Current data scope"
  );
}
function runsSafetyContext(runs, total = runs.length) {
  return [
    { label: "Rows", value: `${runs.length}/${total} runs`, icon: "ti-list-check", title: `${runs.length} runs in the current Runs view out of ${total} local runs.` },
    { label: "Profile", value: scopeValue(runs.map((run) => run.profile_id), "profiles"), icon: "ti-id", title: "Profile scope represented by the visible local run evidence." },
    { label: "Platform", value: scopeValue(runs.map((run) => platformLabel(run.platform)), "platforms"), icon: "ti-server", title: "Platform scope represented by the visible local run evidence." }
  ];
}
function stateKindLabel(kind) {
  return String(kind || "not-applicable").replaceAll("-", " ");
}
function emptyStateMeta(kind) {
  const key = String(kind || "not-applicable");
  return {
    "history-empty": { icon: "ti-history", tone: "neutral" },
    "filtered-empty": { icon: "ti-filter-off", tone: "info" },
    "not-captured-yet": { icon: "ti-database-off", tone: "warning" },
    unsupported: { icon: "ti-ban", tone: "danger" },
    "not-applicable": { icon: "ti-circle-dashed", tone: "neutral" }
  }[key] || { icon: "ti-circle-dashed", tone: "neutral" };
}
function emptyState(title, sub, kind = "not-applicable", actions = "") {
  const meta = emptyStateMeta(kind);
  return `<div class="empty typed-empty" data-empty-kind="${esc(kind)}" data-empty-tone="${esc(meta.tone)}">
    <div class="typed-empty-icon" aria-hidden="true"><i class="ti ${esc(meta.icon)}"></i></div>
    <div class="typed-empty-body">
      <div class="empty-kind section-kicker">${esc(stateKindLabel(kind))}</div>
      <p class="empty-title">${esc(title)}</p>
      <p class="empty-subtitle text-secondary">${esc(sub || "")}</p>
      ${actions ? `<div class="typed-empty-actions">${actions}</div>` : ""}
    </div>
  </div>`;
}
function runsEmptyState() {
  return emptyState(
    "No local runs yet",
    "Saved run evidence will appear here after the first local plan, submit, or tracking record is captured.",
    "history-empty",
    `<a class="btn btn-primary" href="/capacity"><i class="ti ti-stack-2 me-1"></i>Open Capacity</a>
     <button class="btn btn-outline-secondary" type="button" id="runs-empty-refresh"><i class="ti ti-refresh me-1"></i>Refresh</button>`
  );
}
function projectsEmptyState() {
  return emptyState(
    "No projects yet",
    "Project groups appear after local runs are recorded.",
    "history-empty",
    `<a class="btn btn-primary" href="/runs"><i class="ti ti-list-details me-1"></i>Open Runs</a>
     <a class="btn btn-outline-secondary" href="/capacity"><i class="ti ti-stack-2 me-1"></i>Open Capacity</a>
     <button class="btn btn-outline-secondary" type="button" id="projects-empty-refresh"><i class="ti ti-refresh me-1"></i>Refresh</button>`
  );
}
function exploreEmptyState() {
  return emptyState(
    "No runs to explore yet",
    "Resource-fit analysis appears after local run evidence is captured.",
    "history-empty",
    `<a class="btn btn-primary" href="/runs"><i class="ti ti-list-details me-1"></i>Open Runs</a>
     <a class="btn btn-outline-secondary" href="/capacity"><i class="ti ti-stack-2 me-1"></i>Open Capacity</a>
     <button class="btn btn-outline-secondary" type="button" id="explore-empty-refresh"><i class="ti ti-refresh me-1"></i>Refresh</button>`
  );
}
function errorState(message, kind = "api-error", scope = "", actions = "") {
  const scopeText = scope || "Local view";
  return `<div class="alert alert-danger typed-error" role="alert" aria-live="assertive" aria-atomic="true" data-error-kind="${esc(kind)}" data-error-scope="${esc(scopeText)}">
    <div class="typed-error-icon"><i class="ti ti-alert-triangle" aria-hidden="true"></i></div>
    <div class="typed-error-body">
      <div class="typed-error-meta">
        <span class="typed-error-kind">${esc(stateKindLabel(kind))}</span>
        <span class="typed-error-scope">${esc(scopeText)}</span>
      </div>
      <div class="typed-error-message">${esc(message)}</div>
      ${actions ? `<div class="typed-error-actions">${actions}</div>` : ""}
    </div>
  </div>`;
}
function announceStatus(message) {
  const region = document.getElementById("status-region");
  if (region) region.textContent = message;
}
function announceError(scope, message) {
  announceStatus(`${scope || "View"} error: ${message}`);
}
function actionModalErrorHtml(message, scope = "Action") {
  return errorState(message, "action-failed", scope);
}
function toast(message, kind = "success") {
  const el = document.createElement("div");
  el.className = `alert alert-${kind} alert-dismissible shadow`;
  el.innerHTML = `<div>${esc(message)}</div><button type="button" class="btn-close" data-bs-dismiss="alert" aria-label="Dismiss"></button>`;
  document.getElementById("toasts").appendChild(el);
  announceStatus(message);
  setTimeout(() => el.remove(), 6000);
}
async function copyText(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {
      // Browser permission can deny async clipboard writes in local QA surfaces; fall back below.
    }
  }
  const area = document.createElement("textarea");
  area.value = text;
  area.setAttribute("readonly", "");
  area.style.position = "fixed";
  area.style.opacity = "0";
  document.body.appendChild(area);
  area.select();
  const copied = document.execCommand?.("copy");
  area.remove();
  if (!copied) throw new Error("clipboard write unavailable");
  return true;
}
function focusableElements(root) {
  return [...root.querySelectorAll('a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])')]
    .filter((el) => el.offsetParent !== null || el === document.activeElement);
}
function trapModalFocus(root, event) {
  if (event.key !== "Tab") return;
  const focusables = focusableElements(root);
  if (!focusables.length) return;
  const first = focusables[0];
  const last = focusables[focusables.length - 1];
  if (event.shiftKey && document.activeElement === first) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && document.activeElement === last) {
    event.preventDefault();
    first.focus();
  }
}
let compareValueModalReturnFocus = null;
function closeCompareValueModal({ restoreFocus = true, announce = true } = {}) {
  const existed = Boolean(document.getElementById("compare-value-modal-root"));
  document.getElementById("compare-value-modal-root")?.remove();
  document.body.classList.remove("compare-value-modal-open");
  if (restoreFocus && compareValueModalReturnFocus?.isConnected) {
    compareValueModalReturnFocus.focus({ preventScroll: true });
  }
  compareValueModalReturnFocus = null;
  if (existed && announce) announceStatus("Compare value inspector closed.");
}
function showCompareValueModal(button) {
  closeCompareValueModal({ restoreFocus: false, announce: false });
  compareValueModalReturnFocus = button;
  const root = document.createElement("div");
  root.id = "compare-value-modal-root";
  const runId = button.dataset.runId || "—";
  const field = button.dataset.field || "Compare value";
  const group = button.dataset.group || "Compare";
  const value = button.dataset.value || "—";
  root.innerHTML = `<div class="action-modal-backdrop" data-compare-value-close></div>
    <div class="action-modal compare-value-modal" role="dialog" aria-modal="true" aria-labelledby="compare-value-modal-title">
      <div class="action-modal-panel">
        <div class="action-modal-head">
          <div class="action-modal-icon bg-blue-lt text-blue"><i class="ti ti-text-size"></i></div>
          <div>
            <h3 class="m-0" id="compare-value-modal-title">${esc(field)}</h3>
            <div class="text-secondary mt-1">${esc(group)} · <code>${esc(runId)}</code></div>
          </div>
          <button type="button" class="btn-close ms-auto" data-compare-value-close aria-label="Close"></button>
        </div>
        <pre class="compare-value-pre mb-0">${esc(value)}</pre>
        <div class="action-modal-actions">
          <a class="btn btn-outline-secondary" href="/runs/${encodeURIComponent(runId)}"><i class="ti ti-list-details me-1"></i>Run Detail</a>
          <button type="button" class="btn btn-primary" data-compare-value-close>Close</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add("compare-value-modal-open");
  announceStatus(`Compare value inspector opened for ${field}.`);
  root.querySelectorAll("[data-compare-value-close]").forEach((el) => el.addEventListener("click", closeCompareValueModal));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeCompareValueModal();
    }
    trapModalFocus(root, e);
  });
  root.querySelector("button")?.focus();
}
let runActionModalReturnFocus = null;
function closeRunActionModal({ restoreFocus = true, announce = true } = {}) {
  const existed = Boolean(document.getElementById("run-action-modal-root"));
  document.getElementById("run-action-modal-root")?.remove();
  document.body.classList.remove("action-modal-open");
  if (restoreFocus && runActionModalReturnFocus?.isConnected) {
    runActionModalReturnFocus.focus({ preventScroll: true });
  }
  runActionModalReturnFocus = null;
  if (existed && announce) announceStatus("Action modal closed.");
}
function showRunActionModal({ title, icon, tone = "primary", intro, rows = [], fields = [], warning, primaryLabel, onSubmit }) {
  const trigger = document.activeElement;
  closeRunActionModal({ restoreFocus: false, announce: false });
  runActionModalReturnFocus = trigger instanceof HTMLElement ? trigger : null;
  const root = document.createElement("div");
  root.id = "run-action-modal-root";
  const rowHtml = rows
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<div><div class="section-kicker">${esc(k)}</div><div class="action-modal-value">${v}</div></div>`)
    .join("");
  const fieldHtml = fields
    .map((field) => `<div class="mb-3">
      <label class="form-label" for="action-${esc(field.name)}">${esc(field.label)}</label>
      <input class="form-control" id="action-${esc(field.name)}" name="${esc(field.name)}" value="${esc(field.value || "")}" placeholder="${esc(field.placeholder || "")}" ${field.required ? "required" : ""} />
      ${field.help ? `<div class="form-hint">${esc(field.help)}</div>` : ""}
    </div>`)
    .join("");
  root.innerHTML = `<div class="action-modal-backdrop" data-action-modal-close></div>
    <div class="action-modal" role="dialog" aria-modal="true" aria-labelledby="action-modal-title">
      <form class="action-modal-panel" tabindex="-1">
        <div class="action-modal-head">
          <div class="action-modal-icon bg-${esc(tone)}-lt text-${esc(tone)}"><i class="ti ${esc(icon || "ti-player-play")}"></i></div>
          <div>
            <h3 class="m-0" id="action-modal-title">${esc(title)}</h3>
            ${intro ? `<div class="text-secondary mt-1">${esc(intro)}</div>` : ""}
          </div>
          <button type="button" class="btn-close ms-auto" data-action-modal-close aria-label="Close"></button>
        </div>
        ${rowHtml ? `<div class="action-modal-summary">${rowHtml}</div>` : ""}
        ${warning ? `<div class="alert alert-warning mb-3"><i class="ti ti-alert-triangle me-2"></i>${esc(warning)}</div>` : ""}
        ${fieldHtml}
        <div class="action-modal-error-slot d-none" id="action-modal-error" tabindex="-1" aria-live="assertive"></div>
        <div class="action-modal-actions">
          <button type="button" class="btn btn-link" data-action-modal-close>Cancel</button>
          <button type="submit" class="btn btn-${esc(tone)}" id="action-modal-submit">${esc(primaryLabel)}</button>
        </div>
      </form>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add("action-modal-open");
  announceStatus(`Action modal opened: ${title}.`);
  const form = root.querySelector("form");
  const submit = root.querySelector("#action-modal-submit");
  const error = root.querySelector("#action-modal-error");
  root.querySelectorAll("[data-action-modal-close]").forEach((el) => el.addEventListener("click", closeRunActionModal));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeRunActionModal();
    }
    trapModalFocus(root, e);
  });
  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    error.classList.add("d-none");
    error.innerHTML = "";
    submit.disabled = true;
    submit.innerHTML = `<span class="spinner-border spinner-border-sm me-2"></span>${esc(primaryLabel)}`;
    try {
      const values = Object.fromEntries(new FormData(form).entries());
      await onSubmit(values);
      closeRunActionModal({ announce: false });
    } catch (err) {
      const message = err?.message || String(err);
      error.innerHTML = actionModalErrorHtml(message, title);
      error.classList.remove("d-none");
      error.focus({ preventScroll: true });
      announceError(title, message);
    } finally {
      submit.disabled = false;
      submit.textContent = primaryLabel;
    }
  });
  form.scrollTop = 0;
  form.focus({ preventScroll: true });
}
let evidenceModalReturnFocus = null;
function closeEvidenceModal({ restoreFocus = true, announce = true } = {}) {
  const existed = Boolean(document.getElementById("evidence-provenance-root"));
  document.getElementById("evidence-provenance-root")?.remove();
  document.body.classList.remove("evidence-modal-open");
  if (restoreFocus && evidenceModalReturnFocus?.isConnected) {
    evidenceModalReturnFocus.focus({ preventScroll: true });
  }
  evidenceModalReturnFocus = null;
  if (existed && announce) announceStatus("Evidence provenance modal closed.");
}
function showEvidenceProvenanceModal(chip) {
  closeEvidenceModal({ restoreFocus: false, announce: false });
  evidenceModalReturnFocus = chip;
  const state = chip.dataset.state || "unknown";
  const runId = chip.dataset.runId || "—";
  const scopeKind = chip.dataset.scopeKind || "run";
  const scopeId = chip.dataset.scopeId || runId;
  const observedAt = chip.dataset.observedAt || "";
  const scopeRow = scopeKind === "run" && runId !== "—"
    ? ["Run", `<a href="/runs/${encodeURIComponent(runId)}"><code>${esc(runId)}</code></a>`]
    : ["Scope", `<code>${esc(scopeKind)}:${esc(scopeId || "—")}</code>`];
  const rows = [
    scopeRow,
    ["Evidence", esc(chip.dataset.label || "—")],
    ["Type", chip.dataset.evidenceType ? `<code>${esc(chip.dataset.evidenceType)}</code>` : `<span class="text-secondary">not classified</span>`],
    ["State", readinessPill(state === "present" ? "captured" : state, state)],
    ["Source kind", chip.dataset.sourceKind ? `<code>${esc(chip.dataset.sourceKind)}</code>` : `<span class="text-secondary">not recorded</span>`],
    ["Source", `<code>${esc(chip.dataset.source || "saved local state")}</code>`],
    ["Route target", chip.dataset.routeTarget ? esc(chip.dataset.routeTarget) : `<span class="text-secondary">none</span>`],
    ...(chip.dataset.snapshotId ? [["Snapshot", `<code>${esc(chip.dataset.snapshotId)}</code>`]] : []),
    ["Observed", observedAt ? `<span title="${esc(fmtTime(observedAt))}">${esc(fmtRel(observedAt))}</span>` : `<span class="text-secondary">not recorded</span>`],
    ["Profile", esc(chip.dataset.profileId || "—")],
    ["Platform", esc(platformLabel(chip.dataset.platform))],
    ["Redaction", "Summary is from saved redacted local state; raw JSON, arbitrary paths, and secrets are not exposed."]
  ];
  const detail = chip.dataset.detail || "No additional detail recorded for this evidence chip.";
  const root = document.createElement("div");
  root.id = "evidence-provenance-root";
  root.innerHTML = `<div class="action-modal-backdrop" data-evidence-modal-close></div>
    <div class="action-modal evidence-modal" role="dialog" aria-modal="true" aria-labelledby="evidence-modal-title">
      <div class="action-modal-panel">
        <div class="action-modal-head">
          <div class="action-modal-icon bg-azure-lt text-azure"><i class="ti ti-database-search"></i></div>
          <div>
            <h3 class="m-0" id="evidence-modal-title">Evidence provenance</h3>
            <div class="text-secondary mt-1">${esc(detail)}</div>
          </div>
          <button type="button" class="btn-close ms-auto" data-evidence-modal-close aria-label="Close"></button>
        </div>
        <div class="action-modal-summary evidence-provenance-summary">
          ${rows.map(([k, v]) => `<div><div class="section-kicker">${esc(k)}</div><div class="action-modal-value">${v}</div></div>`).join("")}
        </div>
        <div class="alert alert-info mb-0"><i class="ti ti-info-circle me-2"></i>Evidence chips are navigation and triage aids. MCP actions still use server-side evidence and gates.</div>
        <div class="action-modal-actions">
          <button type="button" class="btn btn-primary" data-evidence-modal-close>Close</button>
        </div>
      </div>
    </div>`;
  document.body.appendChild(root);
  document.body.classList.add("evidence-modal-open");
  announceStatus(`Evidence provenance opened for ${chip.dataset.label || "evidence"}.`);
  root.querySelectorAll("[data-evidence-modal-close]").forEach((el) => el.addEventListener("click", closeEvidenceModal));
  root.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      e.preventDefault();
      closeEvidenceModal();
    }
    trapModalFocus(root, e);
  });
  root.querySelector("button")?.focus();
}
function wireEvidenceChips() {
  document.querySelectorAll("[data-evidence-chip]").forEach((chip) => {
    chip.addEventListener("click", () => showEvidenceProvenanceModal(chip));
  });
}

// ---------- charts (registry so we can tear them down on navigation) ----------
let _charts = [];
function mkChart(el, opts) {
  if (!window.ApexCharts || !el) return null;
  const merged = { ...opts, chart: { animations: { enabled: false }, width: "100%", ...opts.chart } };
  const c = new ApexCharts(el, merged);
  c._alive = true;
  _charts.push(c);
  // Defer render until the flex/grid column has a real width. Rendering before layout settles
  // makes ApexCharts compute NaN dimensions and emit SVG attribute errors in the console.
  const renderWhenSized = (attempt = 0) => {
    requestAnimationFrame(() => {
      if (!c._alive || !el.isConnected) return;
      if (el.getBoundingClientRect().width < 10 && attempt < 12) {
        renderWhenSized(attempt + 1);
        return;
      }
      try {
        c.render();
      } catch {
        /* ignore */
      }
    });
  };
  renderWhenSized();
  return c;
}
function destroyCharts() {
  for (const c of _charts) {
    c._alive = false;
    try {
      c.destroy();
    } catch {
      /* ignore */
    }
  }
  _charts = [];
}

// ---------- auto-refresh (live fleet feel) ----------
let _refreshTimer = null;
let _refreshInFlight = false;
function clearRefresh() {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
  _refreshInFlight = false;
}
function refreshStateMeta(state = "fresh") {
  return {
    fresh: { icon: "ti-circle-check", severity: "ok", busy: false },
    refreshing: { icon: "ti-loader-2", severity: "busy", busy: true },
    stale: { icon: "ti-clock-exclamation", severity: "warning", busy: false },
    paused: { icon: "ti-player-pause", severity: "paused", busy: false }
  }[state] || { icon: "ti-circle-check", severity: "ok", busy: false };
}
function refreshStateHtml(state = "fresh", text = "Loaded just now", updatedAt = new Date().toISOString()) {
  const meta = refreshStateMeta(state);
  return `<span class="refresh-state refresh-${esc(state)}" role="status" aria-live="polite" aria-busy="${meta.busy ? "true" : "false"}" aria-label="${esc(`Refresh state: ${text}`)}" data-refresh-state="${esc(state)}" data-refresh-severity="${esc(meta.severity)}" data-refresh-updated-at="${esc(updatedAt)}" title="${esc(`Last successful UI refresh: ${fmtTime(updatedAt)}`)}">
    <i class="ti ${esc(meta.icon)}" aria-hidden="true"></i>
    <span data-refresh-text>${esc(text)}</span>
  </span>`;
}
function refreshControls(scope = "view") {
  const on = localStorage.getItem("uts-autorefresh") === "1";
  const loadedAt = new Date().toISOString();
  return `<div class="refresh-controls" data-refresh-scope="${esc(scope)}">
    <button class="btn btn-icon btn-sm btn-outline-secondary refresh-now" type="button" data-refresh-now title="Refresh now" aria-label="Refresh now">
      <svg class="refresh-glyph" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M20 11a8 8 0 0 0-14.4-4.8L4 8"></path>
        <path d="M4 4v4h4"></path>
        <path d="M4 13a8 8 0 0 0 14.4 4.8L20 16"></path>
        <path d="M20 20v-4h-4"></path>
      </svg>
    </button>
    <label class="form-check form-switch m-0 d-inline-flex align-items-center">
      <input class="form-check-input" type="checkbox" id="auto-refresh" ${on ? "checked" : ""}>
      <span class="form-check-label text-secondary ms-1">Auto-refresh</span>
    </label>
    ${refreshStateHtml("fresh", `Loaded ${fmtRel(loadedAt)}`, loadedAt)}
  </div>`;
}
function refreshLastLoadedLabel() {
  const timestamp = document.querySelector("[data-refresh-updated-at]")?.dataset.refreshUpdatedAt;
  return timestamp ? fmtRel(timestamp) : "previous load";
}
function setRefreshState(state, text, updatedAt = null) {
  const meta = refreshStateMeta(state);
  document.querySelectorAll("[data-refresh-state]").forEach((el) => {
    el.dataset.refreshState = state;
    el.dataset.refreshSeverity = meta.severity;
    el.className = `refresh-state refresh-${state}`;
    el.setAttribute("aria-busy", meta.busy ? "true" : "false");
    el.setAttribute("aria-label", `Refresh state: ${text}`);
    if (updatedAt) {
      el.dataset.refreshUpdatedAt = updatedAt;
      el.title = `Last successful UI refresh: ${fmtTime(updatedAt)}`;
    }
    const icon = el.querySelector("i");
    const textEl = el.querySelector("[data-refresh-text]");
    if (icon) icon.className = `ti ${meta.icon}`;
    if (textEl) textEl.textContent = text;
  });
}
// Re-run `fn` every 10s while the toggle is on AND we're still on the same hash route.
function wireRefreshToggle(fn, { scope = "view" } = {}) {
  clearRefresh();
  const el = document.getElementById("auto-refresh");
  if (!el) return;
  const routeAtStart = routePath();
  const label = REFRESH_SCOPE_LABELS[scope] || "View";
  const refreshNow = async (manual = false) => {
    if (_refreshInFlight) return;
    _refreshInFlight = true;
    setRefreshState("refreshing", manual ? "Refreshing now..." : "Refreshing...");
    try {
      await fn();
      announceStatus(`${label} refreshed.`);
    } catch (err) {
      const message = err?.message || String(err);
      const lastLoaded = refreshLastLoadedLabel();
      setRefreshState("stale", `Stale since ${lastLoaded}: ${message}`);
      announceStatus(`${label} refresh failed; keeping previous data marked stale.`);
      if (manual) toast(`${label} refresh failed: ${message}`, "danger");
    } finally {
      _refreshInFlight = false;
    }
  };
  const start = () => {
    clearRefresh();
    _refreshTimer = setInterval(async () => {
      if (routePath() === routeAtStart) await refreshNow(false);
      else clearRefresh();
    }, REFRESH_INTERVAL_MS);
  };
  if (el.checked) start();
  el.addEventListener("change", () => {
    localStorage.setItem("uts-autorefresh", el.checked ? "1" : "0");
    if (el.checked) start();
    else {
      clearRefresh();
      setRefreshState("paused", "Auto-refresh paused");
    }
  });
  document.querySelector("[data-refresh-now]")?.addEventListener("click", () => refreshNow(true));
}

// ---------- live status reconcile (jobs.track over SSH; distinct from the read-only auto-refresh) -----
const RECONCILE_INTERVAL_MS = 120000; // 2 min — a live SSH sweep; lighter cadence than the 10s read-only refresh
let _reconcileTimer = null;
let _reconcileInFlight = false;
function clearReconcile() {
  if (_reconcileTimer) {
    clearInterval(_reconcileTimer);
    _reconcileTimer = null;
  }
  _reconcileInFlight = false;
}
// A button that runs a LIVE reconcile (POST /api/runs/refresh -> jobs.track: re-polls active runs over
// SSH and writes fresh usage/status onto the records), plus an opt-in "Auto" toggle (default OFF — it is
// live SSH). This is what fills the usage/walltime columns that otherwise stay "—" until a run is polled.
function liveReconcileControls() {
  const on = localStorage.getItem("uts-live-reconcile") === "1";
  return `<div class="reconcile-controls d-inline-flex align-items-center gap-2" data-reconcile-controls>
    <button class="btn btn-sm btn-primary" type="button" data-reconcile-now title="Re-poll every active run over SSH and refresh its usage/status (needs VPN)">
      <i class="ti ti-refresh-dot me-1" aria-hidden="true"></i>Live probe
    </button>
    <label class="form-check form-switch m-0 d-inline-flex align-items-center" title="Auto re-poll every 2 minutes over SSH (needs VPN); off by default">
      <input class="form-check-input" type="checkbox" id="auto-reconcile" ${on ? "checked" : ""}>
      <span class="form-check-label text-secondary ms-1">Auto-probe</span>
    </label>
  </div>`;
}
// Group the local "reload view" controls and the live "SSH probe" controls into one tidy bar with a
// divider, so the two refresh modes read as distinct concerns instead of two look-alike "Auto" toggles.
function runsRefreshBar() {
  return `<div class="runs-refresh-bar">${refreshControls("runs")}<span class="runs-refresh-divider" role="separator" aria-hidden="true"></span>${liveReconcileControls()}</div>`;
}
async function reconcileNow(reRender, manual = false) {
  if (_reconcileInFlight) return;
  _reconcileInFlight = true;
  const btn = document.querySelector("[data-reconcile-now]");
  const original = btn ? btn.innerHTML : "";
  if (btn) {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status" aria-hidden="true"></span>Polling…`;
  }
  try {
    const res = await post("/api/runs/refresh", {});
    const polled = res?.counts?.polled;
    announceStatus(`Live reconcile re-polled ${polled ?? "the active"} run(s) over SSH.`);
    if (manual) toast(`Reconciled ${polled ?? "active"} run(s) over SSH.`, "success");
    await reRender();
  } catch (err) {
    const message = err?.message || String(err);
    announceStatus(`Live reconcile failed: ${message}`);
    // "Failed to fetch" is a browser-level network error: the LOCAL dashboard server is unreachable
    // (it stopped), NOT a cluster/VPN problem. Only an actual SSH/cluster failure warrants the VPN hint.
    const unreachable = /failed to fetch|networkerror|load failed|fetch failed/i.test(message);
    const hint = unreachable
      ? "the local dashboard server isn't responding — is `npm run webui` still running?"
      : "the SSH probe failed — check the account profile and that the VPN/cluster is reachable";
    if (manual) toast(`Live reconcile failed: ${message} — ${hint}`, "danger");
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = original;
    }
  } finally {
    _reconcileInFlight = false;
  }
}
// Wire the live-reconcile button + auto toggle. `reRender` re-fetches and repaints the view after a
// reconcile. Uses its own timer (separate from the read-only refresh) and stops on route change.
function wireLiveReconcile(reRender) {
  clearReconcile();
  const toggle = document.getElementById("auto-reconcile");
  const routeAtStart = routePath();
  const start = () => {
    clearReconcile();
    _reconcileTimer = setInterval(async () => {
      if (routePath() === routeAtStart) await reconcileNow(reRender, false);
      else clearReconcile();
    }, RECONCILE_INTERVAL_MS);
  };
  document.querySelector("[data-reconcile-now]")?.addEventListener("click", () => reconcileNow(reRender, true));
  if (toggle) {
    if (toggle.checked) start();
    toggle.addEventListener("change", () => {
      localStorage.setItem("uts-live-reconcile", toggle.checked ? "1" : "0");
      if (toggle.checked) start();
      else clearReconcile();
    });
  }
}

// ---------- router ----------
const routes = [
  [/^\/runs\/(.+)$/, (m) => renderRunDetail(decodeURIComponent(m[1]))],
  [/^\/runs$/, renderRunsList],
  [/^\/compare$/, renderCompare],
  [/^\/explore$/, renderExplore],
  [/^\/capacity$/, renderQueue],
  [/^\/queue$/, () => navigateTo("/capacity", routeQuery(), { replace: true })],
  [/^\/node-load$/, () => navigateTo("/runs", routeQuery(), { replace: true })],  // folded into Runs
  [/^\/projects$/, renderProjects],
  [/^\/$/, renderRunsList]
];
async function router() {
  clearRefresh();
  clearReconcile();
  closeCompareValueModal({ restoreFocus: false, announce: false });
  closeRunActionModal({ restoreFocus: false, announce: false });
  closeEvidenceModal({ restoreFocus: false, announce: false });
  destroyCharts();
  if (migrateLegacyHashRoute() || migrateLegacyPageRoute()) {
    await router();
    return;
  }
  setActiveNav();
  void refreshNavInsights();
  setSafetyContext([]);
  const path = routePath();
  for (const [re, fn] of routes) {
    const m = path.match(re);
    if (m) {
      try {
        await fn(m);
      } catch (e) {
        announceError("Route", e.message);
        view().innerHTML = header("Error") + errorState(
          e.message,
          "api-error",
          "Route",
          `<a class="btn btn-danger" href="/runs"><i class="ti ti-list-details me-1"></i>Back to Runs</a>
           <a class="btn btn-outline-danger" href="/explore"><i class="ti ti-chart-dots me-1"></i>Open Explore</a>`
        );
      }
      observeTableScrollHints();
      return;
    }
  }
  view().innerHTML = header("Not found") + emptyState(
    "Unknown page",
    path,
    "unsupported",
    `<a class="btn btn-primary" href="/runs"><i class="ti ti-list-details me-1"></i>Back to Runs</a>
     <a class="btn btn-outline-secondary" href="/explore"><i class="ti ti-chart-dots me-1"></i>Open Explore</a>`
  );
}
window.addEventListener("popstate", router);
window.addEventListener("hashchange", () => {
  if (migrateLegacyHashRoute()) router();
});
window.addEventListener("DOMContentLoaded", () => {
  wireTheme();
  wireAppNavToggle();
  wireInternalNavigation();
  migrateLegacyHashRoute();
  if (location.pathname === "/" && !location.search) {
    history.replaceState(null, "", "/runs");
  }
  router();
});
window.addEventListener("resize", scheduleTableScrollHintSync);

// ---------- theme (light / dark) ----------
function applyThemeIcon() {
  const dark = document.documentElement.getAttribute("data-bs-theme") === "dark";
  const icon = document.getElementById("theme-icon");
  if (icon) icon.className = `ti ti-${dark ? "sun" : "moon"}`;
}
function wireTheme() {
  applyThemeIcon();
  const btn = document.getElementById("theme-toggle");
  if (!btn) return;
  btn.addEventListener("click", () => {
    const next = document.documentElement.getAttribute("data-bs-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-bs-theme", next);
    localStorage.setItem("uts-theme", next);
    applyThemeIcon();
    router(); // re-render so ApexCharts pick up the new theme
  });
}

// ---------- Runs list ----------
function runsFilterChips(viewDefs, { statusF, projF, platformF, queueF, searchF, sort }) {
  const chips = [];
  const activeLabel = viewDefs.find(([value]) => value === statusF)?.[1] || statusF;
  if (statusF !== "all") chips.push(`<span class="filter-chip"><i class="ti ti-filter"></i>${esc(activeLabel)}</span>`);
  if (projF) chips.push(`<span class="filter-chip"><i class="ti ti-folders"></i>${esc(projF)}</span>`);
  if (platformF) chips.push(`<span class="filter-chip"><i class="ti ti-server"></i>${esc(platformLabel(platformF))}</span>`);
  if (queueF) chips.push(`<span class="filter-chip"><i class="ti ti-stack-2"></i>${esc(queueF)}</span>`);
  if (searchF) chips.push(`<span class="filter-chip"><i class="ti ti-search"></i>${esc(searchF)}</span>`);
  if (sort && (sort.key !== RUN_SORT_DEFAULT.key || sort.dir !== RUN_SORT_DEFAULT.dir)) {
    chips.push(`<span class="filter-chip"><i class="ti ti-arrows-sort"></i>${esc(runSortLabel(sort.key))} ${esc(sort.dir)}</span>`);
  }
  return chips.join("");
}
function syncRunsFilterChrome(viewDefs, filters, matching, total) {
  const { statusF, projF, platformF, queueF, searchF, sort } = filters;
  document.getElementById("runs-result-count").textContent = `${matching} of ${total} results`;
  document.getElementById("runs-no-results")?.classList.toggle("d-none", matching > 0);
  document.getElementById("active-filter-chips").innerHTML = runsFilterChips(viewDefs, filters);
  syncRunsViewSummary(viewDefs, filters, matching, total);
  const hasActiveFilters = runsHasActiveFilters({ statusF, projF, platformF, queueF, searchF, sort });
  const clearBtn = document.getElementById("clear-run-filters");
  if (clearBtn) {
    clearBtn.disabled = !hasActiveFilters;
    clearBtn.hidden = !hasActiveFilters;
  }
  document.querySelectorAll("#status-filters .btn").forEach((b) => b.classList.toggle("active", b.dataset.filter === statusF));
  document.querySelectorAll("[data-triage-filter]").forEach((b) => {
    const active = b.dataset.triageFilter === statusF;
    b.classList.toggle("active", active);
    b.setAttribute("aria-pressed", active ? "true" : "false");
  });
  const params = new URLSearchParams();
  if (statusF !== "all") params.set("view", statusF);
  if (projF) params.set("project", projF);
  if (platformF) params.set("platform", platformF);
  if (queueF) params.set("queue", queueF);
  if (searchF) params.set("q", searchF);
  if (sort && (sort.key !== RUN_SORT_DEFAULT.key || sort.dir !== RUN_SORT_DEFAULT.dir)) {
    params.set("sort", sort.key);
    params.set("dir", sort.dir);
  }
  replaceRouteQuery("/runs", params);
}
function runFilterSearchText(run) {
  return [
    run.run_id,
    run.status,
    run.project,
    run.job_type,
    run.platform,
    runQueue(run),
    run.cluster,
    run.node,
    actionReadinessModel(run).label,
    actionReadinessModel(run).detail,
    runResourceSummaryText(run),
    runEvidenceSummaryText(run),
    ...attentionReasons(run).map((reason) => reason.label)
  ].filter(Boolean).join(" ").toLowerCase();
}
function runMatchesFilters(run, filters) {
  if (!run) return false;
  const needle = (filters.searchF || "").toLowerCase();
  return (
    runViewMatches(run, filters.statusF || "all") &&
    (!filters.projF || (run.project || "—") === filters.projF) &&
    (!filters.platformF || run.platform === filters.platformF) &&
    (!filters.queueF || runQueue(run) === filters.queueF) &&
    (!needle || runFilterSearchText(run).includes(needle))
  );
}
function syncRunsMobileCards(runs, filters, sort) {
  const list = document.getElementById("runs-mobile-cards");
  if (!list) return;
  const runById = new Map(runs.map((run) => [run.run_id, run]));
  [...list.querySelectorAll("[data-run-card-id]")]
    .sort((a, b) => compareRunsForSort(runById.get(a.dataset.runCardId), runById.get(b.dataset.runCardId), sort))
    .forEach((card) => list.appendChild(card));
  list.querySelectorAll("[data-run-card-id]").forEach((card) => {
    const run = runById.get(card.dataset.runCardId);
    card.classList.toggle("d-none", !runMatchesFilters(run, filters));
  });
}
function compareToggleLabel(selected) {
  return selected ? "Remove from comparison" : "Include in comparison";
}

function runsMobileCard(run, selected) {
  const severity = attentionSeverity(run);
  const resourceLabel = runResourceSummaryText(run);
  const evidenceLabel = runEvidenceSummaryText(run);
  const timingLabel = `Created ${fmtRel(run.created_at)} · Updated ${fmtRel(run.updated_at)}`;
  const locationLabel = [
    run.cluster ? `Cluster ${run.cluster}` : "Cluster missing",
    run.node ? `Node ${run.node}` : "Node missing"
  ].join(" · ");
  const projectMeta = [run.project || "—", platformLabel(run.platform), runQueue(run)].filter(Boolean).join(" · ");
  const compareLabel = compareToggleLabel(selected);
  return `<article class="runs-mobile-card ${severity !== "none" ? `runs-mobile-card-${esc(severity)}` : ""} ${selected ? "run-card-compared" : ""}" data-run-card-id="${esc(run.run_id)}" data-run-id="${esc(run.run_id)}" data-run-severity="${esc(severity)}" data-compare-selected="${selected ? "true" : "false"}">
    <div class="runs-mobile-card-head">
      <button class="btn btn-icon btn-sm btn-ghost-secondary compare-toggle ${selected ? "active" : ""}" type="button" data-compare-run="${esc(run.run_id)}" aria-pressed="${selected ? "true" : "false"}" aria-label="${esc(compareLabel)}" title="${esc(compareLabel)}"><span class="compare-toggle-mark" aria-hidden="true">${selected ? "-" : "+"}</span><i class="ti ${selected ? "ti-eye" : "ti-eye-off"}" aria-hidden="true"></i></button>
      <div class="runs-mobile-card-title">
        <a href="/runs/${encodeURIComponent(run.run_id)}" class="text-reset fw-bold" title="${esc(run.run_id)}">${esc(run.run_id)}</a>
        <div class="runs-mobile-card-meta" title="${esc(projectMeta)}">${esc(projectMeta)}</div>
      </div>
      <div class="runs-mobile-status">${runStatusBadge(run)}</div>
    </div>
    ${attentionReasonHtml(run)}
    <div class="runs-mobile-card-grid">
      <div class="runs-mobile-card-section" title="${esc(resourceLabel)}">
        <span class="runs-mobile-section-label">Resources</span>
        ${runResourceSummary(run)}
      </div>
    </div>
    <div class="runs-mobile-card-extra" aria-label="Run evidence, timing, and location summary">
      <span title="${esc(evidenceLabel)}"><i class="ti ti-list-check"></i><span class="runs-mobile-card-extra-text">${esc(evidenceLabel.replace(/^Evidence:\s*/, ""))}</span></span>
      <span title="${esc(timingLabel)}"><i class="ti ti-clock"></i><span class="runs-mobile-card-extra-text">${esc(timingLabel)}</span></span>
      <span title="${esc(locationLabel)}"><i class="ti ti-server"></i><span class="runs-mobile-card-extra-text">${esc(locationLabel)}</span></span>
    </div>
  </article>`;
}
function runsCountPairs(runs, getter) {
  return Object.entries(runs.reduce((counts, run) => {
    const value = getter(run);
    if (!value || value === "—") return counts;
    counts[value] = (counts[value] || 0) + 1;
    return counts;
  }, {})).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], undefined, { numeric: true, sensitivity: "base" }));
}
function runsMeaningfulProjects(runs = []) {
  return uniqueSorted(runs.map((run) => run.project).filter((project) => project && project !== "unassigned"));
}
function runsQueuedCount(runs = []) {
  return runs.filter((run) => run.status === "submitted" || run.status === "submitting").length;
}
function runsMetricDetailChips(items = [], empty = "") {
  if (!items.length) return empty ? `<span class="runs-ops-metric-muted">${esc(empty)}</span>` : "";
  return `<span class="runs-ops-metric-detail-list">${items.map((item) => {
    const name = Array.isArray(item) ? item[0] : item.label;
    const count = Array.isArray(item) ? item[1] : item.value;
    return `<span class="runs-ops-metric-chip" title="${esc(`${name}: ${count}`)}"><span>${esc(name)}</span><b>${esc(count)}</b></span>`;
  }).join("")}</span>`;
}
function runsMetricTile({ label, value, detail, detailItems, emptyDetail, stats, tone = "neutral" }) {
  const title = Array.isArray(stats) && stats.length
    ? `${label}: ${stats.map((item) => `${item.value} ${item.label}`).join(", ")}`
    : `${label}: ${value}${Array.isArray(detailItems) && detailItems.length ? `. ${detailItems.map((item) => `${Array.isArray(item) ? item[0] : item.label} ${Array.isArray(item) ? item[1] : item.value}`).join(", ")}` : detail ? `. ${detail}` : ""}`;
  const body = Array.isArray(stats) && stats.length
    ? `<span class="runs-ops-metric-stats">${stats.map((item) => `<span class="runs-ops-stat"><b>${esc(item.value)}</b><span>${esc(item.label)}</span></span>`).join("")}</span>`
    : `<span class="runs-ops-metric-value">${esc(value)}</span>
      <span class="runs-ops-metric-label">${esc(label)}</span>
      ${Array.isArray(detailItems) ? runsMetricDetailChips(detailItems, emptyDetail) : detail ? `<span class="runs-ops-metric-detail">${esc(detail)}</span>` : ""}`;
  return `<div class="runs-ops-metric" data-ops-tone="${esc(tone)}" title="${esc(title)}">
    <span class="runs-ops-metric-body">
      ${body}
    </span>
  </div>`;
}
function runsDistributionLine(label, pairs, empty = "none") {
  const chips = pairs.length
    ? pairs.map(([value, count]) => `<span class="runs-ops-chip" title="${esc(`${value}: ${count} runs`)}">${esc(value)}<b>${esc(count)}</b></span>`).join("")
    : `<span class="runs-ops-muted">${esc(empty)}</span>`;
  return `<div class="runs-ops-line">
    <span class="runs-ops-line-label">${esc(label)}</span>
    <span class="runs-ops-line-values">${chips}</span>
  </div>`;
}
function runsProjectGlance(data) {
  const projects = [...(data?.projects || [])].sort(projectSort);
  if (!projects.length) return "";
  const countedRuns = Number(data?.counted || 0) || projects.reduce((sum, p) => sum + Number(p.total || 0), 0);
  const totalRuns = Number(data?.total_runs || 0) || countedRuns;
  const scope = totalRuns > countedRuns ? `${countedRuns}/${totalRuns} runs` : `${totalRuns} runs`;
  const visibleProjects = projects.slice(0, 4);
  const hidden = projects.length - visibleProjects.length;
  return `<section class="runs-project-glance mb-3" aria-label="Projects at a glance">
    <div class="runs-project-glance-head">
      <h3>Projects</h3>
      <span>${esc(projects.length)} project${projects.length === 1 ? "" : "s"} · ${esc(scope)}</span>
    </div>
    <div class="runs-project-glance-list">
      ${visibleProjects.map(runsProjectGlanceRow).join("")}
      ${hidden > 0 ? `<a class="runs-project-glance-row runs-project-glance-more" href="/runs" aria-label="${esc(`Show all ${projects.length} project groups in Runs`)}">
        <strong>${esc(hidden)} more</strong>
        <span>available through Runs filters</span>
      </a>` : ""}
    </div>
  </section>`;
}
function runsProjectGlanceRow(project) {
  const health = projectHealth(project);
  const exploreHref = projectExploreHref(project.project);
  const lastUpdated = project.last_updated
    ? `<span title="${esc(fmtTime(project.last_updated))}">${esc(fmtRel(project.last_updated))}</span>`
    : `<span class="text-secondary">no timestamp</span>`;
  const platforms = project.platforms?.length
    ? project.platforms.map((platform) => platformBadge(platform)).join("")
    : `<span class="text-secondary">platform missing</span>`;
  const profileCount = (project.profiles || []).length;
  return `<a class="runs-project-glance-row" href="${exploreHref}" data-project-health="${esc(health.state)}" title="${esc(`Filter Runs to project ${project.project}`)}">
    <span class="runs-project-glance-title">
      <strong>${esc(project.project)}</strong>
      <span class="project-health-chip" data-health="${esc(health.state)}">${esc(health.label)}</span>
    </span>
    <span class="runs-project-glance-mix">${projectStatusComposition(project)}</span>
    <span class="runs-project-glance-scope">${platforms}<span class="runs-project-glance-profiles">${esc(profileCount)} profile${profileCount === 1 ? "" : "s"}</span></span>
    <span class="runs-project-glance-latest">${lastUpdated}</span>
  </a>`;
}
function runsOperationalDashboard(summary, runs) {
  if (!runs.length) return "";
  const active = runs.filter((run) => isActiveStatus(run.status)).length;
  const running = runs.filter((run) => run.status === "running").length;
  const queued = runsQueuedCount(runs);
  const remoteCount = runs.filter((run) => run.remote_job_id || run.supervisor).length;
  const usageCaptured = runs.filter((run) => run.usage).length;
  const requestedCaptured = runs.filter((run) => {
    const requested = runRequestedResources(run);
    return requested && Object.keys(requested).length;
  }).length;
  const platformPairs = runsCountPairs(runs, (run) => platformLabel(run.platform));
  const accountPairs = runsCountPairs(runs, (run) => run.profile_id || run.account_label || run.cluster);
  const nodePairs = runsCountPairs(runs, (run) => run.node);
  const meaningfulProjects = runsMeaningfulProjects(runs);
  const total = summary?.total_runs || summary?.counted || runs.length;
  const metrics = [
    {
      label: "Execution",
      stats: [
        { label: "Running", value: String(running) },
        { label: "Queued", value: String(queued) },
        { label: "Remote IDs", value: String(remoteCount) }
      ],
      tone: running ? "live" : "neutral"
    },
    { label: "Platforms", value: String(platformPairs.length || "—"), detailItems: platformPairs, emptyDetail: "none", tone: "platform" },
    { label: "Accounts", value: String(accountPairs.length || "—"), detailItems: accountPairs, emptyDetail: "none", tone: "account" },
    { label: "Nodes", value: String(nodePairs.length || "—"), detailItems: nodePairs, emptyDetail: "pending", tone: "node" },
    {
      label: "Evidence",
      value: `${usageCaptured}/${runs.length}`,
      detailItems: [
        { label: "usage", value: usageCaptured },
        { label: "requested", value: requestedCaptured }
      ],
      tone: usageCaptured === runs.length ? "safe" : "evidence"
    }
  ];
  return `<section class="runs-ops-overview mb-3" aria-label="Runs execution overview">
    <div class="runs-ops-head">
      <div>
        <span class="section-kicker">Execution overview</span>
        <h2>${esc(running)} running · ${esc(queued)} queued across ${esc(platformPairs.length || 0)} platform${platformPairs.length === 1 ? "" : "s"}</h2>
      </div>
      <span class="runs-ops-total">${esc(runs.length)} loaded / ${esc(total)} total</span>
    </div>
    <div class="runs-ops-primary">${metrics.map(runsMetricTile).join("")}</div>
    <div class="runs-ops-bottom">
      <div class="runs-ops-distribution">
        ${runsDistributionLine("Platforms", platformPairs)}
        ${runsDistributionLine("Accounts", accountPairs)}
        ${runsDistributionLine("Nodes", nodePairs, "node evidence pending")}
        ${runsDistributionLine("Projects", meaningfulProjects.map((project) => [project, runs.filter((run) => run.project === project).length]), "all unassigned")}
      </div>
    </div>
  </section>`;
}
function runsChartsUseful(summary, runs) {
  if (!summary || !runs.length) return false;
  const statusCounts = summary.by_status || countBy(runs, "status");
  const statusBuckets = Object.values(statusCounts).filter((count) => Number(count) > 0).length;
  const projectBuckets = (summary.by_project || []).filter((project) => project.project && project.project !== "unassigned" && Number(project.core_hours || project.runs || 0) > 0).length;
  const hasUsage = runs.some((run) => run.usage) || Number(summary.total_core_hours || 0) > 0 || Number(summary.total_gpu_hours || 0) > 0;
  const hasTerminal = runs.some((run) => ["finished", "failed", "cancelled"].includes(run.status));
  return hasUsage || hasTerminal || statusBuckets > 2 || projectBuckets > 1;
}
function runsHeaderSummary(data, runs) {
  const total = data.total ?? runs.length;
  const loaded = runs.length;
  const count = total === loaded ? `${total} run${total === 1 ? "" : "s"}` : `${loaded}/${total} runs`;
  const detail = `Read-only local run evidence over .uts-computing/. ${loaded} loaded out of ${total} total.`;
  return `<span class="runs-header-summary" title="${esc(detail)}" aria-label="${esc(detail)}">
    <span class="runs-header-chip"><i class="ti ti-list-details"></i>${esc(count)}</span>
    <span class="runs-header-chip"><i class="ti ti-database"></i>local state</span>
    <span class="runs-header-chip"><i class="ti ti-shield-lock"></i>read-only</span>
    <span class="visually-hidden">Local run evidence is read from .uts-computing/.</span>
  </span>`;
}
function wireNativeRunsWorkbench(runs, viewDefs, initial) {
  const workbench = document.getElementById("runs-workbench");
  const rows = [...document.querySelectorAll("#runs-table tbody tr[data-run-id]")];
  if (!workbench || !rows.length) return;
  workbench.dataset.filterEngine = "native";
  const runById = new Map(runs.map((r) => [r.run_id, r]));
  const searchInput = document.querySelector("#runs-workbench .search");
  const density = document.getElementById("runs-density");
  const state = {
    statusF: initial.statusF || "all",
    projF: initial.projF || "",
    platformF: initial.platformF || "",
    queueF: initial.queueF || "",
    searchF: initial.searchF || "",
    sort: normalizeRunSort(initial.sort?.key, initial.sort?.dir)
  };
  const matchesRow = (row) => {
    const run = runById.get(row.dataset.runId);
    return runMatchesFilters(run, state);
  };
  const apply = () => {
    let matching = 0;
    const matchingRuns = [];
    const tbody = document.querySelector("#runs-table tbody");
    rows
      .slice()
      .sort((a, b) => compareRunsForSort(runById.get(a.dataset.runId), runById.get(b.dataset.runId), state.sort))
      .forEach((row) => tbody.appendChild(row));
    rows.forEach((row) => {
      const matched = matchesRow(row);
      row.classList.toggle("d-none", !matched);
      if (matched) {
        matching += 1;
        const run = runById.get(row.dataset.runId);
        if (run) matchingRuns.push(run);
      }
    });
    syncRunsMobileCards(runs, state, state.sort);
    syncRunsFilterChrome(viewDefs, state, matching, runs.length);
    setSafetyContext(runsSafetyContext(matchingRuns, runs.length));
    syncRunsSortHeadings(state.sort);
    announceStatus(`Runs filters show ${matching} of ${runs.length} results.`);
  };
  const setViewFilter = (value) => {
    state.statusF = value || "all";
    apply();
  };
  wireRunsSavedViews(() => state);
  if (localStorage.getItem(RUN_DENSITY_STORAGE_KEY) === "compact") {
    workbench.classList.add("runs-compact");
  }
  document.querySelectorAll("#status-filters .btn").forEach((btn) => {
    btn.addEventListener("click", () => setViewFilter(btn.dataset.filter));
  });
  document.querySelectorAll("[data-triage-filter]").forEach((btn) => {
    btn.addEventListener("click", () => setViewFilter(btn.dataset.triageFilter));
  });
  document.querySelectorAll("[data-run-sort]").forEach((btn) => {
    btn.addEventListener("click", () => {
      state.sort = normalizeRunSort(btn.dataset.runSort, btn.dataset.nextDir);
      apply();
      announceStatus(`Runs sorted by ${runSortLabel(state.sort.key)} ${state.sort.dir}.`);
    });
  });
  document.getElementById("project-filter")?.addEventListener("change", (e) => {
    state.projF = e.target.value;
    apply();
  });
  document.getElementById("platform-filter")?.addEventListener("change", (e) => {
    state.platformF = e.target.value;
    apply();
  });
  document.getElementById("queue-filter")?.addEventListener("change", (e) => {
    state.queueF = e.target.value;
    apply();
  });
  searchInput.addEventListener("input", (e) => {
    state.searchF = e.target.value.trim();
    apply();
  });
  document.getElementById("clear-run-filters").addEventListener("click", () => {
    state.statusF = "all";
    state.projF = "";
    state.platformF = "";
    state.queueF = "";
    state.searchF = "";
    state.sort = { ...RUN_SORT_DEFAULT };
    const projectFilter = document.getElementById("project-filter");
    const platformFilter = document.getElementById("platform-filter");
    const queueFilter = document.getElementById("queue-filter");
    if (projectFilter) projectFilter.value = "";
    if (platformFilter) platformFilter.value = "";
    if (queueFilter) queueFilter.value = "";
    searchInput.value = "";
    apply();
  });
  density.addEventListener("change", () => {
    const compact = density.checked;
    workbench.classList.toggle("runs-compact", compact);
    localStorage.setItem(RUN_DENSITY_STORAGE_KEY, compact ? "compact" : "comfortable");
    syncRunsViewSummaryFromWorkbench();
  });
  apply();
}
async function renderRunsList() {
  const [summary, data, projectsData, nodeUsage] = await Promise.all([
    api("/api/summary").catch(() => null),
    api("/api/runs?limit=500"),
    api("/api/projects").catch(() => null),
    api("/api/ihpc/node-usage").catch(() => null)
  ]);
  const runs = data.runs || [];
  setSafetyContext(runs.length ? runsSafetyContext(runs, runs.length) : [
    { label: "Rows", value: "0 runs", icon: "ti-list-check", title: "No saved local run evidence is available yet." }
  ]);
  const initialQuery = routeQuery();
  const initialView = initialQuery.get("view") || initialQuery.get("status") || "all";
  const initialProject = initialQuery.get("project") || "";
  const initialPlatform = initialQuery.get("platform") || "";
  const initialQueue = initialQuery.get("queue") || "";
  const initialSearch = initialQuery.get("q") || "";
  const initialSort = runSortFromQuery(initialQuery);
  const runIds = new Set(runs.map((r) => r.run_id));
  const selectedCompare = compareSet();
  const selectedBeforePrune = selectedCompare.size;
  for (const runId of selectedCompare) {
    if (!runIds.has(runId)) selectedCompare.delete(runId);
  }
  if (selectedCompare.size !== selectedBeforePrune) saveCompareSet(selectedCompare);
  const opsOverview = runsOperationalDashboard(summary, runs);
  const projectGlance = runsProjectGlance(projectsData);
  // Node load lives inside Runs (right after Projects), paired with the Runs-by-status donut on one row;
  // Core-hours by project takes its own full-width row below. It only concerns iHPC GPU occupancy, so it
  // is shown only when there are iHPC runs (or a probe snapshot already exists).
  const showNodeLoad = runs.some((r) => r.platform === "uts-ihpc") || nodeUsage?.available;
  const showCharts = runsChartsUseful(summary, runs);
  const nodeLoadSection = showNodeLoad
    ? `<section class="card runs-node-load w-100" aria-label="Node load — live iHPC GPU utilization"><div class="card-body">
        <div class="runs-project-glance-head">
          <h3>Node load</h3>
          <span>live iHPC GPU utilization for the nodes your active runs occupy</span>
        </div>
        ${nodeLoadBody(nodeUsage || { available: false })}
      </div></section>`
    : "";
  const statusDonut = `<div class="card runs-chart-card w-100"><div class="card-header"><h3 class="card-title">Runs by status</h3></div>
    <div class="card-body runs-chart-body"><div id="runs-status-donut"></div></div></div>`;
  const coreHoursBar = `<div class="card runs-chart-card w-100"><div class="card-header"><h3 class="card-title">Core-hours by project</h3></div>
    <div class="card-body runs-chart-body"><div id="runs-project-bar"></div></div></div>`;

  // Row 1: Node load (wide) + Runs-by-status (narrow), side by side; degrade gracefully when one is absent.
  let loadRow = "";
  if (showNodeLoad && showCharts) {
    loadRow = `<div class="row row-cards mb-3 runs-load-row align-items-stretch">
      <div class="col-xl-8 d-flex">${nodeLoadSection}</div>
      <div class="col-xl-4 d-flex">${statusDonut}</div>
    </div>`;
  } else if (showNodeLoad) {
    loadRow = `<div class="mb-3">${nodeLoadSection}</div>`;
  } else if (showCharts) {
    loadRow = `<div class="row row-cards mb-3"><div class="col-12 d-flex">${statusDonut}</div></div>`;
  }
  // Row 2: Core-hours by project, full width on its own row.
  const coreHoursRow = showCharts ? `<div class="row row-cards mb-3"><div class="col-12 d-flex">${coreHoursBar}</div></div>` : "";
  // The standalone "Run evidence table" teaser is removed; keep only the empty state when there are no runs.
  const emptyState = runs.length ? "" : `<div class="runs-empty-state mb-3" id="runs-empty-state">${runsEmptyState()}</div>`;

  view().innerHTML =
    header("Runs", runsHeaderSummary(data, runs), runsRefreshBar()) +
    opsOverview +
    projectGlance +
    loadRow +
    coreHoursRow +
    emptyState;

  if (showCharts) renderRunsCharts(summary);
  wireRefreshToggle(renderRunsList, { scope: "runs" });
  wireLiveReconcile(renderRunsList);
  if (showNodeLoad) wireNodeLoadRefresh(renderRunsList);
  document.getElementById("runs-empty-refresh")?.addEventListener("click", () => {
    announceStatus("Refreshing local run evidence.");
    renderRunsList();
  });
  return;

  const viewDefs = [
    ["all", "All"],
    ["active", "Active"],
    ["queued", "Queued"],
    ["planned", "Planned"],
    ["failed", "Failed"],
    ["finished", "Finished"],
    ["attention", "Needs attention"],
    ["over-requested", "Over-requested"],
    ["dirty-git", "Dirty git"],
    ["missing-evidence", "Evidence gap"]
  ];
  const filterBtns = viewDefs
    .map((s) => {
      const [value, label] = s;
      const n = runViewCount(runs, value);
      return `<button type="button" class="btn btn-sm ${value === initialView ? "active" : ""}" data-filter="${esc(value)}">${esc(label)}<span class="badge bg-secondary-lt ms-1">${n}</span></button>`;
    })
    .join("");
  const meaningfulProjectNames = runsMeaningfulProjects(runs);
  const projectFilterNames = meaningfulProjectNames.length || initialProject
    ? uniqueSorted([...meaningfulProjectNames, initialProject].filter(Boolean))
    : [];
  const projectOptions =
    `<option value="">All projects</option>` + projectFilterNames.map((p) => `<option value="${esc(p)}" ${p === initialProject ? "selected" : ""}>${esc(p)}</option>`).join("");
  const platformNames = uniqueSorted(runs.map((r) => r.platform).filter(Boolean));
  const queueNames = uniqueSorted(runs.map(runQueue).filter((v) => v !== "—"));
  const platformOptions = platformOptionTags(platformNames, initialPlatform, "All platforms");
  const queueOptions = optionTags(queueNames, initialQueue, "All queues / node families");
  const projectFilterMarkup = projectFilterNames.length
    ? `<select class="form-select form-select-sm w-auto" id="project-filter" aria-label="Filter by project">${projectOptions}</select>`
    : "";
  const platformFilterMarkup = platformNames.length > 1 || initialPlatform
    ? `<select class="form-select form-select-sm w-auto" id="platform-filter" aria-label="Filter by platform">${platformOptions}</select>`
    : "";
  const queueFilterMarkup = queueNames.length > 1 || initialQueue
    ? `<select class="form-select form-select-sm w-auto" id="queue-filter" aria-label="Filter by queue or node family">${queueOptions}</select>`
    : "";
  const initialColumns = initialRunColumnSet(runs);
  const initialHasActiveFilters = runsHasActiveFilters({
    statusF: initialView,
    projF: initialProject,
    platformF: initialPlatform,
    queueF: initialQueue,
    searchF: initialSearch,
    sort: initialSort
  });

  const rows = runs
    .map(
      (r) => {
        const selected = selectedCompare.has(r.run_id);
        const severity = attentionSeverity(r);
        const reasons = attentionReasons(r).map((reason) => reason.label).join(" | ");
        const statusLabel = `Status: ${r.status || "unknown"}.${reasons ? ` Attention: ${reasons}.` : " No attention flag."}`;
        const resourceLabel = runResourceSummaryText(r);
        const projectLabel = runProjectSummaryText(r);
        const compareLabel = compareToggleLabel(selected);
        const platformLabelText = `Platform: ${platformLabel(r.platform)}`;
        const queueLabel = `Queue / node family: ${runQueue(r)}`;
        const clusterLabel = `Cluster: ${r.cluster || "—"}`;
        const nodeLabel = `Node: ${r.node || "—"}`;
        const evidenceLabel = runEvidenceSummaryText(r);
        return `<tr data-run-id="${esc(r.run_id)}" data-run-severity="${esc(severity)}" data-run-attention-reasons="${esc(reasons)}" class="${severity !== "none" ? "run-row-attention" : ""}">
        <td class="compare-cell"><button class="btn btn-icon btn-sm btn-ghost-secondary compare-toggle ${selected ? "active" : ""}" type="button" data-compare-run="${esc(r.run_id)}" aria-pressed="${selected ? "true" : "false"}" aria-label="${esc(compareLabel)}" title="${esc(compareLabel)}"><span class="compare-toggle-mark" aria-hidden="true">${selected ? "-" : "+"}</span><i class="ti ${selected ? "ti-eye" : "ti-eye-off"}" aria-hidden="true"></i></button></td>
        <td class="run-name-cell"><a href="/runs/${encodeURIComponent(r.run_id)}" class="text-reset fw-bold name" title="${esc(r.run_id)}">${esc(r.run_id)}</a></td>
        <td class="run-status-cell" title="${esc(statusLabel)}" aria-label="${esc(statusLabel)}">${runStatusBadge(r)}${attentionReasonHtml(r)}</td>
        <td class="resources" title="${esc(resourceLabel)}" aria-label="${esc(resourceLabel)}">${runResourceSummary(r)}</td>
        <td class="project" data-run-column="project" title="${esc(projectLabel)}" aria-label="${esc(projectLabel)}"><div class="runs-project-cell-content"><span class="runs-project-name">${esc(r.project || "—")}</span>${r.job_type ? `<span class="badge bg-secondary-lt runs-project-type">${esc(r.job_type)}</span>` : ""}</div></td>
        <td class="platform" data-run-column="platform" title="${esc(platformLabelText)}" aria-label="${esc(platformLabelText)}">${platformBadge(r.platform)}${runKindBadge(r)}</td>
        <td class="queue" data-run-column="queue" title="${esc(queueLabel)}" aria-label="${esc(queueLabel)}">${esc(runQueue(r))}</td>
        <td class="cluster" data-run-column="cluster" title="${esc(clusterLabel)}" aria-label="${esc(clusterLabel)}">${esc(r.cluster || "—")}</td>
        <td class="node" data-run-column="node" title="${esc(nodeLabel)}" aria-label="${esc(nodeLabel)}">${esc(r.node || "—")}</td>
        <td data-run-column="evidence" title="${esc(evidenceLabel)}" aria-label="${esc(evidenceLabel)}">${runEvidenceChips(r)}</td>
        <td class="created" data-run-column="created" data-ts="${esc(r.created_at)}" title="${esc(fmtTime(r.created_at))}">${esc(fmtRel(r.created_at))}</td>
        <td data-run-column="duration">${fmtDuration(r.created_at, r.updated_at)}</td>
      </tr>`;
      }
    )
    .join("");
  const mobileCards = runs.length
    ? `<div class="runs-mobile-card-list" id="runs-mobile-cards" aria-label="Runs mobile card list">${runs.map((run) => runsMobileCard(run, selectedCompare.has(run.run_id))).join("")}</div>`
    : "";
  const runsTableMarkup = runs.length
    ? `${mobileCards}<div class="table-responsive runs-table-frame" ${tableScrollRegionAttrs("Runs table")}>${tableScrollHint("Runs table")}<table class="table table-vcenter table-hover card-table" id="runs-table" style="--runs-table-width: ${runTableWidthRem(initialColumns)}rem">
       <colgroup>
         <col class="runs-col-compare" />
         <col class="runs-col-run" />
         <col class="runs-col-status" />
         <col class="runs-col-resources" />
         <col class="runs-col-project" data-run-column="project" />
         <col class="runs-col-platform" data-run-column="platform" />
         <col class="runs-col-queue" data-run-column="queue" />
         <col class="runs-col-cluster" data-run-column="cluster" />
         <col class="runs-col-node" data-run-column="node" />
         <col class="runs-col-evidence" data-run-column="evidence" />
         <col class="runs-col-created" data-run-column="created" />
         <col class="runs-col-duration" data-run-column="duration" />
       </colgroup>
       <thead><tr>
         <th class="compare-heading" aria-label="Compare"><i class="ti ti-eye-check" aria-hidden="true"></i><span class="visually-hidden">Compare</span></th>${runSortHeading("name", "Run", initialSort)}${runSortHeading("status", "Status", initialSort)}
         <th title="Resources / fit">Resources</th>
         ${runSortHeading("project", "Project", initialSort, "", "project")}${runSortHeading("platform", "Platform", initialSort, "", "platform")}${runSortHeading("queue", "Queue", initialSort, "Queue / node family", "queue")}
         ${runSortHeading("cluster", "Cluster", initialSort, "", "cluster")}${runSortHeading("node", "Node", initialSort, "", "node")}
         <th data-run-column="evidence">Evidence</th>
         ${runSortHeading("created", "Created", initialSort, "", "created")}<th data-run-column="duration">Duration</th>
       </tr></thead>
       <tbody class="list">${rows}</tbody>
     </table></div>
     <div class="p-3 d-none" id="runs-no-results">${emptyState("No matching runs", "Clear filters or broaden the search to see saved run evidence.", "filtered-empty")}</div>`
    : `<div class="runs-empty-state" id="runs-empty-state">${runsEmptyState()}</div>`;
  const runsToolbarMarkup = runs.length
    ? `<div class="card-body border-bottom py-2 runs-toolbar">
       <div class="runs-view-summary" id="runs-view-summary" aria-live="polite">
         ${runsViewSummaryBody(viewDefs, { statusF: initialView, projF: initialProject, platformF: initialPlatform, queueF: initialQueue, searchF: initialSearch, sort: initialSort }, runs.length, runs.length)}
       </div>
       <div class="btn-group btn-group-sm flex-wrap" id="status-filters" aria-label="Run view filters">${filterBtns}</div>
       ${projectFilterMarkup}
       ${platformFilterMarkup}
       ${queueFilterMarkup}
       <div class="runs-toolbar-spacer"></div>
       <div class="text-secondary small" id="runs-result-count" aria-live="polite">${runs.length} of ${runs.length} results</div>
       ${runsSavedViewsMenu(loadRunSavedViews())}
       ${runColumnMenu(initialColumns)}
       <label class="form-check form-switch m-0 d-inline-flex align-items-center" id="runs-density-toggle">
         <input class="form-check-input" type="checkbox" id="runs-density" ${localStorage.getItem(RUN_DENSITY_STORAGE_KEY) === "compact" ? "checked" : ""}>
         <span class="form-check-label text-secondary ms-1">Compact</span>
       </label>
       <button class="btn btn-sm btn-outline-secondary" id="clear-run-filters" type="button" ${initialHasActiveFilters ? "" : "hidden disabled"}>Clear filters</button>
       <div class="runs-search"><input class="form-control form-control-sm search" aria-label="Search runs" placeholder="Search runs…" value="${esc(initialSearch)}" /></div>
       <div class="active-filter-chips w-100" id="active-filter-chips" aria-live="polite"></div>
     </div>`
    : `<div class="card-body border-bottom py-2 runs-toolbar runs-toolbar-empty">
       <div class="text-secondary small" id="runs-result-count" aria-live="polite">0 of 0 results</div>
     </div>`;
  const compareBarMarkup = selectedCompare.size ? compareBarHtml(selectedCompare) : "";
  view().innerHTML =
    header("Runs", runsHeaderSummary(data, runs), refreshControls("runs") + liveReconcileControls()) +
    opsOverview +
    `<div class="card runs-workbench" id="runs-workbench">
     ${runsToolbarMarkup}
     ${compareBarMarkup}
     ${runsTableMarkup}
     </div>` +
    charts;

  if (charts) renderRunsCharts(summary);
  wireRefreshToggle(renderRunsList, { scope: "runs" });
  wireLiveReconcile(renderRunsList);
  wireRunsColumnVisibility(initialColumns);
  wireRunsToolbarMenus();
  wireCompareSelection();
  wireEvidenceChips();
  document.getElementById("runs-empty-refresh")?.addEventListener("click", () => {
    announceStatus("Refreshing local run evidence.");
    renderRunsList();
  });

  if (window.List && runs.length) {
    document.getElementById("runs-workbench").dataset.filterEngine = "listjs";
    const list = new List("runs-workbench", {
      valueNames: ["name", "status", "project", "platform", "queue", "cluster", "node", { name: "created", attr: "data-ts" }],
      listClass: "list"
    });
    const runById = new Map(runs.map((r) => [r.run_id, r]));
    let statusF = initialView;
    let projF = initialProject;
    let platformF = initialPlatform;
    let queueF = initialQueue;
    let searchF = initialSearch;
    let sortState = { ...initialSort };
    const clearBtn = document.getElementById("clear-run-filters");
    const searchInput = document.querySelector("#runs-workbench .search");
    const density = document.getElementById("runs-density");
    const syncRunsWorkbench = () => {
      const matching = list.matchingItems?.length ?? list.visibleItems.length;
      announceStatus(`Runs filters show ${matching} of ${runs.length} results.`);
      syncRunsFilterChrome(viewDefs, { statusF, projF, platformF, queueF, searchF, sort: sortState }, matching, runs.length);
      syncRunsSortHeadings(sortState);
    };
    const applySort = () => {
      list.sort("name", {
        order: "asc",
        sortFunction: (a, b) => {
          const ar = runById.get(a.values().name);
          const br = runById.get(b.values().name);
          return compareRunsForSort(ar, br, sortState);
        }
      });
    };
	    const apply = () => {
        const filters = { statusF, projF, platformF, queueF, searchF, sort: sortState };
	      list.filter((item) => {
	        const values = item.values();
	        const run = runById.get(values.name);
	        return runMatchesFilters(run, filters);
	      });
	      list.search("");
	      applySort();
        syncRunsMobileCards(runs, filters, sortState);
	      syncRunsWorkbench();
	    };
    list.on("updated", syncRunsWorkbench);
    wireRunsSavedViews(() => ({ statusF, projF, platformF, queueF, searchF, sort: sortState }));
    if (localStorage.getItem(RUN_DENSITY_STORAGE_KEY) === "compact") {
      document.getElementById("runs-workbench").classList.add("runs-compact");
    }
    const setViewFilter = (value) => {
      statusF = value || "all";
      apply();
    };
    document.querySelectorAll("#status-filters .btn").forEach((btn) => {
      btn.addEventListener("click", () => setViewFilter(btn.dataset.filter));
    });
    document.querySelectorAll("[data-triage-filter]").forEach((btn) => {
      btn.addEventListener("click", () => setViewFilter(btn.dataset.triageFilter));
    });
    document.querySelectorAll("[data-run-sort]").forEach((btn) => {
      btn.addEventListener("click", () => {
        sortState = normalizeRunSort(btn.dataset.runSort, btn.dataset.nextDir);
        apply();
        announceStatus(`Runs sorted by ${runSortLabel(sortState.key)} ${sortState.dir}.`);
      });
    });
    document.getElementById("project-filter")?.addEventListener("change", (e) => {
      projF = e.target.value;
      apply();
    });
    document.getElementById("platform-filter")?.addEventListener("change", (e) => {
      platformF = e.target.value;
      apply();
    });
    document.getElementById("queue-filter")?.addEventListener("change", (e) => {
      queueF = e.target.value;
      apply();
    });
    searchInput.addEventListener("input", (e) => {
      searchF = e.target.value.trim();
      apply();
    });
    clearBtn.addEventListener("click", () => {
      statusF = "all";
      projF = "";
      platformF = "";
      queueF = "";
      searchF = "";
      sortState = { ...RUN_SORT_DEFAULT };
      const projectFilter = document.getElementById("project-filter");
      const platformFilter = document.getElementById("platform-filter");
      const queueFilter = document.getElementById("queue-filter");
      if (projectFilter) projectFilter.value = "";
      if (platformFilter) platformFilter.value = "";
      if (queueFilter) queueFilter.value = "";
      searchInput.value = "";
      apply();
    });
    density.addEventListener("change", () => {
      const compact = density.checked;
      document.getElementById("runs-workbench").classList.toggle("runs-compact", compact);
      localStorage.setItem(RUN_DENSITY_STORAGE_KEY, compact ? "compact" : "comfortable");
      syncRunsViewSummaryFromWorkbench();
    });
    apply();
  } else if (runs.length) {
    wireNativeRunsWorkbench(runs, viewDefs, {
      statusF: initialView,
      projF: initialProject,
      platformF: initialPlatform,
      queueF: initialQueue,
      searchF: initialSearch,
      sort: initialSort
    });
  }
}

function updateCompareToggle(btn, selected) {
  const label = compareToggleLabel(selected);
  btn.classList.toggle("active", selected);
  btn.setAttribute("aria-pressed", selected ? "true" : "false");
  btn.setAttribute("aria-label", label);
  btn.setAttribute("title", label);
  const row = btn.closest("tr[data-run-id]");
  if (row) {
    row.classList.toggle("run-row-compared", selected);
    row.setAttribute("data-compare-selected", selected ? "true" : "false");
  }
  const card = btn.closest(".runs-mobile-card[data-run-id]");
  if (card) {
    card.classList.toggle("run-card-compared", selected);
    card.setAttribute("data-compare-selected", selected ? "true" : "false");
  }
  const icon = btn.querySelector("i");
  if (icon) icon.className = `ti ${selected ? "ti-eye" : "ti-eye-off"}`;
  const mark = btn.querySelector(".compare-toggle-mark");
  if (mark) mark.textContent = selected ? "-" : "+";
}
function wireCompareSelection() {
  const bindClear = () => {
    const clearEl = document.getElementById("compare-clear");
    if (!clearEl || clearEl.dataset.compareBound === "true") return;
    clearEl.dataset.compareBound = "true";
    clearEl.addEventListener("click", () => {
      saveCompareSet(new Set());
      refresh();
    });
  };
  const ensureCompareBar = (set) => {
    const bar = document.querySelector(".compare-bar");
    if (!set.size) {
      bar?.remove();
      return;
    }
    if (!bar) {
      const anchor = document.querySelector(".runs-mobile-card-list, .runs-table-frame, #runs-empty-state");
      anchor?.insertAdjacentHTML("beforebegin", compareBarHtml(set));
    }
    bindClear();
  };
  const refresh = () => {
    const set = compareSet();
    ensureCompareBar(set);
    const countEl = document.getElementById("compare-count");
    const openEl = document.getElementById("compare-open");
    const clearEl = document.getElementById("compare-clear");
    if (countEl) countEl.textContent = `${set.size} selected for compare`;
    if (openEl) {
      openEl.setAttribute("href", compareHref(set));
      openEl.classList.toggle("disabled", set.size === 0);
      openEl.setAttribute("aria-disabled", set.size ? "false" : "true");
    }
    if (clearEl) clearEl.disabled = set.size === 0;
    document.querySelectorAll("[data-compare-run]").forEach((btn) => updateCompareToggle(btn, set.has(btn.dataset.compareRun)));
  };
  document.querySelectorAll("[data-compare-run]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const set = compareSet();
      const runId = btn.dataset.compareRun;
      if (set.has(runId)) set.delete(runId);
      else if (set.size >= MAX_COMPARE_RUNS) {
        toast(`Select up to ${MAX_COMPARE_RUNS} runs for side-by-side compare.`, "warning");
        return;
      } else {
        set.add(runId);
      }
      saveCompareSet(set);
      refresh();
    });
  });
  refresh();
}

function renderRunsCharts(summary) {
  if (!summary || !window.ApexCharts) return;
  const bs = summary.by_status || {};
  const labels = Object.keys(bs);
  if (labels.length) {
    mkChart(document.getElementById("runs-status-donut"), {
      chart: { type: "donut", height: 240, fontFamily: "inherit" },
      series: labels.map((k) => bs[k]),
      labels,
      colors: labels.map((k) => statusChartColor(k)),
      legend: { position: "bottom" },
      tooltip: { theme: document.documentElement.getAttribute("data-bs-theme") || "light" }
    });
  }
  // Show every project (top 8 by core-hours), not only those with usage — otherwise a project whose runs
  // are all still queued silently vanishes, so "2 projects" can render as "1 bar". Projects with 0
  // measured core-hours appear as a labelled, empty bar (honest: queued / no accounting yet).
  const byProj = [...(summary.by_project || [])].sort((a, b) => (b.core_hours || 0) - (a.core_hours || 0)).slice(0, 8);
  const anyCoreHours = byProj.some((p) => (p.core_hours || 0) > 0);
  const bar = document.getElementById("runs-project-bar");
  if (byProj.length && anyCoreHours) {
    mkChart(bar, {
      chart: { type: "bar", height: 240, fontFamily: "inherit", toolbar: { show: false } },
      plotOptions: { bar: { horizontal: true, borderRadius: 3, barHeight: "60%" } },
      series: [{ name: "core-hours", data: byProj.map((p) => p.core_hours || 0) }],
      xaxis: { categories: byProj.map((p) => p.project) },
      colors: [chartToken("--ops-chart-category-1", "#2563eb")],
      dataLabels: { enabled: false }
    });
  } else if (bar) {
    bar.innerHTML = `<div class="text-secondary p-3">No usage recorded yet — core-hours appear once runs finish.</div>`;
  }
}

// ---------- Side-by-side run compare ----------
function plainText(html) {
  const div = document.createElement("div");
  div.innerHTML = html;
  return div.textContent.replace(/\s+/g, " ").trim();
}
function comparePill(text, color = "secondary", icon = "ti-minus") {
  return `<span class="badge bg-${color}-lt"><i class="ti ${icon} me-1"></i>${esc(text)}</span>`;
}
function compareCell(value, { runId, group, field, text, isReference = false, matchesReference = false, differs = false } = {}) {
  const safeText = text || plainText(value || "—") || "—";
  const long = safeText.length > 46;
  const tone = isReference ? " compare-value-reference" : differs ? (matchesReference ? " compare-value-same-reference" : " compare-value-different-reference") : "";
  return `<div class="compare-value${tone}">
    ${value || `<span class="text-secondary">—</span>`}
    ${isReference ? `<div class="compare-reference-note">reference</div>` : ""}
    ${long ? `<button class="btn btn-sm btn-outline-secondary compare-inspect" type="button" data-compare-inspect data-run-id="${esc(runId || "")}" data-group="${esc(group || "")}" data-field="${esc(field || "")}" data-value="${esc(safeText)}" aria-label="Inspect ${esc(field || "compare value")} for ${esc(runId || "run")}"><i class="ti ti-maximize me-1"></i>Inspect</button>` : ""}
  </div>`;
}
function compareRows(details) {
  const artifactCount = (d) => {
    const files = d.manifest?.files || d.manifest?.artifacts || [];
    return Array.isArray(files) ? files.length : 0;
  };
  const eventCount = (d) => Array.isArray(d.run?.events) ? d.run.events.length : 0;
  const gitText = (run) => {
    const git = run.reproducibility?.git || {};
    if (!git.commit && !git.branch) return "—";
    return [git.branch && `branch ${git.branch}`, git.commit && `commit ${String(git.commit).slice(0, 10)}`, git.dirty ? "dirty" : "clean"].filter(Boolean).join(" · ");
  };
  return [
    { group: "Status", label: "Status", value: (d) => runStatusBadge(d.run) },
    { group: "Status", label: "Attention", value: (d) => needsAttention(d.run) ? comparePill("needs attention", "yellow", "ti-alert-triangle") : comparePill("no flag", "green", "ti-circle-check") },
    { group: "Plan", label: "Project", value: (d) => esc(d.run.project || "—") },
    { group: "Plan", label: "Platform / profile", value: (d) => `${esc(platformLabel(d.run.platform))}<div class="text-secondary small">${esc(d.run.profile_id || "—")}</div>` },
    { group: "Plan", label: "Plan hash", value: (d) => d.run.plan_hash ? `<code>${esc(d.run.plan_hash.slice(0, 16))}…</code>` : "" },
    { group: "Capacity", label: "Queue / node", value: (d) => `${esc(d.run.queue || d.run.submission?.queue || d.run.submission?.requested?.queue || "—")}<div class="text-secondary small">${esc(d.run.node || d.run.submission?.node || "node unknown")}</div>` },
    { group: "Capacity", label: "Requested", value: (d) => esc(requestedText(d.run)) },
    { group: "Usage", label: "Core / GPU hours", value: (d) => `${esc(d.run.usage?.core_hours ?? "—")}<span class="text-secondary"> / ${esc(d.run.usage?.gpu_hours ?? "—")}</span>` },
    { group: "Usage", label: "CPU efficiency", value: (d) => effBar(d.run.usage?.cpu_efficiency_percent) },
    { group: "Usage", label: "Memory used / requested", value: (d) => memCell({ usage: d.run.usage || {}, requested: d.run.submission?.requested || d.run.requested || {} }) },
    { group: "Reproducibility", label: "Git evidence", value: (d) => esc(gitText(d.run)) },
    { group: "Evidence", label: "Events", value: (d) => `${eventCount(d)} recorded` },
    { group: "Evidence", label: "Artifact manifest", value: (d) => artifactCount(d) ? `${artifactCount(d)} files` : `<span class="text-secondary">no files listed</span>` },
    { group: "Lineage", label: "Retry lineage", value: (d) => d.run.retry_of ? `<a href="/runs/${encodeURIComponent(d.run.retry_of)}">${esc(d.run.retry_of)}</a>` : `<span class="text-secondary">original or unknown</span>` }
  ];
}
function markdownCell(value) {
  return String(value ?? "—")
    .replace(/\r?\n/g, " ")
    .replace(/\|/g, "\\|")
    .trim() || "—";
}
function compareMarkdownSummary(details) {
  const lines = [
    "# uts-compute selected runs",
    "",
    `Visibility only; no batch actions. Generated ${fmtTime(new Date().toISOString())}.`,
    "",
    "| Run | Status | Project | Platform | Queue | Requested | Usage | Attention | Action readiness | Updated |",
    "|---|---|---|---|---|---|---|---|---|---|"
  ];
  for (const d of details) {
    const run = d.run;
    const readiness = actionReadinessModel(run, { plan: d.plan });
    const usage = [
      run.usage?.core_hours != null ? `${run.usage.core_hours} core-h` : "",
      run.usage?.gpu_hours != null ? `${run.usage.gpu_hours} gpu-h` : "",
      run.usage?.cpu_efficiency_percent != null ? `${run.usage.cpu_efficiency_percent}% CPU` : "",
      run.usage?.mem_gb != null ? `${run.usage.mem_gb} GB mem` : ""
    ].filter(Boolean).join(" · ") || "usage missing";
    lines.push(`| ${[
      run.run_id,
      run.status,
      run.project || "—",
      platformLabel(run.platform),
      runQueue(run),
	      requestedText(run, { plan: d.plan }),
	      usage,
	      attentionReasons(run).map((reason) => reason.label).join("; ") || "no attention flag",
	      `${readiness.label}: ${readiness.detail}`,
      run.updated_at || run.created_at || "—"
    ].map(markdownCell).join(" | ")} |`);
  }
  lines.push("", "Use Run Detail for saved local evidence, logs, artifacts, and MCP-gated actions.");
  return lines.join("\n");
}
function wireCompareMarkdownCopy(details) {
  document.getElementById("compare-copy-markdown")?.addEventListener("click", async () => {
    try {
      await copyText(compareMarkdownSummary(details));
      toast(`Copied Markdown summary for ${details.length} selected run${details.length === 1 ? "" : "s"}.`);
    } catch (e) {
      toast(`Markdown copy failed: ${e.message}`, "danger");
    }
  });
}
function compareEmptyState() {
  return `<div class="card compare-empty-state"><div class="card-body">
    ${emptyState(
      "No runs selected",
      "Choose visible runs for side-by-side evidence comparison.",
      "filtered-empty",
      `<a class="btn btn-primary" href="/runs"><i class="ti ti-list-details me-1"></i>Open Runs</a>
       <a class="btn btn-outline-secondary" href="/explore"><i class="ti ti-chart-dots me-1"></i>Open Explore</a>`
    )}
    <div class="compare-empty-facts" aria-label="Compare safety model">
      <span><i class="ti ti-eye"></i>Visibility only</span>
      <span><i class="ti ti-ban"></i>No batch actions</span>
      <span><i class="ti ti-database"></i>Local evidence</span>
    </div>
  </div></div>`;
}
function compareTableWidthRem(runCount) {
  return Number((12 + Math.max(1, runCount) * 14.5).toFixed(2));
}
async function renderCompare() {
  let ids = compareIdsFromRoute();
  if (!ids.length) ids = [...compareSet()];
  if (ids.length) saveCompareSet(new Set(ids));
  const actions = `<div class="btn-list"><a class="btn btn-outline-secondary" href="/runs"><i class="ti ti-arrow-left me-1"></i>Runs</a><button class="btn btn-outline-secondary" type="button" id="compare-page-clear"><i class="ti ti-x me-1"></i>Clear</button></div>`;
  if (!ids.length) {
    setSafetyContext([{ label: "Compare", value: "0 selected", icon: "ti-eye-off", title: "No runs selected for visibility-only comparison." }]);
    const emptyActions = `<div class="btn-list"><a class="btn btn-outline-secondary" href="/runs"><i class="ti ti-arrow-left me-1"></i>Runs</a><a class="btn btn-outline-secondary" href="/explore"><i class="ti ti-chart-dots me-1"></i>Explore</a></div>`;
    view().innerHTML = header("Compare", "Side-by-side run compare", emptyActions) + compareEmptyState();
    return;
  }
  const results = await Promise.all(ids.map(async (id) => {
    try {
      const data = await api(`/api/runs/${encodeURIComponent(id)}`);
      return data.found ? data : { found: false, requestedId: id };
    } catch (e) {
      return { found: false, requestedId: id, error: e.message };
    }
  }));
  const found = results.filter((d) => d.found && d.run);
  const missing = results.filter((d) => !d.found);
  if (!found.length) {
    setSafetyContext([{ label: "Compare", value: "0 loaded", icon: "ti-eye-off", title: "Selected compare runs could not be loaded from local state." }]);
    const message = "None of the selected runs could be loaded.";
    announceError("Compare", message);
    view().innerHTML = header("Compare", "Side-by-side run compare", actions) + errorState(message, "failed-to-load-local-state", "Compare", `<a class="btn btn-danger" href="/runs"><i class="ti ti-list-details me-1"></i>Back to Runs</a>`);
    document.getElementById("compare-page-clear")?.addEventListener("click", () => {
      saveCompareSet(new Set());
      navigateTo("/runs");
    });
    return;
  }
  setSafetyContext([
    { label: "Compare", value: `${found.length}/${ids.length} loaded`, icon: "ti-eye", title: "Visibility-only compare set loaded from local run evidence." },
    { label: "Profile", value: scopeValue(found.map((detail) => detail.run.profile_id), "profiles"), icon: "ti-id", title: "Profile scope represented by the loaded compare set." },
    { label: "Platform", value: scopeValue(found.map((detail) => platformLabel(detail.run.platform)), "platforms"), icon: "ti-server", title: "Platform scope represented by the loaded compare set." }
  ]);
  const foundActions = `<div class="btn-list">
    <a class="btn btn-outline-secondary" href="/runs"><i class="ti ti-arrow-left me-1"></i>Runs</a>
    <button class="btn btn-outline-primary" type="button" id="compare-copy-markdown"><i class="ti ti-markdown me-1"></i>Copy Markdown</button>
    <button class="btn btn-outline-secondary" type="button" id="compare-page-clear"><i class="ti ti-x me-1"></i>Clear</button>
  </div>`;
  const q = routeQuery();
  const mode = q.get("mode") === "all" ? "all" : "diff";
  const idsForRoute = found.map((d) => d.run.run_id);
  const requestedRef = q.get("ref") || "";
  const referenceIndex = Math.max(0, found.findIndex((d) => d.run.run_id === requestedRef));
  const referenceRun = found[referenceIndex];
  const rows = compareRows(found).map((row) => {
    const values = found.map((d) => row.value(d));
    const texts = values.map(plainText);
    return { ...row, values, texts, diff: new Set(texts).size > 1 };
  });
  const diffCount = rows.filter((row) => row.diff).length;
  const sameCount = rows.length - diffCount;
  const visibleRows = mode === "all" ? rows : rows.filter((row) => row.diff);
  const modeParams = (nextMode) => compareParams(idsForRoute, { mode: nextMode, ref: referenceRun?.run?.run_id || "" });
  const referenceOptions = found
    .map((d, index) => `<option value="${esc(d.run.run_id)}" ${index === referenceIndex ? "selected" : ""}>${esc(d.run.run_id)}</option>`)
    .join("");
  let currentGroup = "";
  const body = visibleRows.length ? visibleRows
    .map((row) => {
      const groupRow = row.group !== currentGroup ? ((currentGroup = row.group), `<tr class="compare-group-row"><th colspan="${found.length + 1}">${esc(row.group)}</th></tr>`) : "";
      const refText = row.texts[referenceIndex] || "—";
      return `${groupRow}<tr class="${row.diff ? "compare-row-diff" : "compare-row-same"}"><th class="compare-field">${esc(row.label)}${row.diff ? `<span class="badge bg-blue-lt ms-2">diff</span>` : `<span class="badge bg-secondary-lt ms-2">same</span>`}</th>${row.values.map((v, index) => `<td>${compareCell(v, {
        runId: found[index].run.run_id,
        group: row.group,
        field: row.label,
        text: row.texts[index],
        isReference: index === referenceIndex,
        matchesReference: row.texts[index] === refText,
        differs: row.diff
      })}</td>`).join("")}</tr>`;
    })
    .join("") : `<tr><td colspan="${found.length + 1}">${emptyState("No differences in compared fields", "Switch to All fields to inspect the complete evidence-oriented comparison.", "filtered-empty", `<a class="btn btn-primary" href="${esc(routeUrl("/compare", modeParams("all")))}">Show all fields</a>`)}</td></tr>`;
  view().innerHTML =
    header("Compare", `${found.length} selected · visibility-only compare, no batch actions`, foundActions) +
    (missing.length ? `<div class="alert alert-warning"><i class="ti ti-alert-triangle me-2"></i>${missing.length} selected run(s) could not be loaded: ${esc(missing.map((d) => d.requestedId).join(", "))}</div>` : "") +
    `<div class="card compare-card">
       <div class="compare-controls">
         <div class="compare-control-group">
           <label class="form-label mb-0" for="compare-reference">Reference run</label>
           <select class="form-select form-select-sm" id="compare-reference" aria-label="Reference run">${referenceOptions}</select>
         </div>
         <div class="btn-group btn-group-sm" role="group" aria-label="Compare fields">
           <a class="btn ${mode === "diff" ? "btn-primary" : "btn-outline-secondary"}" href="${esc(routeUrl("/compare", modeParams("diff")))}"><i class="ti ti-delta me-1"></i>Differences first</a>
           <a class="btn ${mode === "all" ? "btn-primary" : "btn-outline-secondary"}" href="${esc(routeUrl("/compare", modeParams("all")))}"><i class="ti ti-list-details me-1"></i>All fields</a>
         </div>
         <div class="compare-summary text-secondary small">${diffCount} differing fields · ${sameCount} same field${sameCount === 1 ? "" : "s"} ${mode === "diff" ? "hidden" : "shown"}</div>
       </div>
       <div class="table-responsive compare-table-frame" ${tableScrollRegionAttrs("Compare table")}>${tableScrollHint("Compare table")}
         <table class="table table-vcenter card-table compare-table" style="--compare-table-width: ${compareTableWidthRem(found.length)}rem">
           <colgroup>
             <col class="compare-col-field" />
             ${found.map(() => `<col class="compare-col-run" />`).join("")}
           </colgroup>
           <thead><tr><th class="compare-field">Field</th>${found.map((d, index) => `<th class="${index === referenceIndex ? "compare-reference-column" : ""}"><a href="/runs/${encodeURIComponent(d.run.run_id)}">${esc(d.run.run_id)}</a>${index === referenceIndex ? `<span class="badge bg-blue-lt ms-2">reference</span>` : `<button class="btn btn-sm btn-link px-1 py-0" type="button" data-compare-pin-ref="${esc(d.run.run_id)}">Pin reference</button>`}<div class="text-secondary small">${esc(fmtRel(d.run.updated_at || d.run.created_at))}</div></th>`).join("")}</tr></thead>
           <tbody>${body}</tbody>
         </table>
       </div>
     </div>`;
  document.getElementById("compare-page-clear")?.addEventListener("click", () => {
    saveCompareSet(new Set());
    navigateTo("/runs");
  });
  wireCompareMarkdownCopy(found);
  document.getElementById("compare-reference")?.addEventListener("change", (event) => {
    navigateTo("/compare", compareParams(idsForRoute, { mode, ref: event.target.value }));
  });
  document.querySelectorAll("[data-compare-pin-ref]").forEach((button) => {
    button.addEventListener("click", () => navigateTo("/compare", compareParams(idsForRoute, { mode, ref: button.dataset.comparePinRef })));
  });
  document.querySelectorAll("[data-compare-inspect]").forEach((button) => {
    button.addEventListener("click", () => showCompareValueModal(button));
  });
}

function wireRunDetailTabs(initial = "overview") {
  const tabs = [...document.querySelectorAll("[data-run-detail-tab]")];
  const panels = [...document.querySelectorAll("[data-run-detail-panel]")];
  if (!tabs.length || !panels.length) return;
  const activate = (name, { focus = false, announce = false } = {}) => {
    const tabName = tabs.some((tab) => tab.dataset.runDetailTab === name) ? name : initial;
    tabs.forEach((tab) => {
      const selected = tab.dataset.runDetailTab === tabName;
      tab.classList.toggle("active", selected);
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
    });
    panels.forEach((panel) => {
      const selected = panel.dataset.runDetailPanel === tabName;
      panel.classList.toggle("active", selected);
      panel.classList.toggle("show", selected);
      panel.hidden = !selected;
    });
    const activeTab = tabs.find((tab) => tab.dataset.runDetailTab === tabName);
    if (focus) activeTab?.focus();
    if (announce && activeTab) announceStatus(`Run detail tab: ${activeTab.textContent.trim()}`);
  };
  tabs.forEach((tab, index) => {
    tab.addEventListener("click", () => activate(tab.dataset.runDetailTab, { focus: true, announce: true }));
    tab.addEventListener("keydown", (event) => {
      const keyMap = {
        ArrowLeft: (index - 1 + tabs.length) % tabs.length,
        ArrowRight: (index + 1) % tabs.length,
        Home: 0,
        End: tabs.length - 1
      };
      if (!(event.key in keyMap)) return;
      event.preventDefault();
      activate(tabs[keyMap[event.key]].dataset.runDetailTab, { focus: true, announce: true });
    });
  });
  const active = tabs.find((tab) => tab.classList.contains("active")) || tabs[0];
  activate(active?.dataset.runDetailTab || initial);
}

// ---------- Run detail ----------
function runMissingState(runId) {
  return `<div class="card run-missing-state"><div class="card-body">
    ${emptyState(
      "Run not found",
      `No saved local run evidence matched "${runId}".`,
      "failed-to-load",
      `<a class="btn btn-primary" href="/runs"><i class="ti ti-list-details me-1"></i>Back to Runs</a>
       <a class="btn btn-outline-secondary" href="/explore"><i class="ti ti-chart-dots me-1"></i>Open Explore</a>`
    )}
    <div class="run-missing-facts" aria-label="Missing run evidence scope">
      <span><i class="ti ti-folder-search"></i>Local state only</span>
      <span><i class="ti ti-database-off"></i>No run record</span>
      <span><i class="ti ti-shield-lock"></i>No remote probe</span>
    </div>
  </div></div>`;
}
async function renderRunDetail(runId) {
  const data = await api(`/api/runs/${encodeURIComponent(runId)}`);
  if (!data.found) {
    setSafetyContext([{ label: "Run", value: "not found", icon: "ti-database-off", title: "No saved local run record matched this route." }]);
    view().innerHTML = header(runId, "Run detail") + runMissingState(runId);
    return;
  }
  const logsData = await api(`/api/runs/${encodeURIComponent(runId)}/logs`).catch((e) => ({
    ok: false,
    evidence: [],
    note: `Log evidence could not be loaded: ${e.message}`
  }));
  const run = data.run;
  const plan = data.plan;
  // L2: for an adopted/observed iHPC run, also pull the latest node-load snapshot so the overview can
  // show the GPU context of the node this run sits on (and flag a held-but-idle node). Read-only.
  const nodeUsage = run.platform === "uts-ihpc" && runIsAdopted(run)
    ? await api("/api/ihpc/node-usage").catch(() => null)
    : null;
  const spec = plan?.normalized_job_spec;
  setSafetyContext([
    { label: "Profile", value: run.profile_id || "profile unknown", icon: "ti-id", title: `Run profile scope: ${run.profile_id || "not recorded"}.` },
    { label: "Platform", value: platformLabel(run.platform), icon: "ti-server", title: `Run platform scope: ${platformLabel(run.platform)}.` },
    { label: "Snapshot", value: run.quota_snapshot_id || plan?.quota_snapshot_id || "snapshot not bound", icon: run.quota_snapshot_id || plan?.quota_snapshot_id ? "ti-database-check" : "ti-database-off", title: run.quota_snapshot_id || plan?.quota_snapshot_id ? "Quota snapshot evidence bound to this run or plan." : "No quota snapshot is bound in saved local evidence." }
  ]);
  const accent = STATUS[run.status]?.color || "secondary";
  const active = run.status === "running" || run.status === "submitting" || run.status === "submitted";
  view().innerHTML =
    `<div class="card card-status-top bg-${accent} mb-1"></div>` +
    header(
      run.run_id,
      `<span class="run-detail-subline">${runStatusBadge(run)}<span>project <strong>${esc(run.project || "—")}</strong></span><span>${esc(platformLabel(run.platform))}</span><span>${esc(run.profile_id || "—")}</span></span>`,
      `<div class="d-flex align-items-center gap-3 run-detail-actions">${runActions(run, { plan })}${active ? refreshControls("runDetail") : ""}</div>`,
      { className: "run-detail-page-header" }
    ) +
    `<div class="card run-detail-card">
       <div class="card-header run-detail-tab-header"><ul class="nav nav-tabs card-header-tabs run-detail-tabs" role="tablist" aria-label="Run detail sections">
         <li class="nav-item" role="presentation"><button type="button" class="nav-link active" role="tab" aria-selected="true" aria-controls="tab-overview" data-run-detail-tab="overview">Overview</button></li>
         <li class="nav-item" role="presentation"><button type="button" class="nav-link" role="tab" aria-selected="false" aria-controls="tab-params" data-run-detail-tab="params">Plan &amp; Resources</button></li>
         <li class="nav-item" role="presentation"><button type="button" class="nav-link" role="tab" aria-selected="false" aria-controls="tab-life" data-run-detail-tab="life">Lifecycle</button></li>
         <li class="nav-item" role="presentation"><button type="button" class="nav-link" role="tab" aria-selected="false" aria-controls="tab-logs" data-run-detail-tab="logs">Logs</button></li>
         <li class="nav-item" role="presentation"><button type="button" class="nav-link" role="tab" aria-selected="false" aria-controls="tab-artifacts" data-run-detail-tab="artifacts">Artifacts</button></li>
       </ul></div>
       <div class="card-body"><div class="tab-content">
         <div class="tab-pane active show" id="tab-overview" role="tabpanel" data-run-detail-panel="overview" tabindex="0">${overviewTab(run, { plan, manifest: data.manifest, logs: logsData, nodeUsage })}</div>
         <div class="tab-pane" id="tab-params" role="tabpanel" data-run-detail-panel="params" tabindex="0" hidden>${paramsTab(spec)}</div>
         <div class="tab-pane" id="tab-life" role="tabpanel" data-run-detail-panel="life" tabindex="0" hidden>${lifecycleTab(run)}</div>
         <div class="tab-pane" id="tab-logs" role="tabpanel" data-run-detail-panel="logs" tabindex="0" data-run-id="${esc(runId)}" hidden><div class="text-secondary">Loading…</div></div>
         <div class="tab-pane" id="tab-artifacts" role="tabpanel" data-run-detail-panel="artifacts" tabindex="0" hidden>${artifactsTab(data.manifest)}</div>
       </div></div>
     </div>`;
  wireRunActions(run, { plan });
  wireEvidenceChips();
  wireRunDetailTabs();
  loadLogs(runId, logsData);
  if (active) wireRefreshToggle(() => renderRunDetail(runId), { scope: "runDetail" });
}

function runActions(run, context = {}) {
  const readiness = actionReadinessModel(run, context);
  if (!readiness.action) return `<div class="run-action-stack">${readinessPill(readiness.state, readiness.label)}</div>`;
  const disabled = readiness.disabled ? "disabled" : "";
  const title = readiness.disabledReason || readiness.detail;
  const reasonId = `run-action-reason-${esc(run.run_id)}`;
  return `<div class="run-action-stack" data-run-action-readiness="${esc(readiness.state)}">
    <div class="btn-list">
      <button class="btn btn-${esc(readiness.buttonTone)} run-action-button" data-action="${esc(readiness.action)}" data-action-state="${esc(readiness.state)}" ${disabled} title="${esc(title)}" aria-label="${esc(`${readiness.actionLabel}: ${readiness.label}`)}" aria-describedby="${reasonId}">
        <i class="ti ${esc(readiness.buttonIcon)} me-1"></i>${esc(readiness.actionLabel)}
      </button>
    </div>
    <div class="run-action-reason" id="${reasonId}">
      ${readinessPill(readiness.state, readiness.label)}
      <span class="run-action-reason-detail"><i class="ti ${esc(readiness.icon)}"></i><span>${esc(readiness.detail)}</span></span>
    </div>
  </div>`;
}
function requestedText(run, context = {}) {
  const req = runRequestedResources(run);
  const planReq = context.plan?.normalized_job_spec?.resources || {};
  const merged = Object.keys(req).length ? req : planReq;
  return [merged.ncpus && `${merged.ncpus} cpu`, merged.memory_gb && `${merged.memory_gb} GB`, merged.walltime, merged.ngpus && `${merged.ngpus} gpu`]
    .filter(Boolean)
    .join(" · ") || "—";
}
function supervisorText(run) {
  if (run.remote_job_id) return `<code>${esc(run.remote_job_id)}</code>`;
  if (run.supervisor?.pid) return `<code>pid ${esc(run.supervisor.pid)}</code>`;
  if (run.supervisor) return `<span>supervisor metadata captured</span>`;
  return `<span class="text-secondary">remote execution evidence missing</span>`;
}
function blankToUndefined(value) {
  const s = String(value || "").trim();
  return s ? s : undefined;
}
function wireRunActions(run, context = {}) {
  const plan = context.plan;
  document.querySelectorAll("[data-action]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const action = btn.dataset.action;
      const readiness = actionReadinessModel(run, { plan });
      if (action === "submit") {
        showRunActionModal({
          title: readiness.modalTitle,
          icon: "ti-rocket",
          tone: "primary",
          intro: "Launch this saved plan through the same MCP conformance gate as jobs.submit; a trusted token is not required when the plan is conformant.",
          rows: [
            ["Run", `<code>${esc(run.run_id)}</code>`],
            ["Authorization", authorizationBadge(readiness.state, readiness.label)],
            ["Platform", esc(platformLabel(run.platform))],
            ["Profile", esc(run.profile_id || "—")],
            ["Requested", esc(requestedText(run, { plan }))],
            ["Plan hash", run.plan_hash ? `<code>${esc(run.plan_hash.slice(0, 16))}…</code>` : `<span class="text-secondary">missing</span>`],
            ["Saved plan", plan?.normalized_job_spec ? `<span class="badge bg-green-lt">captured</span>` : `<span class="badge bg-red-lt">missing</span>`]
          ],
          fields: [
            { name: "snapshotId", label: "Quota snapshot id", placeholder: "quota-…", help: "Used by the server-side conformance gate when a fresh snapshot is required." },
            { name: "approvalId", label: "Approval id (if required)", placeholder: "approval-…", help: "Usually not needed for conformant submit; kept for compatibility with MCP gate responses." }
          ],
          warning: "Submission may start remote execution. The WebUI is only a caller; server-side MCP conformance still decides whether it can proceed.",
          primaryLabel: "Submit run",
          onSubmit: async (values) => {
            const r = await post("/api/actions/submit", {
              runId: run.run_id,
              snapshotId: blankToUndefined(values.snapshotId),
              approvalId: blankToUndefined(values.approvalId)
            });
            toast(`Submitted ${run.run_id}${r.remote_job_id ? ` -> ${r.remote_job_id}` : ""}.`);
            router();
          }
        });
      } else if (action === "clone") {
        showRunActionModal({
          title: readiness.modalTitle,
          icon: "ti-copy",
          tone: "primary",
          intro: "Create a local dry-run retry plan. Submitting the clone remains a separate action.",
          rows: [
            ["Source run", `<code>${esc(run.run_id)}</code>`],
            ["Authorization", authorizationBadge(readiness.state, readiness.label)],
            ["Source status", runStatusBadge(run)],
            ["Resulting operation", `<code>jobs.retry.plan</code>`],
            ["Source plan", run.plan_hash ? `<code>${esc(run.plan_hash.slice(0, 16))}…</code>` : `<span class="text-secondary">missing</span>`]
          ],
          fields: [
            { name: "retryRunId", label: "New run id", value: `${run.run_id}-r1`, required: true },
            { name: "reason", label: "Reason", placeholder: "why this clone is useful", help: "Optional, but useful for later audit trails." }
          ],
          primaryLabel: "Clone run",
          onSubmit: async (values) => {
            const retryRunId = String(values.retryRunId || "").trim();
            const r = await post("/api/actions/clone", {
              sourceRunId: run.run_id,
              retryRunId,
              reason: blankToUndefined(values.reason)
            });
            toast(`Cloned -> ${r.retry?.retry_run_id || retryRunId} (dry-run plan; submit it to run).`);
            navigateTo(`/runs/${encodeURIComponent(retryRunId)}`);
          }
        });
      } else if (action === "abort") {
        showRunActionModal({
          title: readiness.modalTitle,
          icon: "ti-ban",
          tone: "danger",
          intro: "Issue a jobs.cancel request for this active run.",
          rows: [
            ["Run", `<code>${esc(run.run_id)}</code>`],
            ["Authorization", authorizationBadge(readiness.state, readiness.label)],
            ["Status", runStatusBadge(run)],
            ["Remote evidence", supervisorText(run)],
            ["Operation", `<code>jobs.cancel</code>`],
            ["Trusted token", `<span>server-side only</span>`]
          ],
          fields: [
            { name: "approvalId", label: "Approval id", placeholder: "approval-…", required: true, help: "A decided jobs.cancel approval is required for this irreversible operation." }
          ],
          warning: "Cancel is irreversible once accepted by the scheduler or supervisor. The trusted confirmation token never leaves the server.",
          primaryLabel: "Cancel run",
          onSubmit: async (values) => {
            await post("/api/actions/abort", { runId: run.run_id, approvalId: String(values.approvalId || "").trim() });
            toast(`Cancel issued for ${run.run_id}.`, "warning");
            router();
          }
        });
      }
    });
  });
}

function dl(items) {
  const rows = items
    .filter(([, v]) => v !== undefined && v !== null && v !== "")
    .map(([k, v]) => `<div class="datagrid-item"><div class="datagrid-title">${esc(k)}</div><div class="datagrid-content">${v}</div></div>`)
    .join("");
  return `<div class="datagrid">${rows}</div>`;
}
function readinessPill(state, label) {
  const map = {
    ready: ["green", "ti-circle-check"],
    "autonomous-conformant": ["green", "ti-shield-check"],
    "advisory-only": ["blue", "ti-info-circle"],
    "requires-confirmation": ["yellow", "ti-shield-lock"],
    "requires-token-confirmation": ["yellow", "ti-shield-lock"],
    blocked: ["red", "ti-alert-triangle"],
    "blocked-nonconformant": ["red", "ti-alert-triangle"],
    "blocked-stale-snapshot": ["orange", "ti-clock-exclamation"],
    captured: ["green", "ti-database-check"],
    partial: ["yellow", "ti-alert-circle"],
    missing: ["secondary", "ti-database-off"],
    "not-captured": ["secondary", "ti-database-off"],
    "not-applicable": ["secondary", "ti-minus"]
  };
  const [color, icon] = map[state] || map["not-applicable"];
  return `<span class="readiness-pill readiness-${esc(state)} badge bg-${color}-lt"><i class="ti ${icon}"></i>${esc(label)}</span>`;
}
function authorizationBadge(state, label) {
  return readinessPill(state, label);
}
function readinessCard(title, state, label, detail, evidence = []) {
  const evidenceHtml = evidence.length
    ? `<div class="readiness-evidence">${evidence.map((item) => `<span>${item}</span>`).join("")}</div>`
    : "";
  return `<div class="readiness-card" data-readiness-state="${esc(state)}">
    <div class="readiness-card-head"><div class="section-kicker">${esc(title)}</div>${readinessPill(state, label)}</div>
    <div class="readiness-detail">${esc(detail)}</div>
    ${evidenceHtml}
  </div>`;
}
function actionReadinessPanel(run, context = {}) {
  const manifest = context.manifest;
  const readiness = actionReadinessModel(run, context);
  const actionTitle = {
    submit: "Submit readiness",
    abort: "Cancel readiness",
    clone: "Clone / rerun readiness"
  }[readiness.action] || "Action readiness";
  const actionCard = readinessCard(actionTitle, readiness.state, readiness.label, readiness.detail, readiness.evidence);

  const evidenceCard = readinessCard(
    "Evidence completeness",
    manifest ? "captured" : "missing",
    manifest ? "manifest captured" : "partial",
    manifest
      ? "Artifact manifest evidence is available and can be inspected without arbitrary file browsing."
      : "Artifact manifest evidence has not been captured for this run yet.",
    [
      run.events?.length ? `<span>${esc(run.events.length)} events</span>` : `<span class="text-secondary">no events</span>`,
      run.reproducibility?.git ? `<span>git evidence</span>` : `<span class="text-secondary">git missing</span>`,
      manifest ? `<span>artifact manifest</span>` : `<span class="text-secondary">artifact manifest missing</span>`
    ]
  );
  const resourceCard = readinessCard(
    "Resource evidence",
    run.usage ? "captured" : "missing",
    run.usage ? "usage captured" : "not captured",
    run.usage
      ? "Usage evidence is available for right-sizing and efficiency review."
      : "Usage appears after status or usage polling records scheduler accounting.",
    [
      run.usage?.core_hours != null ? `<span>${esc(run.usage.core_hours)} core-h</span>` : `<span class="text-secondary">core-h missing</span>`,
      run.usage?.cpu_efficiency_percent != null ? `<span>${esc(run.usage.cpu_efficiency_percent)}% CPU</span>` : `<span class="text-secondary">CPU efficiency missing</span>`
    ]
  );
  return `<div class="readiness-grid mb-3">${actionCard}${evidenceCard}${resourceCard}</div>`;
}
function resourceFitMetric(label, value, state, note) {
  return `<div class="resource-fit-metric">
    <div class="resource-fit-metric-head"><div class="section-kicker">${esc(label)}</div>${readinessPill(state, state)}</div>
    <div class="resource-fit-metric-value">${value}</div>
    <div class="text-secondary small">${esc(note)}</div>
  </div>`;
}
function resourceFitPanel(run) {
  const usage = run.usage || {};
  const req = run.submission?.requested || {};
  const issues = [];
  let memoryState = "missing";
  let memoryValue = `<span class="text-secondary">usage missing</span>`;
  let memoryNote = "Memory fit appears after scheduler usage evidence is captured.";
  if (typeof usage.mem_gb === "number" && typeof req.memory_gb === "number") {
    const diff = Math.round((req.memory_gb - usage.mem_gb) * 10) / 10;
    const pct = req.memory_gb > 0 ? Math.round((usage.mem_gb / req.memory_gb) * 100) : null;
    memoryState = diff > 0 ? (pct < 50 ? "partial" : "captured") : "captured";
    memoryValue = `<div class="d-flex align-items-center gap-2"><strong>${esc(usage.mem_gb)} / ${esc(req.memory_gb)} GB</strong>${pct != null ? `<span class="badge bg-secondary-lt">${esc(pct)}%</span>` : ""}</div>
      <div class="progress progress-sm mt-2"><div class="progress-bar bg-${pct != null && pct < 50 ? "yellow" : "green"}" style="width:${Math.min(100, Math.max(0, pct || 0))}%"></div></div>`;
    memoryNote = diff > 0 ? `${diff} GB requested above recorded usage.` : "Recorded memory use met or exceeded request.";
    if (diff > 0 && pct < 50) issues.push(`${diff} GB memory over-requested`);
  } else if (typeof req.memory_gb === "number") {
    memoryValue = `<strong>— / ${esc(req.memory_gb)} GB</strong>`;
  }

  const cpu = usage.cpu_efficiency_percent;
  const cpuState = typeof cpu === "number" ? (cpu < 40 ? "partial" : "captured") : "missing";
  const cpuValue = typeof cpu === "number"
    ? `<div class="d-flex align-items-center gap-2"><strong>${esc(cpu)}%</strong></div>
       <div class="progress progress-sm mt-2"><div class="progress-bar bg-${cpu < 40 ? "red" : cpu < 70 ? "yellow" : "green"}" style="width:${Math.min(100, Math.max(0, cpu))}%"></div></div>`
    : `<span class="text-secondary">usage missing</span>`;
  const cpuNote = typeof cpu === "number" ? (cpu < 40 ? "Low CPU efficiency; review requested cores and parallelism." : "CPU efficiency evidence is within the expected review range.") : "CPU efficiency appears after usage polling.";
  if (typeof cpu === "number" && cpu < 40) issues.push(`${cpu}% CPU efficiency`);

  const gpuRequested = req.ngpus || 0;
  const gpuUsed = usage.ngpus;
  const gpuState = gpuRequested ? (gpuUsed == null ? "missing" : "captured") : "not-applicable";
  const gpuValue = gpuRequested ? `<strong>${esc(gpuUsed ?? "—")} / ${esc(gpuRequested)} GPU</strong>` : `<span class="text-secondary">CPU-only request</span>`;
  const gpuNote = gpuRequested ? "Compare requested GPUs with recorded GPU usage evidence." : "No GPU requested for this run.";

  const verdict = !run.usage
    ? ["missing", "Resource fit unknown", "Usage evidence has not been captured yet."]
    : issues.length
      ? ["partial", "Review resource request", issues.join(" · ")]
      : ["captured", "No obvious right-sizing issue", "Recorded usage does not show a clear over-requesting signal."];

  return `<div class="resource-fit-panel mb-3">
    <div class="resource-fit-head">
      <div><div class="section-kicker">Resource fit</div><div class="resource-fit-title">${esc(verdict[1])}</div><div class="text-secondary small">${esc(verdict[2])}</div></div>
      ${readinessPill(verdict[0], verdict[0] === "captured" ? "fit captured" : verdict[0] === "partial" ? "review" : "usage missing")}
    </div>
    <div class="resource-fit-grid">
      ${resourceFitMetric("Memory used / requested", memoryValue, memoryState, memoryNote)}
      ${resourceFitMetric("CPU efficiency", cpuValue, cpuState, cpuNote)}
      ${resourceFitMetric("GPU requested / recorded", gpuValue, gpuState, gpuNote)}
    </div>
  </div>`;
}
// A stat-card value that respects the field-state model: the formatted value when present, else the
// state token ("pending" / "n/a" / "missing") instead of a bare "—". The evidence strip below the cards
// carries the per-field reason, so the cards stay terse.
function statFieldText(run, field, format) {
  const verdict = resolveFieldState(run, field);
  return verdict.state === FIELD_STATE.PRESENT ? format(verdict.value) : fieldStateToken(verdict);
}
function overviewTab(run, context = {}) {
  const sub = run.submission || {};
  const req = sub.requested || {};
  const usage = run.usage;
  const git = run.reproducibility?.git;
  const gitChip = git && git.sha
    ? `<code>${esc(git.sha.slice(0, 10))}</code> @ ${esc(git.branch)}${git.dirty ? ' <span class="badge bg-yellow-lt">dirty</span>' : ""}`
    : "—";
  const cards = `<div class="row row-cards mb-3">
    ${statCard("Core h", statFieldText(run, "usage", (u) => u.core_hours != null ? String(u.core_hours) : "—"), "ti-cpu", "azure", "Core-hours")}
    ${statCard("GPU h", statFieldText(run, "usage", (u) => u.gpu_hours != null ? String(u.gpu_hours) : "—"), "ti-device-desktop-analytics", "purple", "GPU-hours")}
    ${statCard("CPU eff", statFieldText(run, "usage", (u) => u.cpu_efficiency_percent != null ? u.cpu_efficiency_percent + "%" : "—"), "ti-gauge", "green", "CPU efficiency")}
    ${statCard("Node", statFieldText(run, "node", (n) => String(n)), "ti-server", "orange")}
  </div>`;
  const retryOf = run.retry_of?.source_run_id;
  return runDetailEvidenceChips(run, context) + actionReadinessPanel(run, context) + resourceFitPanel(run) + nodeHardwarePanel(run, context.nodeUsage) + cards + dl([
    ["Status", runStatusBadge(run)],
    ["Cloned from", retryOf ? `<a href="/runs/${encodeURIComponent(retryOf)}" class="text-reset"><code>${esc(retryOf)}</code></a>` : ""],
    ["Account", esc(sub.account_label || "—")],
    ["Cluster", esc(sub.cluster || "—")],
    ["Queue", esc(sub.queue || req.queue || "—")],
    ["Remote job id", esc(run.remote_job_id || "—")],
    ["Requested", esc([req.ncpus && `${req.ncpus} cpu`, req.memory_gb && `${req.memory_gb} GB`, req.walltime, req.ngpus && `${req.ngpus} gpu`].filter(Boolean).join(" · ") || "—")],
    ["plan_hash", run.plan_hash ? `<code>${esc(run.plan_hash.slice(0, 16))}…</code>` : "—"],
    ["Git", gitChip],
    ["Created", fmtTime(run.created_at)],
    ["Updated", fmtTime(run.updated_at)],
    ["Submitted", fmtTime(sub.submitted_at)],
    ["Approval", esc(run.approval?.state || "—")]
  ]);
}
function statCard(label, value, icon, color = "primary", fullLabel = label) {
  const accessibleLabel = `${fullLabel}: ${value}`;
  return `<div class="col-6 col-lg-3"><div class="card card-sm ops-stat-card" data-stat-color="${esc(color)}"><div class="card-body">
    <span class="avatar ops-stat-icon"><i class="ti ${icon}"></i></span>
    <span class="ops-stat-body" title="${esc(accessibleLabel)}" aria-label="${esc(accessibleLabel)}"><strong class="ops-stat-value">${esc(value)}</strong><span class="ops-stat-label">${esc(label)}</span></span>
  </div></div></div>`;
}
function paramsTab(spec) {
  if (!spec) return emptyState("No saved plan", "The plan artifact for this run is not available.", "not-captured-yet");
  const r = spec.resources || {};
  return dl([
    ["Experiment", esc(spec.experiment?.name || "—")],
    ["Command", `<code>${esc(spec.command || "—")}</code>`],
    ["Queue", esc(r.queue || "—")],
    ["Node family", esc(r.node_family || "—")],
    ["ncpus", r.ncpus ?? "—"],
    ["memory_gb", r.memory_gb ?? "—"],
    ["walltime", esc(r.walltime || "—")],
    ["ngpus", r.ngpus ?? "—"],
    ["Array", r.array ? esc(`${r.array.start}–${r.array.end} (max ${r.array.max_concurrent ?? 1})`) : "—"],
    ["Workdir", esc(spec.workdir || "—")],
    ["Tags", (spec.experiment?.tags || []).map((t) => `<span class="badge bg-secondary-lt me-1">${esc(t)}</span>`).join("") || "—"]
  ]);
}
function lifecycleEventTone(event) {
  const text = `${event.kind || ""} ${event.summary || ""}`.toLowerCase();
  if (/\b(fail|failed|failure|error|exception|nonzero|reject|blocked|missing|corrupt|unsafe)\b/.test(text)) {
    return { severity: "danger", label: "attention", icon: "ti-alert-triangle" };
  }
  if (/\b(cancel|cancelled|abort|stale|warn|warning|dirty|expired|partial)\b/.test(text)) {
    return { severity: "warning", label: "review", icon: "ti-alert-circle" };
  }
  if (/\b(finish|finished|success|succeeded|approved|captured|verified|complete|completed)\b/.test(text)) {
    return { severity: "success", label: "complete", icon: "ti-circle-check" };
  }
  if (/\b(submit|submitted|start|started|running|status|logs|artifact|fetch|poll|track)\b/.test(text)) {
    return { severity: "info", label: "observed", icon: "ti-info-circle" };
  }
  return { severity: "neutral", label: "event", icon: "ti-point" };
}
function lifecycleTerminalStep(status) {
  if (status === "failed" || status === "cancelled" || status === "unknown") return status;
  return "finished";
}
function lifecycleTab(run) {
  const events = run.events || [];
  const terminal = lifecycleTerminalStep(run.status);
  const steps = ["planned", "submitted", "running", terminal];
  const reached = stageIndex(run.status);
  const stepsHtml = steps
    .map((label, i) => `<div class="step-item ${i <= reached ? "active" : ""} ${i === 3 && terminal !== "finished" ? `step-${esc(terminal)}` : ""}">${esc(label)}</div>`)
    .join("");
  const timeline = events
    .map(
      (e) => {
        const tone = lifecycleEventTone(e);
        return `<li class="timeline-event" data-event-severity="${esc(tone.severity)}">
        <div class="timeline-event-icon timeline-event-icon-${esc(tone.severity)}"><i class="ti ${esc(tone.icon)}"></i></div>
        <div class="card timeline-event-card" data-event-severity="${esc(tone.severity)}" data-event-kind="${esc(e.kind || "event")}"><div class="card-body">
          <div class="timeline-event-head">
            <div class="timeline-event-title">
              <h4 class="mb-0">${esc(e.kind || "event")}</h4>
              <span class="timeline-event-badge timeline-event-badge-${esc(tone.severity)}">${esc(tone.label)}</span>
            </div>
            <time class="timeline-event-time" datetime="${esc(e.at || "")}">${fmtTime(e.at)}</time>
          </div>
          <p class="text-secondary mb-1">${esc(e.summary || "No event summary recorded.")}</p>
          ${e.redacted_command ? `<code class="small">${esc(e.redacted_command)}</code>` : ""}
        </div></div></li>`;
      }
    )
    .join("");
  return `<div class="steps steps-counter steps-blue mb-4">${stepsHtml}</div>
    <ul class="timeline">${timeline || `<li>${emptyState("No events", "", "history-empty")}</li>`}</ul>`;
}
function stageIndex(status) {
  if (status === "finished" || status === "failed" || status === "cancelled") return 3;
  if (status === "running") return 2;
  if (status === "submitted" || status === "submitting") return 1;
  return 0;
}
function artifactsTab(manifest) {
  const files = manifest?.files || manifest?.artifacts || [];
  const missingChecksum = files.filter((f) => !(f.sha256 || f.checksum) || f.checksum_status === "skipped-large").length;
  const state = !manifest ? "not-captured" : !files.length || missingChecksum ? "partial" : "captured";
  const label = !manifest ? "not captured" : !files.length ? "manifest empty" : missingChecksum ? "partial checksum" : "manifest captured";
  const detail = !manifest
    ? "No artifact manifest has been saved for this run."
    : !files.length
      ? "A manifest source is present, but it does not list artifact rows."
      : missingChecksum
        ? "Some artifact rows are missing captured checksum evidence or were skipped by policy."
        : "Artifact rows are manifest-scoped with path, size, checksum state, and source evidence.";
  const sourceManifest = manifest?.manifest_hash
    ? `<code>${esc(String(manifest.manifest_hash).slice(0, 16))}…</code>`
    : manifest?.run_id
      ? `<code>${esc(manifest.run_id)}/manifest.json</code>`
      : `<code>manifest.json</code>`;
  const summary = readinessCard("Artifact evidence", state, label, detail, [
    manifest ? sourceManifest : `<span class="text-secondary">manifest missing</span>`,
    files.length ? `<span>${esc(files.length)} rows</span>` : `<span class="text-secondary">no rows</span>`,
    missingChecksum ? `<span>${esc(missingChecksum)} checksum gaps</span>` : `<span>checksums captured</span>`
  ]);
  if (!files.length) return summary + emptyState("No artifacts listed", "Run artifacts.list to capture a manifest for this run.", "not-captured-yet");
  const rows = files
    .map(
      (f) => {
        const checksum = f.sha256 || f.checksum || "";
        const checksumStatus = f.checksum_status || (checksum ? "captured" : "missing");
        const checksumState = checksumStatus === "captured" || checksumStatus === "verified" ? "captured" : checksumStatus === "missing" ? "missing" : "partial";
        const size = f.size_bytes ?? f.size;
        const source = manifest?.manifest_hash ? `manifest ${String(manifest.manifest_hash).slice(0, 16)}…` : manifest?.run_id ? `${manifest.run_id}/manifest.json` : "manifest.json";
        return `<tr>
          <td class="artifact-path"><code>${esc(f.relative_path || f.path || f.name || "")}</code></td>
          <td>${size != null ? `<span class="badge bg-secondary-lt">${esc(size)} B</span>` : `<span class="text-secondary">unknown</span>`}</td>
          <td>${readinessPill(checksumState, checksumStatus)}${checksum ? `<div class="text-secondary small"><code>${esc(String(checksum).slice(0, 16))}…</code></div>` : ""}</td>
          <td class="artifact-source"><code>${esc(source)}</code>${f.source_output ? `<div class="text-secondary small">${esc(f.source_output)}</div>` : ""}</td>
        </tr>`;
      }
    )
    .join("");
  return summary + `<div class="table-responsive artifact-table-frame" ${tableScrollRegionAttrs("Artifact table")}>${tableScrollHint("Artifact table")}<table class="table table-vcenter card-table artifact-table">
    <thead><tr><th>Path</th><th>Size</th><th>Checksum state</th><th>Source manifest</th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`;
}
async function loadLogs(runId, initialData = null, options = {}) {
  const pane = document.getElementById("tab-logs");
  if (!pane || pane.dataset.runId !== runId) return;
  const keepPrevious = Boolean(options.keepPrevious);
  if (keepPrevious) {
    setLogEvidenceRefreshState(pane, "refreshing", "Refreshing saved evidence...");
  } else {
    pane.innerHTML = `${logEvidenceToolbar(runId, { state: "refreshing", text: "Loading saved evidence..." })}
      <div class="text-secondary">Loading saved log evidence...</div>`;
  }
  try {
    const data = initialData || await api(`/api/runs/${encodeURIComponent(runId)}/logs`);
    if (!pane.isConnected || pane.dataset.runId !== runId) return;
    const loadedAt = new Date().toISOString();
    pane.innerHTML = logEvidencePane(runId, data, loadedAt);
    wireLogEvidenceRefresh(pane, runId);
    if (!initialData || keepPrevious) announceStatus(`Log evidence refreshed for ${runId}.`);
  } catch (e) {
    if (!pane.isConnected || pane.dataset.runId !== runId) return;
    const message = e?.message || String(e);
    if (keepPrevious && pane.querySelector("[data-log-evidence-toolbar]")) {
      setLogEvidenceRefreshState(pane, "failed", `Refresh failed: ${message}`);
      pane.querySelector("[data-log-refresh-error]")?.remove();
      pane.querySelector("[data-log-evidence-toolbar]")?.insertAdjacentHTML(
        "afterend",
        `<div class="alert alert-warning log-refresh-error" role="alert" data-log-refresh-error>
          <i class="ti ti-alert-circle" aria-hidden="true"></i>
          <span>Log evidence refresh failed; showing previous saved evidence.</span>
        </div>`
      );
      announceStatus(`Log evidence refresh failed for ${runId}; keeping previous saved evidence.`);
      return;
    }
    announceError("Log evidence", message);
    pane.innerHTML = `${logEvidenceToolbar(runId, { state: "failed", text: `Failed: ${message}` })}
      ${errorState(message, "api-error", "Log evidence")}`;
    wireLogEvidenceRefresh(pane, runId);
  }
}
function logEvidencePane(runId, data, loadedAt) {
    const ev = data.evidence || [];
    if (!ev.length) {
      return logEvidenceToolbar(runId, { state: "loaded", text: "Loaded; no saved entries", updatedAt: loadedAt }) +
      logEvidenceSummary({
        state: "not-captured",
        label: "not captured",
        detail: data.note || "Fetch logs with jobs.logs to capture evidence.",
        evidence: [`<span class="text-secondary">no saved entries</span>`, `<span>offline local state only</span>`]
      }) + emptyState("No saved logs", data.note || "Fetch logs with jobs.logs to capture evidence.", "not-captured-yet");
    }
    const streamCount = ev.reduce((n, e) => n + logEvidenceStreams(e).length, 0);
    const failedCount = ev.filter(logEvidenceIsPartial).length;
    const newestObserved = ev.map(logEvidenceObservedAt).filter(Boolean).sort().at(-1);
    const summary = logEvidenceSummary({
      state: failedCount ? "partial" : "captured",
      label: failedCount ? "partial" : "saved",
      detail: failedCount
      ? "Saved log evidence is present, but one or more captured entries reports an error or failed status."
      : "Saved bounded log evidence is available for this run.",
      evidence: [
        `<span>${esc(ev.length)} saved entries</span>`,
        streamCount ? `<span>${esc(streamCount)} streams</span>` : `<span class="text-secondary">stream count unknown</span>`,
        failedCount ? `<span>${esc(failedCount)} partial entries</span>` : `<span>no failed entries</span>`,
        newestObserved ? `<span>latest ${esc(fmtRel(newestObserved))}</span>` : `<span class="text-secondary">observed time missing</span>`
      ]
    });
    const blocks = ev
      .map((e) => {
        const streams = logEvidenceStreams(e);
        const out = logEvidenceContent(e, streams);
        const entryState = logEvidenceIsPartial(e) ? "partial" : "captured";
        const observed = logEvidenceObservedAt(e);
        const kind = e.kind || e.evidence?.kind || "saved evidence";
        return `<div class="log-evidence-block">
          <div class="log-evidence-head">
            <div><strong>${esc(e.name)}</strong><div class="text-secondary small">${esc(kind)}${observed ? ` · ${esc(fmtRel(observed))}` : ""}</div></div>
            <div class="log-evidence-meta">
              ${streams.length ? `<span>${esc(streams.length)} streams</span>` : `<span class="text-secondary">stream count unknown</span>`}
              ${readinessPill(entryState, entryState === "captured" ? "saved" : "partial")}
            </div>
          </div>
          ${logEvidenceStreamRows(streams)}
          <pre class="log-evidence-output">${esc(out)}</pre>
        </div>`;
      })
      .join("");
    return logEvidenceToolbar(runId, {
      state: "loaded",
      text: newestObserved ? `Loaded; latest ${fmtRel(newestObserved)}` : "Loaded saved evidence",
      updatedAt: loadedAt
    }) + summary + blocks;
}
function logRefreshStateMeta(state) {
  return {
    refreshing: { icon: "ti-refresh", busy: true, severity: "info" },
    failed: { icon: "ti-alert-circle", busy: false, severity: "warning" },
    loaded: { icon: "ti-circle-check", busy: false, severity: "success" }
  }[state] || { icon: "ti-circle", busy: false, severity: "info" };
}
function logEvidenceRefreshStateHtml(state, text, updatedAt = "") {
  const meta = logRefreshStateMeta(state);
  const title = updatedAt ? `Last successful log evidence refresh: ${fmtTime(updatedAt)}` : text;
  return `<span class="log-refresh-state log-refresh-${esc(state)}" data-log-refresh-state="${esc(state)}" data-log-refresh-severity="${esc(meta.severity)}" role="status" aria-live="polite" aria-atomic="true" aria-busy="${meta.busy ? "true" : "false"}" aria-label="Log evidence refresh state: ${esc(text)}" title="${esc(title)}">
    <i class="ti ${esc(meta.icon)}" aria-hidden="true"></i>
    <span data-log-refresh-text>${esc(text)}</span>
  </span>`;
}
function logEvidenceToolbar(runId, { state = "loaded", text = "Loaded saved evidence", updatedAt = "" } = {}) {
  return `<div class="log-evidence-toolbar" data-log-evidence-toolbar data-run-id="${esc(runId)}">
    <div class="log-evidence-toolbar-copy">
      <div class="log-evidence-toolbar-title">Saved log evidence</div>
      <div class="log-evidence-toolbar-subtitle">Bounded local evidence from job-operation snapshots.</div>
    </div>
    <div class="log-evidence-toolbar-actions">
      ${logEvidenceRefreshStateHtml(state, text, updatedAt)}
      <button type="button" class="btn btn-outline-secondary btn-sm" data-log-evidence-refresh aria-label="Reload log evidence for ${esc(runId)}" ${state === "refreshing" ? "disabled" : ""}>
        <i class="ti ti-refresh" aria-hidden="true"></i>
        <span>Reload</span>
      </button>
    </div>
  </div>`;
}
function setLogEvidenceRefreshState(pane, state, text, updatedAt = "") {
  const meta = logRefreshStateMeta(state);
  const stateEl = pane.querySelector("[data-log-refresh-state]");
  if (stateEl) {
    stateEl.dataset.logRefreshState = state;
    stateEl.dataset.logRefreshSeverity = meta.severity;
    stateEl.className = `log-refresh-state log-refresh-${state}`;
    stateEl.setAttribute("aria-busy", meta.busy ? "true" : "false");
    stateEl.setAttribute("aria-label", `Log evidence refresh state: ${text}`);
    stateEl.title = updatedAt ? `Last successful log evidence refresh: ${fmtTime(updatedAt)}` : text;
    const icon = stateEl.querySelector("i");
    const label = stateEl.querySelector("[data-log-refresh-text]");
    if (icon) icon.className = `ti ${meta.icon}`;
    if (label) label.textContent = text;
  }
  const button = pane.querySelector("[data-log-evidence-refresh]");
  if (button) button.disabled = state === "refreshing";
}
function wireLogEvidenceRefresh(pane, runId) {
  pane.querySelector("[data-log-evidence-refresh]")?.addEventListener("click", () => {
    loadLogs(runId, null, { keepPrevious: true });
  });
}
function logEvidencePayload(entry) {
  return entry?.evidence && typeof entry.evidence === "object" ? entry.evidence : entry;
}
function logEvidenceStreams(entry) {
  const payload = logEvidencePayload(entry);
  if (Array.isArray(payload.streams)) return payload.streams;
  if (Array.isArray(entry.streams)) return entry.streams;
  if (payload.stdout || payload.stderr || entry.stdout || entry.stderr) {
    return [{ stream: payload.stream || entry.stream || "saved", content: payload.stdout || payload.stderr || entry.stdout || entry.stderr, status: payload.status || entry.status }];
  }
  return [];
}
function logEvidenceContent(entry, streams) {
  const payload = logEvidencePayload(entry);
  return payload.stdout || entry.stdout || streams.map((s) => [s.stream, s.summary, s.content].filter(Boolean).join(": ")).join("\n") || JSON.stringify(payload, null, 2);
}
function logStreamState(stream) {
  const status = String(stream?.status || "").toLowerCase();
  if (stream?.error || stream?.ok === false || /fail|error|partial/.test(status)) return { state: "partial", label: status || "partial" };
  if (/pass|ok|captured|saved|complete|success/.test(status)) return { state: "captured", label: status };
  if (stream?.content || stream?.summary) return { state: "captured", label: "saved" };
  return { state: "not-captured", label: status || "not captured" };
}
function logStreamDetail(stream) {
  const text = stream?.error || stream?.summary || stream?.content || "No bounded stream content was saved.";
  const chars = stream?.content ? ` · ${stream.content.length} chars` : "";
  return `${text}${chars}`;
}
function logEvidenceStreamRows(streams) {
  if (!streams.length) {
    return `<div class="log-stream-list" data-log-stream-count="0">
      <div class="log-stream-row" data-log-stream-state="not-captured">
        <div class="log-stream-name"><i class="ti ti-file-off"></i><span>streams</span></div>
        <div class="log-stream-detail">No stream-level metadata was saved with this evidence entry.</div>
        ${readinessPill("not-captured", "not captured")}
      </div>
    </div>`;
  }
  return `<div class="log-stream-list" data-log-stream-count="${esc(streams.length)}">
    ${streams.map((stream) => {
      const tone = logStreamState(stream);
      const name = stream.stream || stream.name || "saved";
      return `<div class="log-stream-row" data-log-stream-state="${esc(tone.state)}">
        <div class="log-stream-name"><i class="ti ${tone.state === "partial" ? "ti-alert-circle" : tone.state === "captured" ? "ti-file-check" : "ti-file-off"}"></i><span>${esc(name)}</span></div>
        <div class="log-stream-detail">${esc(logStreamDetail(stream))}</div>
        ${readinessPill(tone.state, tone.label)}
      </div>`;
    }).join("")}
  </div>`;
}
function logEvidenceObservedAt(entry) {
  return entry.observed_at || entry.evidence?.observed_at || entry.at || "";
}
function logEvidenceIsPartial(entry) {
  const payload = logEvidencePayload(entry);
  const streams = logEvidenceStreams(entry);
  return Boolean(entry.error || payload.error || entry.status === "failed" || payload.status === "failed" || entry.ok === false || payload.ok === false || streams.some((s) => s.error || s.status === "failed" || s.ok === false));
}
function logEvidenceSummary({ state, label, detail, evidence }) {
  return `<div class="log-evidence-summary mb-3">${readinessCard("Log evidence", state, label, detail, evidence)}</div>`;
}

// ---------- Explore (multi-run compare + scatter) ----------
function effBar(pct) {
  if (pct == null) return "—";
  const color = pct >= 70 ? "green" : pct >= 40 ? "yellow" : "red";
  return `<div class="d-flex align-items-center"><div class="progress progress-sm flex-fill me-2" style="min-width:60px">
    <div class="progress-bar bg-${color}" style="width:${Math.min(100, pct)}%"></div></div><span class="small">${esc(pct)}%</span></div>`;
}
function memCell(r) {
  const used = r.usage?.mem_gb;
  const req = r.requested?.memory_gb;
  if (used == null && req == null) return "—";
  return `${used != null ? esc(used) : "—"} <span class="text-secondary">/ ${req != null ? esc(req) : "—"} GB</span>`;
}
function parseWalltimeSeconds(value) {
  if (typeof value !== "string") return null;
  const parts = value.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.length !== 3 || parts.some((part) => !Number.isFinite(part) || part < 0)) return null;
  return parts[0] * 3600 + parts[1] * 60 + parts[2];
}
function hoursLabel(seconds) {
  if (typeof seconds !== "number" || !Number.isFinite(seconds)) return "—";
  const hours = seconds / 3600;
  if (hours >= 10) return `${Math.round(hours)}h`;
  return `${Math.round(hours * 10) / 10}h`;
}
function compactRunLabel(runId, max = 18) {
  const text = String(runId || "—");
  if (text.length <= max) return text;
  const tail = text.split("-").filter(Boolean).slice(-3).join("-");
  const label = tail.length >= 8 ? tail : text;
  return label.length <= max ? label : `${label.slice(0, Math.max(1, max - 3))}...`;
}
function domIdToken(value) {
  const raw = String(value || "item");
  const slug = raw.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 44) || "item";
  let hash = 0;
  for (const char of raw) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${slug}-${hash.toString(36)}`;
}
function exploreRowId(runId) {
  return `explore-row-${domIdToken(runId)}`;
}
function walltimeEvidence(r) {
  const used = r.usage?.walltime_seconds;
  const requested = parseWalltimeSeconds(r.requested?.walltime);
  if (typeof used !== "number" && requested == null) return null;
  const ratio = typeof used === "number" && requested ? used / requested : null;
  const review = ratio != null && requested >= 1800 && ratio <= 0.35;
  return { run: r, used, requested, ratio, review };
}
function walltimeCell(r) {
  const evidence = walltimeEvidence(r);
  if (!evidence) return `<span class="text-secondary">—</span>`;
  return `<span class="${evidence.review ? "text-orange" : ""}">${esc(hoursLabel(evidence.used))}</span> <span class="text-secondary">/ ${esc(hoursLabel(evidence.requested))}</span>`;
}
function optionTags(values, selected, emptyLabel) {
  const opts = [`<option value="">${esc(emptyLabel)}</option>`];
  for (const value of values) {
    opts.push(`<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(value)}</option>`);
  }
  return opts.join("");
}
function platformLabel(platform) {
  return {
    "uts-hpc": "HPC",
    "uts-ihpc": "iHPC"
  }[platform] || platform || "—";
}
function platformKind(platform) {
  return {
    "uts-hpc": "hpc",
    "uts-ihpc": "ihpc"
  }[platform] || "unknown";
}
function platformBadge(platform) {
  const label = platformLabel(platform);
  const title = platform && platform !== label ? `${label} (${platform})` : label;
  return `<span class="platform-badge" data-platform-kind="${esc(platformKind(platform))}" title="${esc(title)}">${esc(label)}</span>`;
}
// A compact badge that flags an ADOPTED/observed run (external work we only watch), so its sparse
// plan/requested/project fields read as "expected for this kind" rather than "missing". Planned runs are
// the default and get no extra badge.
function runKindBadge(run) {
  if (!runIsAdopted(run)) return "";
  const kind = classifyRun(run);
  return `<span class="run-kind-badge" data-run-kind="${esc(kind)}" title="${esc(`${runKindLabel(kind)} — externally started; only observed. Plan, requested and project fields do not apply.`)}">adopted</span>`;
}
function platformOptionTags(values, selected, emptyLabel) {
  const opts = [`<option value="">${esc(emptyLabel)}</option>`];
  for (const value of values) {
    opts.push(`<option value="${esc(value)}" ${value === selected ? "selected" : ""}>${esc(platformLabel(value))}</option>`);
  }
  return opts.join("");
}
function uniqueSorted(values) {
  return [...new Set(values.filter((v) => v !== undefined && v !== null && v !== ""))].sort();
}
function runQueue(r) {
  return r.requested?.queue || r.queue || r.submission?.queue || r.node_family || r.requested?.node_family || r.submission?.requested?.node_family || "—";
}
function resourceFitCandidate(r) {
  const used = r.usage?.mem_gb;
  const req = r.requested?.memory_gb;
  const cpu = r.usage?.cpu_efficiency_percent;
  const reasons = [];
  let score = 0;
  if (typeof used === "number" && typeof req === "number" && req > used) {
    const waste = Math.round((req - used) * 10) / 10;
    const usedRatio = req > 0 ? used / req : 1;
    if (waste >= 4 || usedRatio <= 0.8) {
      reasons.push(`${waste} GB memory over-requested`);
      score += waste;
    }
  }
  if (typeof cpu === "number" && cpu < 40) {
    reasons.push(`${cpu}% CPU efficiency`);
    score += 10;
  }
  return reasons.length ? { run: r, reasons, score } : null;
}
function resourceFitCell(r) {
  const candidate = resourceFitCandidate(r);
  if (candidate) {
    const title = candidate.reasons.join(" · ");
    return `<div class="resource-fit-chips resource-fit-table-chips" title="${esc(title)}">${candidate.reasons.map((reason) => `<span class="fit-reason-chip fit-review">${esc(reason)}</span>`).join("")}</div>`;
  }
  if (!r.usage) {
    return `<div class="resource-fit-chips resource-fit-table-chips" title="Usage evidence is missing"><span class="fit-reason-chip fit-missing">usage missing</span></div>`;
  }
  return `<div class="resource-fit-chips resource-fit-table-chips" title="No clear resource-fit issue"><span class="fit-reason-chip fit-ok">no clear issue</span></div>`;
}
function candidateList(runs) {
  const candidates = runs
    .map(resourceFitCandidate)
    .filter(Boolean)
    .sort((a, b) => b.score - a.score || a.run.run_id.localeCompare(b.run.run_id))
    .slice(0, 5);
  if (!candidates.length) {
    return emptyState("No right-sizing candidates", "Runs with recorded usage and clear over-requesting will appear here.", "filtered-empty");
  }
  return `<div class="candidate-list">${candidates.map(({ run, reasons }) => `<a class="candidate-card" href="/runs/${encodeURIComponent(run.run_id)}" data-explore-highlight-run="${esc(run.run_id)}" aria-label="Open run ${esc(run.run_id)}; highlights matching Explore table row on focus">
    <div class="d-flex justify-content-between gap-2">
      <strong class="text-truncate">${esc(run.run_id)}</strong>
      <span class="badge bg-orange-lt">review</span>
    </div>
    <div class="text-secondary small">${esc(run.project || "—")} · ${esc(runQueue(run))}</div>
    <div class="resource-fit-chips">${reasons.map((reason) => `<span class="fit-reason-chip">${esc(reason)}</span>`).join("")}</div>
	  </a>`).join("")}</div>`;
}
function walltimeFitPanel(runs) {
  const rows = runs
    .map(walltimeEvidence)
    .filter((evidence) => evidence && typeof evidence.used === "number" && typeof evidence.requested === "number")
    .sort((a, b) => (a.ratio ?? 1) - (b.ratio ?? 1) || a.run.run_id.localeCompare(b.run.run_id))
    .slice(0, 6);
  if (!rows.length) {
    return "";
  }
  return `<div class="walltime-fit-panel" aria-label="Walltime requested versus actual">
    ${rows.map((item) => {
      const pct = Math.max(0, Math.min(100, Math.round((item.ratio ?? 0) * 100)));
      return `<a class="walltime-fit-row ${item.review ? "walltime-review" : ""}" href="/runs/${encodeURIComponent(item.run.run_id)}" data-explore-highlight-run="${esc(item.run.run_id)}" aria-label="Open run ${esc(item.run.run_id)}; highlights matching Explore table row on focus">
        <span class="walltime-fit-head">
          <strong>${esc(item.run.run_id)}</strong>
          <span>${esc(hoursLabel(item.used))} / ${esc(hoursLabel(item.requested))}</span>
        </span>
        <span class="walltime-fit-bar" aria-label="${esc(`${pct}% of requested walltime used`)}"><span style="width:${pct}%"></span></span>
        <span class="walltime-fit-meta">${esc(item.run.project || "—")} · ${esc(runQueue(item.run))}${item.review ? " · review request" : ""}</span>
      </a>`;
    }).join("")}
  </div>`;
}
function walltimeChartPoints(runs, limit = 8) {
  return runs
    .map(walltimeEvidence)
    .filter((evidence) => evidence && typeof evidence.used === "number" && typeof evidence.requested === "number" && evidence.requested > 0)
    .sort((a, b) => (a.ratio ?? 1) - (b.ratio ?? 1) || a.run.run_id.localeCompare(b.run.run_id))
    .slice(0, limit)
    .map((item) => {
      const pct = Math.max(0, Math.round((item.ratio ?? 0) * 100));
      return {
        x: compactRunLabel(item.run.run_id),
        y: Math.min(120, pct),
        raw_pct: pct,
        used_label: hoursLabel(item.used),
        requested_label: hoursLabel(item.requested),
        run_id: item.run.run_id,
        project: item.run.project || "—",
        queue: runQueue(item.run),
        review: item.review
      };
    });
}
function walltimeTooltip(point) {
  return `<div class="explore-tooltip walltime-tooltip">
    <div class="explore-tooltip-head">
      <strong>${esc(point.run_id)}</strong>
      <span class="explore-tooltip-fit ${point.review ? "fit-review" : "fit-ok"}">${point.review ? "review request" : "within request"}</span>
    </div>
    <div class="explore-tooltip-meta">${esc(point.project)} · ${esc(point.queue)}</div>
    <div class="explore-tooltip-metric"><span>Walltime</span><strong>${esc(point.used_label)} used / ${esc(point.requested_label)} requested</strong></div>
    <div class="explore-tooltip-foot">${esc(point.raw_pct)}% of requested walltime used</div>
  </div>`;
}
function walltimeVisual(runs) {
  const points = walltimeChartPoints(runs);
  if (!points.length) {
    return `<div class="walltime-visual-empty">${emptyState("No walltime evidence", "Walltime comparison appears after usage polling records actual runtime.", "not-captured-yet")}</div>`;
  }
  const reviewCount = points.filter((point) => point.review).length;
  return `<div class="walltime-visual" aria-label="Walltime usage ratio chart">
    <div class="walltime-chart-head">
      <div>
        <div class="section-kicker">Shortest used / requested</div>
        <div class="text-secondary small">${esc(points.length)} plotted · ${esc(reviewCount)} review candidate${reviewCount === 1 ? "" : "s"}</div>
      </div>
      <span class="badge bg-orange-lt"><i class="ti ti-clock-search me-1"></i>walltime fit</span>
    </div>
    <div id="walltime-chart" class="walltime-chart" data-walltime-count="${esc(points.length)}"></div>
    <div class="explore-chart-note text-secondary small">Bars show actual walltime as a share of requested walltime; short bars are potential over-request candidates.</div>
  </div>`;
}
const EXPLORE_TABLE_HEADERS = [
  ["Run"],
  ["Status"],
  ["Project"],
  ["Plat", "Platform"],
  ["Queue"],
  ["Core", "Core-hours"],
  ["GPU", "GPU-hours"],
  ["CPU eff.", "CPU efficiency"],
  ["Mem", "Memory used / requested"],
  ["Walltime", "Walltime used / requested"],
  ["Fit", "Resource-fit summary"],
];
function exploreHeaderCell([label, fullLabel = label]) {
  return `<th title="${esc(fullLabel)}" aria-label="${esc(fullLabel)}">${esc(label)}</th>`;
}
function exploreTableRows() {
  return [...document.querySelectorAll(".explore-table tr[data-run-id]")];
}
function exploreSelectionSummary(empty = true, row = null) {
  if (empty || !row) {
    return `<i class="ti ti-chart-dots" aria-hidden="true"></i><span>No Explore row selected</span>`;
  }
  const runId = row.dataset.runId || "";
  const meta = [row.dataset.runStatus, row.dataset.runProject, row.dataset.runQueue].filter(Boolean).join(" · ");
  return `<i class="ti ti-target-arrow" aria-hidden="true"></i><span><strong title="${esc(runId)}">${esc(compactRunLabel(runId, 26))} </strong>${meta ? `<small>Selected · ${esc(meta)}</small>` : ""}</span>`;
}
function updateExploreSelectionSummary(row) {
  const el = document.getElementById("explore-selection-summary");
  if (!el) return;
  const selected = Boolean(row);
  el.dataset.empty = selected ? "false" : "true";
  el.innerHTML = exploreSelectionSummary(!selected, row);
  if (selected) {
    const runId = row.dataset.runId || "run";
    const meta = [row.dataset.runStatus, row.dataset.runProject, row.dataset.runQueue].filter(Boolean).join("; ");
    el.setAttribute("aria-label", `Selected Explore row ${runId}${meta ? `; ${meta}` : ""}`);
  } else {
    el.setAttribute("aria-label", "No Explore row selected");
  }
}
function syncExplorePanelSelection(runId) {
  document.querySelectorAll("[data-explore-highlight-run]").forEach((item) => {
    const selected = item.getAttribute("data-explore-highlight-run") === runId;
    item.toggleAttribute("data-explore-panel-selected", selected);
  });
}
function highlightExploreRun(runId, { scroll = true, announce = true } = {}) {
  let selectedRow = null;
  for (const row of exploreTableRows()) {
    const selected = row.dataset.runId === runId;
    row.classList.toggle("table-active", selected);
    row.classList.toggle("explore-row-focus", selected);
    row.setAttribute("aria-selected", selected ? "true" : "false");
    if (selected) selectedRow = row;
  }
  const frame = selectedRow?.closest(".explore-table-frame");
  if (frame) {
    frame.setAttribute("aria-activedescendant", selectedRow.id || "");
    frame.dataset.selectedRun = runId;
  }
  syncExplorePanelSelection(selectedRow ? runId : "");
  updateExploreSelectionSummary(selectedRow);
  if (!selectedRow) return null;
  if (scroll) selectedRow.scrollIntoView({ behavior: "smooth", block: "nearest" });
  if (announce) announceStatus(`Explore highlighted ${runId}.`);
  return selectedRow;
}
function wireExploreTableRows() {
  for (const row of exploreTableRows()) {
    row.addEventListener("focus", () => highlightExploreRun(row.dataset.runId, { scroll: false }));
    row.addEventListener("click", (event) => {
      if (event.target.closest("a")) return;
      highlightExploreRun(row.dataset.runId);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") return;
      event.preventDefault();
      highlightExploreRun(row.dataset.runId);
    });
  }
}
function wireExplorePanelLinks() {
  document.querySelectorAll("[data-explore-highlight-run]").forEach((item) => {
    const runId = item.getAttribute("data-explore-highlight-run");
    const preview = () => highlightExploreRun(runId, { scroll: false, announce: false });
    item.addEventListener("mouseenter", preview);
    item.addEventListener("focus", preview);
    item.addEventListener("keydown", (event) => {
      if (event.key !== " ") return;
      event.preventDefault();
      highlightExploreRun(runId);
    });
  });
}
function exploreScatterPoint(r, used, req) {
  const overRequested = req > used;
  const waste = Math.max(0, Math.round((req - used) * 10) / 10);
  return {
    x: used,
    y: req,
    run_id: r.run_id,
    project: r.project || "—",
    status: r.status || "unknown",
    platform: platformLabel(r.platform),
    queue: runQueue(r),
    updated_at: r.updated_at || r.created_at || "",
    cpu_efficiency_percent: r.usage?.cpu_efficiency_percent,
    fit_label: overRequested ? "over-requested" : "right-sized",
    fit_detail: overRequested ? `${waste} GB headroom` : "request close to usage"
  };
}
function exploreGroupOptionTags(selected) {
  return EXPLORE_GROUP_OPTIONS
    .map((option) => `<option value="${esc(option.key)}" ${option.key === selected ? "selected" : ""}>Group by ${esc(option.label.toLowerCase())}</option>`)
    .join("");
}
function exploreGroupByFromQuery(q) {
  const value = q.get("group") || EXPLORE_GROUP_DEFAULT;
  return EXPLORE_GROUP_KEYS.has(value) ? value : EXPLORE_GROUP_DEFAULT;
}
function exploreGroupLabel(groupBy) {
  return EXPLORE_GROUP_OPTIONS.find((option) => option.key === groupBy)?.label.toLowerCase() || EXPLORE_GROUP_DEFAULT;
}
function exploreGroupValue(point, groupBy) {
  return point[groupBy] || "—";
}
function exploreGroupOrder(groupBy, value) {
  if (groupBy === "status") return STATUS_SORT_ORDER[value] ?? 99;
  return 0;
}
function exploreGroupColor(groupBy, value) {
  if (groupBy === "status") return statusChartColor(value);
  let hash = 0;
  for (const char of String(value)) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  const token = EXPLORE_GROUP_PALETTE[hash % EXPLORE_GROUP_PALETTE.length];
  return chartToken(token, "#2563eb");
}
function exploreFilterLabel(filters) {
  const parts = [];
  if (filters.project) parts.push(`Project ${filters.project}`);
  if (filters.status) parts.push(`Status ${filters.status}`);
  if (filters.platform) parts.push(filters.platform);
  if (filters.queue) parts.push(`Queue ${filters.queue}`);
  return parts.length ? parts.join(" · ") : "All resource evidence";
}
function exploreViewSummaryBody(filters, groupBy, matching, total, plotted) {
  const activeCount = Object.values(filters).filter(Boolean).length;
  const missing = Math.max(0, matching - plotted);
  return `<div class="explore-view-summary-title">
      <span class="section-kicker">Current analysis</span>
      <strong>${esc(exploreFilterLabel(filters))}</strong>
    </div>
    <div class="explore-view-summary-meta">
      <span id="explore-result-count" aria-live="polite"><i class="ti ti-list-details"></i>${esc(matching)} / ${esc(total)} runs</span>
      <span><i class="ti ti-chart-dots"></i>${esc(plotted)} plotted</span>
      <span><i class="ti ti-category"></i>group ${esc(exploreGroupLabel(groupBy))}</span>
      <span><i class="ti ti-filter"></i>${esc(activeCount)} filters</span>
      ${missing ? `<span><i class="ti ti-database-off"></i>${esc(missing)} missing usage</span>` : ""}
    </div>`;
}
function exploreSelectionSummaryBlock() {
  return `<div class="explore-selection-summary" id="explore-selection-summary" role="status" aria-live="polite" aria-atomic="true" aria-label="No Explore row selected" data-empty="true">${exploreSelectionSummary()}</div>`;
}
function exploreScatterSeries(points, groupBy) {
  const groups = new Map();
  for (const point of points) {
    const groupName = exploreGroupValue(point, groupBy);
    const group = groups.get(groupName) ?? [];
    group.push(point);
    groups.set(groupName, group);
  }
  return [...groups.entries()]
    .sort(([left], [right]) => exploreGroupOrder(groupBy, left) - exploreGroupOrder(groupBy, right) || left.localeCompare(right))
    .map(([name, data]) => ({ name, data }));
}
function exploreGroupSummary(series, groupBy) {
  if (!series.length) return "";
  const visible = series.slice(0, 6);
  const hidden = Math.max(0, series.length - visible.length);
  return `<div class="explore-group-summary" aria-label="Explore group summaries">
    ${visible.map((entry) => {
      const count = entry.data.length;
      const review = entry.data.filter((point) => point.fit_label === "over-requested").length;
      const headroom = Math.round(entry.data.reduce((sum, point) => sum + Math.max(0, point.y - point.x), 0) * 10) / 10;
      const ratios = entry.data
        .filter((point) => point.x > 0)
        .map((point) => point.y / point.x)
        .sort((a, b) => a - b);
      const medianRatio = ratios.length ? ratios[Math.floor(ratios.length / 2)] : null;
      const ratioLabel = medianRatio == null ? "ratio missing" : `${(Math.round(medianRatio * 10) / 10).toFixed(1)}x request/use`;
      const canFilter = ["project", "status", "platform", "queue"].includes(groupBy) && entry.name !== "—";
      const detail = review
        ? `${review} review · ${headroom} GB headroom`
        : `${ratioLabel}`;
      return `<button class="explore-group-summary-item" type="button" data-explore-group-filter="${esc(groupBy)}" data-explore-group-value="${esc(entry.name)}" ${canFilter ? "" : "disabled"} aria-label="${esc(`Filter Explore by ${groupBy} ${entry.name}`)}">
        <span class="explore-group-summary-head">
          <span class="explore-group-swatch" style="background:${esc(exploreGroupColor(groupBy, entry.name))}"></span>
          <strong>${esc(entry.name)}</strong>
          <span>${esc(count)} plotted</span>
        </span>
        <span class="explore-group-summary-detail ${review ? "is-review" : ""}">${esc(detail)}</span>
      </button>`;
    }).join("")}
    ${hidden ? `<span class="explore-group-summary-more">+${esc(hidden)} more group${hidden === 1 ? "" : "s"}</span>` : ""}
  </div>`;
}
function wireExploreGroupSummaryFilters() {
  document.querySelectorAll("[data-explore-group-filter][data-explore-group-value]").forEach((button) => {
    button.addEventListener("click", () => {
      const key = button.dataset.exploreGroupFilter;
      const value = button.dataset.exploreGroupValue;
      if (!key || !value || button.disabled) return;
      const params = routeQuery();
      params.set(key, value);
      if (key !== "group") params.set("group", key);
      if (params.get("group") === EXPLORE_GROUP_DEFAULT) params.delete("group");
      navigateTo("/explore", params);
    });
  });
}
// Build node -> observed-GPU summary from the latest node-load snapshot (probed, readable nodes only).
function nodeGpuIndex(nodeUsage) {
  const map = new Map();
  for (const n of (nodeUsage?.nodes || [])) {
    if (n.status !== "ok" || !n.gpus?.length) continue;
    const utils = n.gpus.map((g) => Number(g.utilization_gpu_percent) || 0);
    map.set(n.node, {
      maxUtil: Math.max(...utils),
      gpuCount: n.gpus.length,
      memUsedMb: n.gpus.reduce((s, g) => s + (Number(g.memory_used_mb) || 0), 0),
      memTotalMb: n.gpus.reduce((s, g) => s + (Number(g.memory_total_mb) || 0), 0)
    });
  }
  return map;
}
// iHPC runs have no per-run scheduler accounting, so their GPU usage falls back to the observed
// node-level occupancy of the node they sit on. Clearly labelled as node-level/observed — NOT per-run,
// since a node may host several co-located runs. Returns null when not an iHPC run or the node wasn't probed.
function observedNodeGpuChip(run, nodeGpuIdx) {
  if (run.platform !== "uts-ihpc") return null;
  const node = run.node || run.observed?.node || run.submission?.node;
  const e = node && nodeGpuIdx?.get(node);
  if (!e) return null;
  const level = e.maxUtil >= 80 ? "high" : e.maxUtil <= 5 ? "idle" : "mid";
  const memGb = e.memTotalMb ? ` · ${(e.memUsedMb / 1024).toFixed(1)}/${(e.memTotalMb / 1024).toFixed(0)} GB` : "";
  const title = `Observed node-level GPU on ${node}: busiest GPU ${e.maxUtil}% across ${e.gpuCount} GPU${e.gpuCount === 1 ? "" : "s"}${memGb} (live nvidia-smi). Node-level evidence — not per-run accounting; the node may host other runs.`;
  // The eye icon marks this as observed (vs scheduler accounting); the full "node-level, not per-run"
  // provenance is in the tooltip. Kept compact so it fits the narrow GPU column without clipping.
  return `<span class="explore-observed-gpu" data-obs-level="${esc(level)}" title="${esc(title)}"><i class="ti ti-eye"></i>${esc(e.maxUtil)}%</span>`;
}
// The Explore GPU cell: scheduler gpu-hours when present, else the observed node-level GPU for iHPC, else —.
function gpuCell(run, nodeGpuIdx) {
  if (run.usage?.gpu_hours != null) return esc(run.usage.gpu_hours);
  return observedNodeGpuChip(run, nodeGpuIdx) || "—";
}
function exploreMobileCard(r, nodeGpuIdx) {
  const usageText = [
    r.usage?.mem_gb != null ? `${r.usage.mem_gb} GB used` : "",
    r.usage?.walltime_seconds != null ? `${Math.round(r.usage.walltime_seconds / 60)} min walltime` : ""
  ].filter(Boolean).join(" · ") || "usage missing";
  const observed = observedNodeGpuChip(r, nodeGpuIdx) || esc(usageText);
  const cpuText = r.usage?.cpu_efficiency_percent != null ? `${r.usage.cpu_efficiency_percent}% CPU` : "CPU missing";
  return `<article class="explore-mobile-card" data-run-id="${esc(r.run_id)}">
    <div class="explore-mobile-card-head">
      <a href="/runs/${encodeURIComponent(r.run_id)}" class="explore-mobile-title" title="${esc(r.run_id)}">${esc(r.run_id)}</a>
      ${runStatusBadge(r)}
    </div>
    <div class="explore-mobile-meta" title="${esc(`${r.project || "—"} · ${platformLabel(r.platform)} · ${runQueue(r)}`)}">${esc(r.project || "—")} · ${esc(platformLabel(r.platform))} · ${esc(runQueue(r))}</div>
    <div class="explore-mobile-grid">
      <div><span class="explore-mobile-label">Requested</span><strong>${esc(requestedText(r))}</strong></div>
      <div><span class="explore-mobile-label">Observed</span><strong>${observed}</strong></div>
      <div><span class="explore-mobile-label">CPU</span><strong>${esc(cpuText)}</strong></div>
      <div><span class="explore-mobile-label">Fit</span><strong>${esc(runResourceFitLine(r))}</strong></div>
    </div>
  </article>`;
}
function exploreTooltip(pt) {
  const freshness = pt.updated_at ? fmtRel(pt.updated_at) : "time unknown";
  const cpu = pt.cpu_efficiency_percent != null ? `${pt.cpu_efficiency_percent}% CPU` : "CPU missing";
  return `<div class="explore-tooltip">
    <div class="explore-tooltip-head">
      <strong>${esc(pt.run_id)}</strong>
      <span class="explore-tooltip-fit ${pt.fit_label === "over-requested" ? "fit-review" : "fit-ok"}">${esc(pt.fit_label)}</span>
    </div>
    <div class="explore-tooltip-meta">${esc(pt.project)} · ${esc(pt.status)} · ${esc(pt.platform)} · ${esc(pt.queue)}</div>
    <div class="explore-tooltip-metric"><span>Memory</span><strong>${esc(pt.x)} GB used / ${esc(pt.y)} GB requested</strong></div>
    <div class="explore-tooltip-foot">${esc(pt.fit_detail)} · ${esc(cpu)} · updated ${esc(freshness)}</div>
  </div>`;
}
function exploreChartScope(filtered, totalRuns, filters, plotted, groupLabel = "status") {
  const activeFilters = Object.entries(filters).filter(([, value]) => value);
  const scope = activeFilters.length
    ? activeFilters.map(([key, value]) => `${key}: ${value}`).join(" · ")
    : "all runs";
  const latest = filtered
    .map((r) => r.updated_at || r.created_at || "")
    .filter(Boolean)
    .sort()
    .pop();
  const missing = Math.max(0, filtered.length - plotted);
  const items = [
    { icon: "ti-filter", label: "Scope", value: scope },
    { icon: "ti-chart-dots", label: "Sample", value: `${plotted} plotted / ${filtered.length} filtered / ${totalRuns} total` },
    { icon: "ti-ruler-measure", label: "Axes", value: "x used GB · y requested GB" },
    { icon: "ti-category", label: "Group", value: groupLabel },
    { icon: "ti-clock", label: "Freshness", value: latest ? `latest ${fmtRel(latest)}` : "no timestamp evidence" }
  ];
  if (missing) {
    // Explain WHY the scatter can't plot these instead of letting it look broken: adopted/observed runs
    // structurally have no usage+request, so a sparse chart is expected, not a bug.
    const adopted = filtered.filter((r) => runIsAdopted(r)).length;
    const value = adopted
      ? `${missing} not plotted · ${adopted} adopted/observed (no usage+request by design)`
      : `${missing} run${missing === 1 ? "" : "s"} without usage/request evidence`;
    items.push({ icon: "ti-database-off", label: "Not plotted", value });
  }
  return `<div class="explore-chart-scope" aria-label="Explore chart scope">
    ${items.map((item) => `<span class="explore-scope-pill" aria-label="${esc(`${item.label}: ${item.value}`)}"><i class="ti ${esc(item.icon)}"></i><strong>${esc(item.label)}</strong><span class="explore-scope-value">${esc(item.value)}</span></span>`).join("")}
  </div>`;
}
function exploreHasVisualEvidence(runs, plotted) {
  return plotted > 0 || walltimeChartPoints(runs).length > 0 || runs.some((run) => resourceFitCandidate(run));
}
async function renderExplore() {
  const [data, nodeUsage] = await Promise.all([
    api("/api/explore?limit=500"),
    api("/api/ihpc/node-usage").catch(() => null)
  ]);
  const runs = data.runs || [];
  if (!runs.length) {
    view().innerHTML =
      header("Explore", "Resource-fit analysis from existing run evidence", liveReconcileControls()) +
      `<div class="card explore-empty-state">
        <div class="card-body">
          ${exploreEmptyState()}
        </div>
      </div>`;
    document.getElementById("explore-empty-refresh")?.addEventListener("click", () => {
      announceStatus("Refreshing resource-fit analysis.");
      renderExplore();
    });
    wireLiveReconcile(renderExplore);
    return;
  }
  const q = routeQuery();
  const groupBy = exploreGroupByFromQuery(q);
  const filters = {
    project: q.get("project") || "",
    status: q.get("status") || "",
    platform: q.get("platform") || "",
    queue: q.get("queue") || ""
  };
  const filtered = runs.filter((r) =>
    (!filters.project || r.project === filters.project) &&
    (!filters.status || r.status === filters.status) &&
    (!filters.platform || r.platform === filters.platform) &&
    (!filters.queue || runQueue(r) === filters.queue)
  );
  setSafetyContext(runsSafetyContext(filtered, runs.length));
  const plotted = filtered.filter((r) => typeof r.usage?.mem_gb === "number" && typeof r.requested?.memory_gb === "number").length;
  const chartScope = exploreChartScope(filtered, runs.length, filters, plotted, exploreGroupLabel(groupBy));
  // iHPC runs have no per-run accounting, but the live node-load probe gives node-level GPU. Join by node
  // so the GPU column shows the observed occupancy of the run's node (clearly labelled, not per-run).
  const nodeGpuIdx = nodeGpuIndex(nodeUsage);
  const rows = filtered
    .map(
      (r) => `<tr id="${esc(exploreRowId(r.run_id))}" data-run-id="${esc(r.run_id)}" data-run-status="${esc(r.status || "unknown")}" data-run-project="${esc(r.project || "—")}" data-run-queue="${esc(runQueue(r))}" tabindex="0" aria-selected="false" aria-label="Highlight Explore run ${esc(r.run_id)}">
        <td class="explore-run-cell"><a href="/runs/${encodeURIComponent(r.run_id)}" class="text-reset fw-bold" title="${esc(r.run_id)}">${esc(r.run_id)}</a></td>
        <td class="explore-status-cell">${runStatusBadge(r)}</td>
        <td class="explore-project-cell" title="${esc(r.project || "—")}">${esc(r.project || "—")}</td>
        <td class="explore-platform-cell">${platformBadge(r.platform)}</td>
        <td class="explore-queue-cell" title="${esc(runQueue(r))}">${esc(runQueue(r))}</td>
        <td class="explore-number-cell">${r.usage?.core_hours != null ? esc(r.usage.core_hours) : "—"}</td>
        <td class="explore-number-cell">${gpuCell(r, nodeGpuIdx)}</td>
        <td class="explore-efficiency-cell">${effBar(r.usage?.cpu_efficiency_percent)}</td>
        <td class="explore-resource-cell">${memCell(r)}</td>
        <td class="explore-resource-cell">${walltimeCell(r)}</td>
        <td class="explore-fit-cell">${resourceFitCell(r)}</td>
      </tr>`
    )
    .join("");
  const mobileCards = filtered.length
    ? `<div class="card mb-3 explore-mobile-card-shell"><div class="explore-mobile-card-list" aria-label="Explore mobile cards">${filtered.map((r) => exploreMobileCard(r, nodeGpuIdx)).join("")}</div></div>`
    : "";
  const projects = uniqueSorted(runs.map((r) => r.project));
  const statuses = uniqueSorted(runs.map((r) => r.status));
  const platforms = uniqueSorted(runs.map((r) => r.platform));
  const queues = uniqueSorted(runs.map(runQueue).filter((v) => v !== "—"));
  const exploreChartsSection = `<div class="row row-cards explore-overview-grid mb-3">
      <div class="col-lg-4"><div class="card explore-overview-card"><div class="card-header"><h3 class="card-title">Right-sizing candidates</h3></div>
        <div class="card-body">${candidateList(filtered)}</div></div></div>
      <div class="col-lg-8"><div class="card explore-overview-card explore-memory-card"><div class="card-header"><h3 class="card-title">Requested vs used memory</h3></div>
        <div class="card-body"><div id="scatter" class="explore-scatter" data-chart-state="${plotted ? "pending" : "empty"}"></div>
          <div id="scatter-group-legend" class="explore-group-legend" aria-label="Explore scatter groups"></div>
          <div id="scatter-group-summary"></div>
        ${chartScope}
        <div class="text-secondary small mt-2 explore-chart-note">Dots are grouped by ${esc(exploreGroupLabel(groupBy))}. Each plotted dot has a matching table row and run-detail link; tooltips show resource-fit detail.</div></div></div></div>
    </div>
    <div class="card mb-3"><div class="card-header"><h3 class="card-title">Walltime requested vs actual</h3></div><div class="card-body"><div class="walltime-analysis-grid">${walltimeVisual(filtered)}${walltimeFitPanel(filtered)}</div></div></div>`;
  const exploreTableSection = `<div class="card mb-3 explore-table-card"><div class="table-responsive explore-table-frame" ${tableScrollRegionAttrs("Explore table")}>${tableScrollHint("Explore table")}<table class="table table-vcenter card-table explore-table">
      <colgroup>
        <col class="explore-col-run" />
        <col class="explore-col-status" />
        <col class="explore-col-project" />
        <col class="explore-col-platform" />
        <col class="explore-col-queue" />
        <col class="explore-col-core" />
        <col class="explore-col-gpu" />
        <col class="explore-col-efficiency" />
        <col class="explore-col-memory" />
        <col class="explore-col-walltime" />
        <col class="explore-col-fit" />
      </colgroup>
      <thead><tr>${EXPLORE_TABLE_HEADERS.map(exploreHeaderCell).join("")}</tr></thead>
      <tbody>${rows || `<tr><td colspan="11" class="p-3">${emptyState(runs.length ? "No runs match these Explore filters" : "No runs yet", runs.length ? "Clear filters or broaden the resource-fit view." : "Plan and submit runs to compare resource evidence.", runs.length ? "filtered-empty" : "history-empty")}</td></tr>`}</tbody>
     </table></div></div>`;
  const exploreSections = exploreHasVisualEvidence(filtered, plotted)
    ? `${exploreChartsSection}${exploreTableSection}`
    : `${exploreTableSection}${exploreChartsSection}`;
  view().innerHTML =
    header("Explore", "Resource-fit analysis from existing run evidence", liveReconcileControls()) +
    `<div class="card mb-3"><div class="card-body explore-toolbar">
       <div class="explore-view-summary" id="explore-view-summary">
         ${exploreViewSummaryBody(filters, groupBy, filtered.length, runs.length, plotted)}
       </div>
       <div class="explore-filter-grid" aria-label="Explore filters">
         <select class="form-select form-select-sm" id="explore-project" aria-label="Filter Explore by project">${optionTags(projects, filters.project, "All projects")}</select>
         <select class="form-select form-select-sm" id="explore-status" aria-label="Filter Explore by status">${optionTags(statuses, filters.status, "All statuses")}</select>
         <select class="form-select form-select-sm" id="explore-platform" aria-label="Filter Explore by platform">${platformOptionTags(platforms, filters.platform, "All platforms")}</select>
         <select class="form-select form-select-sm" id="explore-queue" aria-label="Filter Explore by queue">${optionTags(queues, filters.queue, "All queues")}</select>
         <select class="form-select form-select-sm" id="explore-group" aria-label="Group Explore scatter by">${exploreGroupOptionTags(groupBy)}</select>
       </div>
       ${exploreSelectionSummaryBlock()}
	       <div class="explore-toolbar-actions">
	         <button class="btn btn-sm btn-outline-secondary" id="explore-clear" type="button" ${Object.values(filters).some(Boolean) || groupBy !== EXPLORE_GROUP_DEFAULT ? "" : "disabled"}>Clear filters</button>
	       </div>
		     </div></div>
		     ${mobileCards}
		     ${exploreSections}`;
  wireLiveReconcile(renderExplore);
  document.querySelectorAll("#explore-project, #explore-status, #explore-platform, #explore-queue, #explore-group").forEach((el) => {
    el.addEventListener("change", () => {
      const params = new URLSearchParams();
      const next = {
        project: document.getElementById("explore-project").value,
        status: document.getElementById("explore-status").value,
        platform: document.getElementById("explore-platform").value,
        queue: document.getElementById("explore-queue").value,
        group: document.getElementById("explore-group").value
      };
      for (const [key, value] of Object.entries(next)) {
        if (value && !(key === "group" && value === EXPLORE_GROUP_DEFAULT)) params.set(key, value);
      }
      navigateTo("/explore", params);
    });
  });
  document.getElementById("explore-clear").addEventListener("click", () => {
    navigateTo("/explore");
  });
  wireExplorePanelLinks();
  wireExploreTableRows();
  renderScatter(filtered, groupBy);
  renderWalltimeChart(filtered);
}

function renderScatter(runs, groupBy = EXPLORE_GROUP_DEFAULT) {
  const el = document.getElementById("scatter");
  const legendEl = document.getElementById("scatter-group-legend");
  const summaryEl = document.getElementById("scatter-group-summary");
  if (!el) return;
  if (!window.ApexCharts) {
    el.dataset.chartState = "unsupported";
    if (legendEl) legendEl.innerHTML = "";
    if (summaryEl) summaryEl.innerHTML = "";
    el.innerHTML = `<div class="chart-fallback">${emptyState("Chart library unavailable", "The table and candidate list still show resource-fit evidence.", "unsupported")}</div>`;
    return;
  }
  const points = [];
  let max = 8;
  for (const r of runs) {
    const used = r.usage?.mem_gb;
    const req = r.requested?.memory_gb;
    if (typeof used !== "number" || typeof req !== "number") continue;
    max = Math.max(max, used, req);
    points.push(exploreScatterPoint(r, used, req));
  }
  if (!points.length) {
    el.dataset.chartState = "empty";
    if (legendEl) legendEl.innerHTML = "";
    if (summaryEl) summaryEl.innerHTML = "";
    el.innerHTML = `<div class="chart-fallback">${emptyState("No memory usage to plot", "Memory dots appear after status or usage polling records both requested and used memory.", "not-captured-yet")}</div>`;
    return;
  }
  el.dataset.chartState = "ready";
  const ceil = Math.ceil(max * 1.1);
  const series = exploreScatterSeries(points, groupBy);
  if (legendEl) legendEl.innerHTML = exploreGroupLegend(series, groupBy);
  if (summaryEl) {
    summaryEl.innerHTML = exploreGroupSummary(series, groupBy);
    wireExploreGroupSummaryFilters();
  }
  // Equal x/y ranges put the implicit y = x line on the chart's diagonal: dots up-and-left of it
  // over-requested memory; dots near/below used as much as requested.
  mkChart(el, {
    chart: {
      type: "scatter",
      height: 340,
      fontFamily: "inherit",
      toolbar: { show: false },
      zoom: { enabled: false },
      events: {
        dataPointSelection: (_event, _chart, config) => {
          const point = config.w.config.series[config.seriesIndex].data[config.dataPointIndex];
          highlightExploreRun(point.run_id);
        }
      }
    },
    series,
    colors: series.map((entry) => exploreGroupColor(groupBy, entry.name)),
    markers: { size: 7, strokeWidth: 1.5 },
    legend: { show: true, position: "top", horizontalAlign: "left" },
    grid: { borderColor: "rgba(128,128,128,0.2)" },
    xaxis: { type: "numeric", min: 0, max: ceil, tickAmount: 6, title: { text: "used mem (GB)" } },
    yaxis: { min: 0, max: ceil, tickAmount: 6, title: { text: "requested mem (GB)" } },
    tooltip: {
      theme: document.documentElement.getAttribute("data-bs-theme") || "light",
      custom: ({ seriesIndex, dataPointIndex, w }) => {
        const pt = w.config.series[seriesIndex].data[dataPointIndex];
        return exploreTooltip(pt);
      }
    }
  });
}
function renderWalltimeChart(runs) {
  const el = document.getElementById("walltime-chart");
  if (!el) return;
  if (!window.ApexCharts) {
    el.innerHTML = `<div class="chart-fallback">${emptyState("Chart library unavailable", "The walltime review list and table still show requested-vs-actual evidence.", "unsupported")}</div>`;
    return;
  }
  const points = walltimeChartPoints(runs);
  if (!points.length) {
    el.innerHTML = `<div class="chart-fallback">${emptyState("No walltime evidence", "Walltime bars appear after usage polling records actual runtime.", "not-captured-yet")}</div>`;
    return;
  }
  mkChart(el, {
    chart: {
      type: "bar",
      height: Math.max(220, points.length * 34),
      fontFamily: "inherit",
      toolbar: { show: false },
      events: {
        dataPointSelection: (_event, _chart, config) => {
          const point = config.w.config.series[config.seriesIndex].data[config.dataPointIndex];
          highlightExploreRun(point.run_id);
        }
      }
    },
    series: [{ name: "Used / requested", data: points }],
    colors: points.map((point) => point.review ? chartToken("--ops-risk-warning", "#f59f00") : chartToken("--ops-status-finished", "#2b8a3e")),
    plotOptions: {
      bar: {
        horizontal: true,
        borderRadius: 4,
        distributed: true,
        dataLabels: { position: "right" }
      }
    },
    dataLabels: {
      enabled: true,
      formatter: (_value, opts) => `${opts.w.config.series[opts.seriesIndex].data[opts.dataPointIndex].raw_pct}%`
    },
    legend: { show: false },
    grid: { borderColor: "rgba(128,128,128,0.18)" },
    xaxis: {
      min: 0,
      max: 120,
      tickAmount: 4,
      labels: {
        hideOverlappingLabels: true,
        formatter: (value) => `${Math.round(value)}%`,
        style: { fontSize: "10px" }
      },
      title: { text: "actual / requested walltime" }
    },
    yaxis: { labels: { maxWidth: 150 } },
    tooltip: {
      theme: document.documentElement.getAttribute("data-bs-theme") || "light",
      custom: ({ seriesIndex, dataPointIndex, w }) => walltimeTooltip(w.config.series[seriesIndex].data[dataPointIndex])
    }
  });
}
function exploreGroupLegend(series, groupBy) {
  return series.map((entry) => {
    const color = exploreGroupColor(groupBy, entry.name);
    const count = entry.data.length;
    return `<span class="explore-group-legend-item" data-group="${esc(entry.name)}">
      <span class="explore-group-swatch" style="background:${esc(color)}"></span>
      <span>${esc(entry.name)}</span>
      <strong>${esc(count)}</strong>
    </span>`;
  }).join("");
}

// ---------- Capacity Snapshot ----------
function capacityFreshness(cap) {
  if (cap.freshness === "stale" || (cap.age_minutes != null && cap.age_minutes > 15)) {
    return { state: "stale", color: "yellow", label: "stale" };
  }
  if (cap.freshness === "fresh") return { state: "fresh", color: "green", label: "fresh" };
  return { state: "unknown", color: "secondary", label: cap.freshness || "unknown" };
}
function capacityQueueState(qc, cap) {
  if (capacityFreshness(cap).state === "stale") return { label: "stale", color: "yellow", icon: "ti-clock" };
  if (qc.enabled === false || qc.started === false) return { label: "closed", color: "red", icon: "ti-lock" };
  if (qc.acceptable === true) return { label: "open", color: "green", icon: "ti-circle-check" };
  if (qc.run_headroom === 0 || qc.queued_headroom === 0) return { label: "full", color: "orange", icon: "ti-alert-circle" };
  return { label: "unknown", color: "secondary", icon: "ti-help-circle" };
}
function capacityBadge(state) {
  return `<span class="badge bg-${state.color}-lt"><i class="ti ${state.icon || "ti-circle"} me-1"></i>${esc(state.label)}</span>`;
}
function storageCards(storage = []) {
  if (!storage.length) {
    return `<div class="storage-empty-state">${emptyState(
      "No storage evidence",
      "Captured filesystem headroom will appear after quotas.refresh.",
      "not-captured-yet"
    )}</div>`;
  }
  return `<div class="storage-grid">${storage
    .map((fs) => {
      const pct = Number(fs.capacity_percent);
      const state = Number.isFinite(pct) ? (pct >= 90 ? "critical" : pct >= 80 ? "warning" : "healthy") : "unknown";
      const color = state === "critical" ? "red" : state === "warning" ? "yellow" : state === "healthy" ? "green" : "secondary";
      return `<div class="storage-card" data-storage-state="${esc(state)}">
        <div class="storage-card-head">
          <div class="storage-card-label"><strong>${esc(fs.mounted_on || fs.filesystem || "filesystem")}</strong>
            <div class="storage-card-filesystem text-secondary small">${esc(fs.filesystem || "—")}</div></div>
          <span class="badge bg-${color}-lt">${Number.isFinite(pct) ? esc(pct) : "—"}%</span>
        </div>
        <div class="progress progress-sm mt-2"><div class="progress-bar bg-${color}" style="width:${Number.isFinite(pct) ? Math.min(100, pct) : 0}%"></div></div>
        <div class="text-secondary small mt-2">${esc(fs.avail || "—")} available</div>
      </div>`;
    })
    .join("")}</div>`;
}
function capacityMeta(cap) {
  const fresh = capacityFreshness(cap);
  return `<div class="capacity-meta mb-3">
    <div><div class="section-kicker">Profile</div><div class="capacity-meta-value"><strong title="${esc(cap.profile_id || "—")}">${esc(cap.profile_id || "—")}</strong></div></div>
    <div><div class="section-kicker">Snapshot</div><div class="capacity-meta-value"><code title="${esc(cap.snapshot_id || "—")}">${esc(cap.snapshot_id || "—")}</code></div></div>
    <div><div class="section-kicker">Platform</div><div class="capacity-meta-value">${platformBadge(cap.platform)}</div></div>
    <div><div class="section-kicker">Freshness</div><div class="capacity-meta-value">${capacityBadge({ ...fresh, icon: fresh.state === "fresh" ? "ti-circle-check" : fresh.state === "stale" ? "ti-clock" : "ti-help-circle" })}</div></div>
    <div><div class="section-kicker">Observed</div><div class="capacity-meta-value"><span title="${esc(fmtTime(cap.observed_at))}">${esc(fmtRel(cap.observed_at))}</span></div></div>
    <div><div class="section-kicker">Age</div><div class="capacity-meta-value"><strong>${cap.age_minutes ?? "—"}</strong> <span class="text-secondary">min</span></div></div>
  </div>`;
}
function capacityEvidenceChips(cap) {
  const fresh = capacityFreshness(cap);
  const snapshotState = fresh.state === "fresh" ? "present" : fresh.state === "stale" ? "stale" : "partial";
  const queues = cap.queues || [];
  const storage = cap.storage || [];
  const ihpc = cap.ihpc || {};
  const availableFamilies = ihpc.available_families || [];
  const allFamilies = ihpc.all_families || [];
  const sessionCount = Number.isFinite(ihpc.active_sessions) ? ihpc.active_sessions : null;
  const platformIsIhpc = cap.platform === "uts-ihpc";
  const capacitySpecific = platformIsIhpc
    ? `${capacityEvidenceChip(
        cap,
        `${availableFamilies.length} available families`,
        allFamilies.length ? "present" : "missing",
        allFamilies.length ? "ti-server-2" : "ti-server-off",
        "QuotaSnapshot.summary.node_families",
        allFamilies.length
          ? `${availableFamilies.length} available of ${allFamilies.length} observed iHPC node families.`
          : "No iHPC node-family catalog was captured in this snapshot.",
        { type: "quota", scopeKind: "snapshot" }
      )}
      ${capacityEvidenceChip(
        cap,
        sessionCount === null ? "sessions missing" : `${sessionCount} active sessions`,
        sessionCount === null ? "missing" : "present",
        sessionCount === null ? "ti-terminal-off" : "ti-terminal-2",
        "QuotaSnapshot.summary.running_work",
        sessionCount === null
          ? "No active-session count was captured for this snapshot."
          : `${sessionCount} active iHPC session${sessionCount === 1 ? "" : "s"} observed when quotas.refresh captured the snapshot.`,
        { type: "quota", scopeKind: "snapshot" }
      )}`
    : capacityEvidenceChip(
        cap,
        queues.length ? `${queues.length} queues` : "queues missing",
        queues.length ? "present" : "missing",
        queues.length ? "ti-list-check" : "ti-list-x",
        "QuotaSnapshot.summary.queues + running_work",
        queues.length
          ? `${queues.length} PBS queue${queues.length === 1 ? "" : "s"} derived from saved queue limits and running/queued counts.`
          : "No PBS queue limits were captured in this quota snapshot.",
        { type: "quota", scopeKind: "snapshot" }
      );
  return `<div class="capacity-evidence-strip mb-3" aria-label="Capacity evidence provenance">
    <div class="section-kicker">Evidence provenance</div>
    <div class="capacity-evidence-chips">
      ${capacityEvidenceChip(
        cap,
        fresh.state === "fresh" ? "snapshot fresh" : fresh.state === "stale" ? "snapshot stale" : "snapshot freshness unknown",
        snapshotState,
        fresh.state === "fresh" ? "ti-database-check" : fresh.state === "stale" ? "ti-database-exclamation" : "ti-database-question",
        "QuotaSnapshot.observed_at + freshness",
        `Snapshot ${cap.snapshot_id || "—"} for ${cap.profile_id || "—"} was observed ${fmtRel(cap.observed_at)}${cap.age_minutes != null ? ` (${cap.age_minutes} min old)` : ""}.`,
        { type: "quota", scopeKind: "snapshot" }
      )}
      ${capacitySpecific}
      ${capacityEvidenceChip(
        cap,
        storage.length ? `${storage.length} storage mounts` : "storage missing",
        storage.length ? "present" : "missing",
        storage.length ? "ti-database" : "ti-database-off",
        "QuotaSnapshot.summary.storage.filesystems",
        storage.length
          ? `${storage.length} filesystem headroom entr${storage.length === 1 ? "y" : "ies"} available from saved quota/storage evidence.`
          : "No filesystem headroom evidence was captured in this snapshot.",
        { type: "quota", scopeKind: "snapshot" }
      )}
    </div>
  </div>`;
}
function capacityQueueCard(qc, cap) {
  return `<article class="capacity-queue-card">
    <div class="capacity-queue-card-head">
      <strong>${esc(qc.queue)}</strong>
      ${capacityBadge(capacityQueueState(qc, cap))}
    </div>
    <div class="capacity-queue-card-grid">
      <div><span>Running</span><strong>${esc(qc.running ?? "—")}</strong></div>
      <div><span>Queued</span><strong>${esc(qc.queued ?? "—")}</strong></div>
      <div><span>Run headroom</span><strong>${esc(qc.run_headroom ?? "—")}</strong></div>
      <div><span>Rec. parallel</span><strong>${esc(qc.recommended_parallel ?? "—")}</strong></div>
    </div>
    ${qc.note ? `<div class="capacity-queue-card-note">${esc(qc.note)}</div>` : ""}
  </article>`;
}
function capacityIntroEmpty() {
  return `<div class="card capacity-empty-state"><div class="card-body">${emptyState(
    "No capacity snapshot loaded",
    "Load a saved quota snapshot to inspect profile-scoped queue headroom, freshness, and storage evidence.",
    "not-captured-yet",
    `<a class="btn btn-primary" href="/runs"><i class="ti ti-list-details me-1"></i>Open Runs</a>
     <a class="btn btn-outline-secondary" href="/explore"><i class="ti ti-chart-dots me-1"></i>Open Explore</a>
     <button class="btn btn-outline-secondary" type="button" id="capacity-empty-refresh"><i class="ti ti-refresh me-1"></i>Refresh snapshots</button>`
  )}</div></div>`;
}
function wireCapacityIntroEmpty() {
  document.getElementById("capacity-empty-refresh")?.addEventListener("click", () => {
    announceStatus("Refreshing saved capacity snapshots.");
    renderQueue();
  });
}
function capacitySnapshotLabel(s) {
  const observed = s.observed_at ? `${fmtRel(s.observed_at)} · ` : "";
  const profile = s.profile_id || "unknown profile";
  const platform = s.platform || "platform";
  return `${profile} · ${platform} · ${observed}${s.snapshot_id}`;
}
function capacitySnapshotBrowser(index = {}) {
  const snapshots = index.snapshots || [];
  if (!snapshots.length) {
    return `<div class="capacity-snapshot-browser capacity-snapshot-browser-empty">
      <div class="section-kicker">Saved snapshots</div>
      <div class="text-secondary small">No local quota snapshots found yet. Run <code>quotas.refresh</code> for a profile, then load the captured snapshot here.</div>
    </div>`;
  }
  const latest = snapshots[0];
  const rows = snapshots.slice(0, 6).map((s) => {
    const active = s.snapshot_id === latest.snapshot_id ? " capacity-snapshot-row-latest" : "";
    const detail = s.platform === "uts-ihpc"
      ? `${s.available_family_count || 0} families · ${s.active_session_count ?? 0} sessions`
      : `${s.queue_count || 0} queues · ${s.storage_count || 0} storage`;
    const actionLabel = `Load ${s.profile_id} capacity snapshot ${s.snapshot_id}`;
    return `<button class="capacity-snapshot-row${active}" type="button" data-capacity-snapshot="${esc(s.snapshot_id)}" data-capacity-profile="${esc(s.profile_id)}" aria-label="${esc(actionLabel)}" title="${esc(actionLabel)}">
      <span>
        <strong>${esc(s.profile_id)}</strong>
        <span class="text-secondary">${esc(platformLabel(s.platform))} · ${esc(detail)}</span>
      </span>
      <span class="capacity-snapshot-meta">
        ${capacityBadge({ label: s.freshness || "unknown", color: s.freshness === "fresh" ? "green" : s.freshness === "stale" ? "yellow" : "secondary", icon: s.freshness === "fresh" ? "ti-circle-check" : "ti-clock" })}
        <code>${esc(s.snapshot_id)}</code>
        <span class="text-secondary">${esc(fmtRel(s.observed_at))}</span>
      </span>
    </button>`;
  }).join("");
  const options = snapshots
    .map((s) => `<option value="${esc(`${s.profile_id}|||${s.snapshot_id}`)}">${esc(capacitySnapshotLabel(s))}</option>`)
    .join("");
  return `<div class="capacity-snapshot-browser">
    <div class="capacity-snapshot-browser-head">
      <div><div class="section-kicker">Saved snapshots</div><div class="text-secondary small">${esc(index.total || snapshots.length)} local snapshots · profile-scoped, no live refresh</div></div>
      <button class="btn btn-sm btn-outline-primary" type="button" id="capacity-use-latest" data-capacity-profile="${esc(latest.profile_id)}" data-capacity-snapshot="${esc(latest.snapshot_id)}" aria-label="Load latest saved capacity snapshot" title="Load latest snapshot"><i class="ti ti-clock-check me-1"></i>Use latest</button>
    </div>
    <select id="capacity-snapshot-picker" class="form-select form-select-sm mt-2" aria-label="Choose saved quota snapshot">
      <option value="">Choose saved snapshot…</option>${options}
    </select>
    <div class="capacity-snapshot-list mt-2">${rows}</div>
  </div>`;
}
function capacityLoadPanel(saved = {}, snapshotIndex = {}, { collapsed = false } = {}) {
  const current = saved.profileId && saved.snapshotId
    ? `${saved.profileId} · ${saved.snapshotId}`
    : snapshotIndex.snapshots?.length
      ? "Choose or load a saved snapshot"
      : "No saved snapshot loaded";
  const snapshotPreview = saved.snapshotId || "none";
  return `<details class="card capacity-load-card mb-3" ${collapsed ? "" : "open"}>
    <summary class="capacity-load-summary" aria-label="Capacity snapshot controls">
      <span>
        <span class="section-kicker">Snapshot controls</span>
        <strong>${collapsed ? "Change capacity snapshot" : "Capacity evidence"}</strong>
        <span class="capacity-load-current">${esc(current)}</span>
      </span>
      <span class="capacity-load-summary-action"><i class="ti ti-adjustments"></i>${collapsed ? "Change" : "Hide controls"}</span>
    </summary>
    <div class="card-body">
    <div class="capacity-load-head">
      <div>
        <div class="section-kicker">Snapshot loader</div>
        <h3 class="m-0">Capacity evidence</h3>
      </div>
      <span class="badge bg-blue-lt"><i class="ti ti-database me-1"></i>local snapshot</span>
    </div>
    <form id="cap-form" class="capacity-load-form">
      <div>
        <label class="form-label" for="capacity-profile-id">Profile</label>
        <input id="capacity-profile-id" class="form-control" name="profileId" value="${esc(saved.profileId || "")}" placeholder="uts-hpc-account-a" autocomplete="off" required />
      </div>
      <div class="capacity-snapshot-field">
        <label class="form-label" for="capacity-snapshot-id">Quota snapshot</label>
        <textarea id="capacity-snapshot-id" class="form-control capacity-snapshot-id-input" name="snapshotId" rows="2" placeholder="quota-..." spellcheck="false" title="${esc(saved.snapshotId || "No snapshot selected")}" aria-describedby="capacity-snapshot-preview" required>${esc(saved.snapshotId || "")}</textarea>
        <div id="capacity-snapshot-preview" class="capacity-snapshot-preview" title="${esc(saved.snapshotId || "No snapshot selected")}" aria-live="polite">
          <span>Selected snapshot</span>
          <code>${esc(snapshotPreview)}</code>
        </div>
      </div>
      <div class="capacity-load-actions">
        <button class="btn btn-primary" type="submit" aria-label="Load selected capacity snapshot" title="Load selected snapshot"><i class="ti ti-search me-1"></i>Load capacity</button>
      </div>
    </form>
    ${capacitySnapshotBrowser(snapshotIndex)}
  </div></details>`;
}
function capacityErrorActions() {
  return `<button class="btn btn-danger" type="button" id="capacity-open-controls"><i class="ti ti-adjustments me-1"></i>Change snapshot</button>
    <button class="btn btn-outline-danger" type="button" id="capacity-clear-saved"><i class="ti ti-eraser me-1"></i>Clear saved selection</button>
    <a class="btn btn-outline-secondary" href="/runs"><i class="ti ti-list-details me-1"></i>Open Runs</a>`;
}
function wireCapacityErrorRecovery() {
  document.getElementById("capacity-open-controls")?.addEventListener("click", () => {
    const card = document.querySelector(".capacity-load-card");
    if (card) card.open = true;
    document.getElementById("capacity-snapshot-id")?.focus({ preventScroll: false });
    announceStatus("Capacity snapshot controls opened.");
  });
  document.getElementById("capacity-clear-saved")?.addEventListener("click", () => {
    localStorage.removeItem(CAPACITY_FORM_STORAGE_KEY);
    localStorage.removeItem(LEGACY_QUEUE_FORM_STORAGE_KEY);
    const form = document.getElementById("cap-form");
    if (form) {
      form.profileId.value = "";
      form.snapshotId.value = "";
    }
    const out = document.getElementById("cap-out");
    if (out) out.innerHTML = capacityIntroEmpty();
    wireCapacityIntroEmpty();
    setSafetyContext([{ label: "Snapshots", value: "selection cleared", icon: "ti-eraser", title: "The saved Capacity Snapshot selection was cleared locally." }]);
    announceStatus("Capacity Snapshot saved selection cleared.");
  });
}
function savedCapacityForm() {
  try {
    const raw = localStorage.getItem(CAPACITY_FORM_STORAGE_KEY) || localStorage.getItem(LEGACY_QUEUE_FORM_STORAGE_KEY) || "{}";
    const saved = JSON.parse(raw);
    if (!localStorage.getItem(CAPACITY_FORM_STORAGE_KEY) && localStorage.getItem(LEGACY_QUEUE_FORM_STORAGE_KEY)) {
      localStorage.setItem(CAPACITY_FORM_STORAGE_KEY, JSON.stringify(saved));
      localStorage.removeItem(LEGACY_QUEUE_FORM_STORAGE_KEY);
    }
    return saved && typeof saved === "object" ? saved : {};
  } catch {
    localStorage.removeItem(CAPACITY_FORM_STORAGE_KEY);
    localStorage.removeItem(LEGACY_QUEUE_FORM_STORAGE_KEY);
    announceStatus("Capacity Snapshot saved form was reset because it could not be read.");
    return {};
  }
}
async function renderQueue() {
  const saved = savedCapacityForm();
  const query = routeQuery();
  const requested = {
    profileId: query.get("profileId") || "",
    snapshotId: query.get("snapshotId") || ""
  };
  const snapshotIndex = await api("/api/capacity/snapshots?limit=50").catch((e) => ({
    total: 0,
    returned: 0,
    profiles: [],
    snapshots: [],
    error: e.message
  }));
  const latest = snapshotIndex.snapshots?.[0];
  const snapshotExists = (selected) => Boolean(
    selected.profileId &&
    selected.snapshotId &&
    snapshotIndex.snapshots?.some((s) => s.profile_id === selected.profileId && s.snapshot_id === selected.snapshotId)
  );
  const queryExists = snapshotExists(requested);
  const savedExists = snapshotExists(saved);
  const fallback = latest ? { profileId: latest.profile_id, snapshotId: latest.snapshot_id } : { profileId: "", snapshotId: "" };
  const initial = queryExists
    ? requested
    : latest
      ? fallback
      : savedExists
      ? saved
      : fallback;
  const initialChangedSaved = initial.profileId !== saved.profileId || initial.snapshotId !== saved.snapshotId;
  if (initial.profileId && initial.snapshotId && (initialChangedSaved || queryExists)) {
    localStorage.setItem(CAPACITY_FORM_STORAGE_KEY, JSON.stringify(initial));
    localStorage.removeItem(LEGACY_QUEUE_FORM_STORAGE_KEY);
  }
  if (saved.profileId && saved.snapshotId && !savedExists && latest) {
    announceStatus(`Capacity Snapshot saved selection was unavailable; using latest ${latest.snapshot_id}.`);
  } else if (!queryExists && savedExists && latest && initialChangedSaved) {
    announceStatus(`Capacity Snapshot refreshed to latest saved snapshot ${latest.snapshot_id}.`);
  } else if (saved.profileId && saved.snapshotId && !savedExists && !latest) {
    localStorage.removeItem(CAPACITY_FORM_STORAGE_KEY);
    localStorage.removeItem(LEGACY_QUEUE_FORM_STORAGE_KEY);
    announceStatus("Capacity Snapshot saved selection was cleared because no saved snapshots are available.");
  }
  setSafetyContext(latest ? [
    { label: "Snapshots", value: `${snapshotIndex.total || snapshotIndex.snapshots.length} saved`, icon: "ti-database", title: "Saved local quota snapshots available for profile-scoped capacity inspection." },
    { label: "Latest profile", value: latest.profile_id, icon: "ti-id", title: "Latest saved quota snapshot profile." },
    { label: "Latest platform", value: platformLabel(latest.platform), icon: "ti-server", title: "Latest saved quota snapshot platform." }
  ] : [
    { label: "Snapshots", value: "0 saved", icon: "ti-database-off", title: "No saved local quota snapshots were found." }
  ]);
  const hasInitialSnapshot = Boolean(initial.profileId && initial.snapshotId);
  view().innerHTML =
    header("Capacity Snapshot", "Profile-scoped headroom from a captured quota snapshot; this is not live worker monitoring.") +
    (hasInitialSnapshot
      ? `${capacityLoadPanel(initial, snapshotIndex, { collapsed: true })}<div id="cap-out"></div>`
      : `${capacityLoadPanel(initial, snapshotIndex)}<div id="cap-out"></div>`);
  const form = document.getElementById("cap-form");
  const syncCapacitySnapshotPreview = () => {
    const preview = document.getElementById("capacity-snapshot-preview");
    if (!preview) return;
    const snapshotId = form.snapshotId.value.trim();
    preview.title = snapshotId || "No snapshot selected";
    form.snapshotId.title = snapshotId || "No snapshot selected";
    const code = preview.querySelector("code");
    if (code) code.textContent = snapshotId || "none";
  };
  const setCapacityForm = (profileId, snapshotId, { load = false } = {}) => {
    form.profileId.value = profileId || "";
    form.snapshotId.value = snapshotId || "";
    syncCapacitySnapshotPreview();
    if (profileId && snapshotId) {
      localStorage.setItem(CAPACITY_FORM_STORAGE_KEY, JSON.stringify({ profileId, snapshotId }));
      if (load) loadCapacity(profileId, snapshotId);
    }
  };
  form.snapshotId.addEventListener("input", syncCapacitySnapshotPreview);
  syncCapacitySnapshotPreview();
  form.addEventListener("submit", (e) => {
    e.preventDefault();
    const profileId = form.profileId.value.trim();
    const snapshotId = form.snapshotId.value.trim();
    localStorage.setItem(CAPACITY_FORM_STORAGE_KEY, JSON.stringify({ profileId, snapshotId }));
    loadCapacity(profileId, snapshotId);
  });
  document.getElementById("capacity-snapshot-picker")?.addEventListener("change", (event) => {
    const [profileId, snapshotId] = String(event.target.value || "").split("|||");
    if (profileId && snapshotId) setCapacityForm(profileId, snapshotId, { load: true });
  });
  document.querySelectorAll("[data-capacity-snapshot]").forEach((button) => {
    button.addEventListener("click", () => setCapacityForm(button.dataset.capacityProfile, button.dataset.capacitySnapshot, { load: true }));
  });
  if (initial.profileId && initial.snapshotId) loadCapacity(initial.profileId, initial.snapshotId);
  else {
    document.getElementById("cap-out").innerHTML = capacityIntroEmpty();
    wireCapacityIntroEmpty();
  }
}
async function loadCapacity(profileId, snapshotId) {
  const out = document.getElementById("cap-out");
  setSafetyContext([
    { label: "Profile", value: profileId || "profile unknown", icon: "ti-id", title: "Capacity profile requested by the current snapshot loader." },
    { label: "Snapshot", value: snapshotId || "snapshot unknown", icon: "ti-database", title: "Quota snapshot requested by the current snapshot loader." }
  ]);
  out.innerHTML = `<div class="card"><div class="card-body text-secondary"><span class="spinner-border spinner-border-sm me-2"></span>Loading capacity snapshot…</div></div>`;
  try {
    const data = await api(`/api/capacity?profileId=${encodeURIComponent(profileId)}&snapshotId=${encodeURIComponent(snapshotId)}`);
    const cap = data.capacity;
    const fresh = capacityFreshness(cap);
    setSafetyContext([
      { label: "Profile", value: cap.profile_id || "profile unknown", icon: "ti-id", title: "Profile scope for the loaded capacity snapshot." },
      { label: "Snapshot", value: cap.snapshot_id || "snapshot unknown", icon: fresh.state === "fresh" ? "ti-database-check" : fresh.state === "stale" ? "ti-database-exclamation" : "ti-database-question", title: `Loaded quota snapshot freshness: ${fresh.label}.` },
      { label: "Platform", value: platformLabel(cap.platform), icon: "ti-server", title: "Platform scope for the loaded capacity snapshot." }
    ]);
    announceStatus(`Capacity snapshot ${snapshotId} loaded for ${profileId}.`);
    const meta = capacityMeta(cap);
    const evidence = capacityEvidenceChips(cap);
    const notes = (cap.notes || []).map((n) => `<div class="alert alert-info mt-2 mb-0">${esc(n)}</div>`).join("");
    if (cap.platform === "uts-ihpc") {
      const ihpc = cap.ihpc || {};
      out.innerHTML = meta + evidence +
        `<div class="row row-cards mb-3">
          ${statCard("Families", (ihpc.available_families || []).length, "ti-server-2", "green", "Available families")}
          ${statCard("Sessions", ihpc.active_sessions ?? 0, "ti-terminal-2", "blue", "Active sessions")}
          ${statCard("Starts", cap.recommended_parallel ?? "—", "ti-arrows-split", "azure", "Recommended starts")}
          ${statCard("Mounts", (cap.storage || []).length, "ti-database", "purple", "Storage mounts")}
        </div>
        <div class="row row-cards">
          <div class="col-12"><div class="card"><div class="card-header"><h3 class="card-title">iHPC node families</h3></div>
            <div class="card-body">
              <div class="section-kicker mb-2">available now</div>
              <div class="capacity-chip-row">${(ihpc.available_families || []).map((f) => `<span class="badge bg-green-lt">${esc(f)}</span>`).join("") || '<span class="text-secondary">No available families captured.</span>'}</div>
              <div class="section-kicker mt-3 mb-2">all observed families</div>
              <div class="capacity-chip-row">${(ihpc.all_families || []).map((f) => `<span class="badge bg-secondary-lt">${esc(f)}</span>`).join("") || '<span class="text-secondary">No family catalog captured.</span>'}</div>
            </div></div></div>
          <div class="col-12"><div class="card"><div class="card-header"><h3 class="card-title">Storage headroom</h3></div><div class="card-body storage-headroom-frame" ${tableScrollRegionAttrs("Storage headroom")}>${tableScrollHint("Storage headroom")}${storageCards(cap.storage)}</div></div></div>
        </div>${notes}`;
      wireEvidenceChips();
      observeTableScrollHints();
      return;
    }
    const queues = cap.queues || [];
    const stats = `<div class="row row-cards mb-3">
      ${statCard("Best queue", cap.best_queue || "—", "ti-stack-2", "azure")}
      ${statCard("Parallel", cap.recommended_parallel ?? "—", "ti-arrows-split", "green", "Recommended parallel")}
      ${statCard("Age (min)", cap.age_minutes ?? "—", "ti-clock", "orange", "Snapshot age in minutes")}
      ${statCard("Queues", queues.length, "ti-list", "purple")}
    </div>`;
    const rows = queues
      .map(
        (qc) => `<tr><td class="fw-bold">${esc(qc.queue)}</td><td>${capacityBadge(capacityQueueState(qc, cap))}</td>
        <td>${qc.running}</td><td>${qc.queued}</td><td>${qc.run_headroom ?? "—"}</td><td>${qc.queued_headroom ?? "—"}</td><td>${qc.recommended_parallel ?? "—"}</td>
        <td class="capacity-queue-note text-secondary small">${esc(qc.note || "")}</td></tr>`
      )
      .join("");
    const queueCards = queues.length
      ? `<div class="capacity-queue-card-list" aria-label="Queue headroom mobile cards">${queues.map((qc) => capacityQueueCard(qc, cap)).join("")}</div>`
      : "";
    out.innerHTML = meta + evidence + stats +
      `<div class="row row-cards">
        <div class="col-12"><div class="card"><div class="card-header"><h3 class="card-title">PBS queue headroom</h3></div>
          ${queueCards}<div class="table-responsive capacity-queue-frame" ${tableScrollRegionAttrs("Queue table")}>${tableScrollHint("Queue table")}<table class="table table-vcenter card-table capacity-queue-table">
          <thead><tr><th>Queue</th><th>State</th><th>Running</th><th>Queued</th><th>Run headroom</th><th>Queued headroom</th><th>Rec. parallel</th><th>Note</th></tr></thead>
          <tbody>${rows || `<tr><td colspan="8" class="p-3">${emptyState("No queues captured", "Refresh quotas to capture PBS queue limits and per-account counts.", "not-captured-yet")}</td></tr>`}</tbody></table></div></div></div>
        <div class="col-12"><div class="card"><div class="card-header"><h3 class="card-title">Storage headroom</h3></div><div class="card-body storage-headroom-frame" ${tableScrollRegionAttrs("Storage headroom")}>${tableScrollHint("Storage headroom")}${storageCards(cap.storage)}</div></div></div>
      </div>${notes}`;
    wireEvidenceChips();
    observeTableScrollHints();
  } catch (e) {
    announceStatus(`Capacity Snapshot failed to load: ${e.message}`);
    out.innerHTML = errorState(e.message, "api-error", "Capacity Snapshot", capacityErrorActions());
    wireCapacityErrorRecovery();
  }
}

// ---------- Projects ----------
// ---------- Node load (L1: live iHPC per-node GPU utilization) ----------
// L2: the per-run node-hardware panel — joins the node-load snapshot to one observed iHPC run by node,
// and flags a held-but-idle node (alive run on a node whose GPUs read <=5%). Node-level only: it cannot
// isolate co-located experiments — true per-process attribution is a planned backend addition.
function nodeHardwarePanel(run, nodeUsage) {
  if (!(run.platform === "uts-ihpc" && runIsAdopted(run))) return "";
  const node = run.observed?.node || run.submission?.node || "";
  if (!node) return "";
  const kicker = `<div class="section-kicker">Node hardware (live GPU)</div>`;
  if (!nodeUsage || !nodeUsage.available) {
    return `<div class="node-hw-panel mb-3">${kicker}<div class="text-secondary small">No node-load probe yet for <code>${esc(node)}</code>. <a href="/node-load">Open Node load</a> to probe its GPUs.</div></div>`;
  }
  const entry = (nodeUsage.nodes || []).find((n) => n.node === node);
  if (!entry) {
    return `<div class="node-hw-panel mb-3">${kicker}<div class="text-secondary small">The latest node-load snapshot does not include <code>${esc(node)}</code>. <a href="/node-load">Refresh Node load</a>.</div></div>`;
  }
  if (entry.status !== "ok" || !entry.gpus?.length) {
    return `<div class="node-hw-panel mb-3">${kicker}<div class="node-unverifiable-note"><i class="ti ti-alert-triangle me-1"></i>node <code>${esc(node)}</code> unreadable — ${esc(entry.reason || "could not be probed")}</div></div>`;
  }
  const maxUtil = Math.max(0, ...entry.gpus.map((g) => g.utilization_gpu_percent));
  const idle = entry.gpus.every((g) => g.utilization_gpu_percent <= 5);
  const alive = run.liveness === "alive" || isActiveStatus(run.status);
  const verdict = idle && alive
    ? `<div class="node-balance-idle"><i class="ti ti-bolt-off me-1"></i>Node <code>${esc(node)}</code>'s GPUs are idle (≤5%) overall.</div>`
    : `<div class="text-secondary small"><i class="ti ti-flame me-1"></i>Node GPUs are active (busiest ${esc(maxUtil)}%).</div>`;
  // L2 per-PID: attribute GPU memory to THIS run by its observed pid. A definitive per-process signal —
  // sharper than the node-level idle guess when several experiments share the node.
  const pid = run.observed?.pid;
  const proc = typeof pid === "number" ? (entry.processes || []).find((p) => p.pid === pid) : undefined;
  const procLine = typeof pid !== "number"
    ? ""
    : proc
      ? `<div class="mt-1"><i class="ti ti-cpu me-1"></i>This run (pid ${esc(pid)}) holds <strong>${esc(Math.round(proc.used_memory_mb))} MB</strong> of GPU memory on <code>${esc(node)}</code>.</div>`
      : alive
        ? `<div class="node-balance-idle mt-1"><i class="ti ti-bolt-off me-1"></i>This run (pid ${esc(pid)}) holds <strong>no</strong> GPU memory on <code>${esc(node)}</code> — it may not be using the GPU it occupies.</div>`
        : `<div class="text-secondary small mt-1"><i class="ti ti-info-circle me-1"></i>This run (pid ${esc(pid)}) has no live GPU process on <code>${esc(node)}</code>.</div>`;
  return `<div class="node-hw-panel mb-3">${kicker}
    ${verdict}
    ${procLine}
    ${entry.gpus.map(gpuBar).join("")}
    <div class="text-secondary small mt-1"><i class="ti ti-info-circle me-1"></i>Per-process attribution is by GPU memory; utilization is node-level (other experiments may share <code>${esc(node)}</code>).</div>
  </div>`;
}
function gpuBar(g) {
  const util = Math.max(0, Math.min(100, Number(g.utilization_gpu_percent) || 0));
  const cls = util >= 70 ? "gpu-hot" : util <= 5 ? "gpu-idle" : "";
  return `<div class="node-gpu">
    <div class="node-gpu-head"><span>GPU ${esc(g.index)} · ${esc(g.name)}</span><strong>${esc(util)}%</strong></div>
    <div class="gpu-bar"><div class="gpu-bar-fill ${cls}" style="width:${util}%"></div></div>
    <div class="node-gpu-mem">${esc(Math.round(g.memory_used_mb))} / ${esc(Math.round(g.memory_total_mb))} MB</div>
  </div>`;
}
function nodeCard(n, idleSet) {
  const idle = idleSet.has(n.node);
  const cls = n.status === "node-unverifiable" ? "node-unverifiable" : idle ? "node-idle" : "";
  const body = n.status === "ok" && n.gpus?.length
    ? n.gpus.map(gpuBar).join("")
    : `<div class="node-unverifiable-note"><i class="ti ti-alert-triangle me-1"></i>unreadable — ${esc(n.reason || "node could not be probed")}</div>`;
  return `<div class="node-card ${cls}">
    <div class="node-card-head"><strong>${esc(n.node)}</strong><span class="profile">${esc(n.profile_id)}</span></div>
    ${idle ? `<div class="node-unverifiable-note"><i class="ti ti-bolt-off me-1"></i>held but idle (all GPUs ≤5%)</div>` : ""}
    ${body}
  </div>`;
}
function nodeLoadBody(data) {
  const refreshBtn = `<button id="node-load-refresh" class="btn btn-primary"><i class="ti ti-refresh me-1"></i>Refresh (live probe)</button>`;
  if (!data.available) {
    return emptyState(
      "No node-load snapshot yet",
      "Probe the GPU utilization of the nodes your active iHPC runs occupy. This runs a live, read-only nvidia-smi probe over SSH.",
      "not-captured-yet",
      refreshBtn
    );
  }
  const b = data.balance || {};
  const idleSet = new Set(b.idle_nodes || []);
  const fresh = data.probed_at ? `probed ${fmtRel(data.probed_at)}${data.age_minutes != null ? ` · ${data.age_minutes} min ago` : ""}` : "";
  const balance = `<div class="node-balance">
    <span><i class="ti ti-server me-1"></i>${esc(b.node_count ?? 0)} node${b.node_count === 1 ? "" : "s"}</span>
    ${b.max_util != null ? `<span><i class="ti ti-flame me-1"></i>busiest ${esc(b.max_util)}%</span>` : ""}
    ${b.util_spread != null ? `<span><i class="ti ti-arrows-horizontal me-1"></i>spread ${esc(b.util_spread)} pts</span>` : ""}
    ${idleSet.size ? `<span class="node-balance-idle"><i class="ti ti-bolt-off me-1"></i>${idleSet.size} held but idle: ${esc([...idleSet].join(", "))}</span>` : ""}
    ${b.unverifiable_count ? `<span class="text-secondary"><i class="ti ti-alert-triangle me-1"></i>${esc(b.unverifiable_count)} unreadable</span>` : ""}
    ${fresh ? `<span class="text-secondary">${esc(fresh)}</span>` : ""}
  </div>`;
  const grid = (data.nodes || []).length
    ? `<div class="node-load-grid">${data.nodes.map((n) => nodeCard(n, idleSet)).join("")}</div>`
    : emptyState("No active iHPC nodes", "No active iHPC run is currently holding a node to probe.", "history-empty");
  return `<div class="d-flex justify-content-between align-items-center mb-3 flex-wrap gap-2"><div class="text-secondary small">Live GPU utilization for the nodes your active iHPC runs occupy — see whether load is balanced and whether a node is held but idle.</div>${refreshBtn}</div>${balance}${grid}`;
}
// Node load is rendered as a section of the Runs view (see renderRunsList), so the refresh button
// re-renders whatever view embeds it. `reRender` is the embedding view's render function.
function wireNodeLoadRefresh(reRender) {
  const btn = document.getElementById("node-load-refresh");
  if (!btn) return;
  btn.addEventListener("click", async () => {
    btn.disabled = true;
    btn.innerHTML = `<span class="spinner-border spinner-border-sm me-1" role="status"></span>Probing nodes…`;
    try {
      await post("/api/ihpc/node-usage/refresh", {});
      await reRender();
    } catch (e) {
      announceError("Node load", e.message);
      btn.disabled = false;
      btn.innerHTML = `<i class="ti ti-refresh me-1"></i>Retry`;
    }
  });
}
async function renderProjects() {
  const data = await api("/api/projects");
  const projects = [...(data.projects || [])].sort(projectSort);
  setSafetyContext([
    { label: "Projects", value: `${projects.length} groups`, icon: "ti-folders", title: "Local git-derived project groups in the current project index." },
    { label: "Runs", value: `${data.total_runs || 0} runs`, icon: "ti-list-details", title: "Runs represented in the current project rollup." },
    { label: "Profiles", value: scopeValue(projects.flatMap((project) => project.profiles || []), "profiles"), icon: "ti-id", title: "Profile scope represented by the project index." }
  ]);
  view().innerHTML =
    header("Projects", `${data.total_projects} projects · ${data.total_runs} runs`) +
    (projects.length
      ? projectIndex(projects, data)
      : `<div class="card project-empty-state"><div class="card-body">${projectsEmptyState()}</div></div>`);
  document.getElementById("projects-empty-refresh")?.addEventListener("click", () => {
    announceStatus("Refreshing local project index.");
    renderProjects();
  });
}
function projectIndex(projects, data = {}) {
  const summary = projectIndexSummary(projects, data);
  const mobileCards = `<div class="project-mobile-card-list" aria-label="Project mobile cards">${projects.map(projectMobileCard).join("")}</div>`;
  return `<div class="project-index">
    ${summary}
    <div class="card project-index-card">
      ${mobileCards}
      <div class="table-responsive project-index-frame" ${tableScrollRegionAttrs("Projects table")}>
        ${tableScrollHint("Projects table")}
        <table class="table table-vcenter card-table project-index-table">
          <colgroup>
            <col class="project-index-col-project">
            <col class="project-index-col-health">
            <col class="project-index-col-runs">
            <col class="project-index-col-mix">
            <col class="project-index-col-actions">
            <col class="project-index-col-scope">
            <col class="project-index-col-latest">
          </colgroup>
          <thead><tr>
            <th>Project</th>
            <th>Health</th>
            <th>Runs</th>
            <th>Status mix</th>
            <th>Open in Explore</th>
            <th>Scope</th>
            <th>Latest</th>
          </tr></thead>
          <tbody>${projects.map(projectIndexRow).join("")}</tbody>
        </table>
      </div>
    </div>
  </div>`;
}
function projectMobileCard(p) {
  const health = projectHealth(p);
  const exploreHref = projectExploreHref(p.project);
  const lastUpdated = p.last_updated
    ? `<span title="${esc(fmtTime(p.last_updated))}">${esc(fmtRel(p.last_updated))}</span>`
    : `<span class="text-secondary">not recorded</span>`;
  const platforms = p.platforms?.length
    ? p.platforms.map((platform) => platformBadge(platform)).join("")
    : `<span class="text-secondary">platform missing</span>`;
  const profiles = (p.profiles || []).length;
  return `<article class="project-mobile-card" data-project-health="${esc(health.state)}">
    <div class="project-mobile-card-head">
      <a href="${exploreHref}" class="project-mobile-title" title="${esc(p.project)}">${esc(p.project)}</a>
      <span class="project-health-chip" data-health="${esc(health.state)}">${esc(health.label)}</span>
    </div>
    <div class="project-mobile-hash"><code>${esc(p.project_hash || "project hash missing")}</code></div>
    <div class="project-mobile-meta">
      <span><strong>${esc(p.total || 0)}</strong> runs</span>
      <span>${lastUpdated}</span>
    </div>
    <div class="project-mobile-status">${projectStatusSummary(p)}</div>
    <div class="project-mobile-scope">
      <div>${platforms}</div>
      <span class="text-secondary small">${esc(profiles)} profile${profiles === 1 ? "" : "s"}</span>
    </div>
  </article>`;
}
function projectIndexSummary(projects, data = {}) {
  const review = projects.filter((p) => projectHealth(p).state === "failed").length;
  const active = projects.filter((p) => projectHealth(p).state === "active").length;
  const evidenceGap = projects.filter((p) => projectHealth(p).state === "unknown").length;
  const totalRuns = data.total_runs ?? projects.reduce((sum, p) => sum + Number(p.total || 0), 0);
  return `<div class="project-index-summary mb-3" aria-label="Project index summary">
    ${projectSummaryMetric("Projects", projects.length, "ti-folders", "All local project groups", "", "Local groups", "inventory")}
    ${projectSummaryMetric("Needs review", review, "ti-alert-circle", "Projects with failed runs", review ? "failed" : "", "Failed runs", "review")}
    ${projectSummaryMetric("Active", active, "ti-player-play", "Projects with active runs", active ? "active" : "", "Active runs", "active")}
    ${projectSummaryMetric("Evidence gaps", evidenceGap, "ti-database-off", "Projects with unknown status evidence", evidenceGap ? "unknown" : "", "Unknown status", "evidence")}
    ${projectSummaryMetric("Runs", totalRuns, "ti-list-details", "Runs represented in this project index", "", "Indexed runs", "volume")}
  </div>`;
}
function projectSummaryMetric(label, value, icon, detail, state = "", shortDetail = detail, tone = "inventory") {
  const title = `${label}: ${value}. ${detail}`;
  return `<div class="project-index-metric" title="${esc(title)}" aria-label="${esc(title)}" data-project-tone="${esc(tone)}" ${state ? `data-project-state="${esc(state)}"` : ""}>
    <span class="project-index-metric-icon"><i class="ti ${esc(icon)}"></i></span>
    <span class="project-index-metric-value">${esc(value)}</span>
    <span class="project-index-metric-label">${esc(label)}</span>
    <span class="project-index-metric-detail">${esc(shortDetail)}</span>
  </div>`;
}
function projectIndexRow(p) {
  const health = projectHealth(p);
  const exploreHref = projectExploreHref(p.project);
  const lastUpdated = p.last_updated
    ? `<span title="${esc(fmtTime(p.last_updated))}">${esc(fmtRel(p.last_updated))}</span>`
    : `<span class="text-secondary">not recorded</span>`;
  const platforms = p.platforms?.length
    ? p.platforms.map((platform) => platformBadge(platform)).join("")
    : `<span class="text-secondary">platform missing</span>`;
  const profiles = (p.profiles || []).length;
  return `<tr class="project-index-row" data-project-health="${esc(health.state)}">
    <td class="project-index-project">
      <a href="${exploreHref}" class="project-index-title">${esc(p.project)}</a>
      <div class="project-index-hash"><code>${esc(p.project_hash || "project hash missing")}</code></div>
    </td>
    <td class="project-index-health">
      <span class="project-health-chip" data-health="${esc(health.state)}">${esc(health.label)}</span>
      <span class="project-index-health-detail">${esc(health.detail)}</span>
    </td>
    <td class="project-index-total"><strong>${esc(p.total || 0)}</strong><span>runs</span></td>
    <td class="project-index-composition">${projectStatusComposition(p)}</td>
    <td class="project-index-statuses">${projectStatusSummary(p)}</td>
    <td class="project-index-scope">
      <div class="project-index-platforms">${platforms}</div>
      <div class="text-secondary small">${esc(profiles)} profile${profiles === 1 ? "" : "s"}</div>
    </td>
    <td class="project-index-updated">${lastUpdated}</td>
  </tr>`;
}
// Drill into a project's runs on Explore, which has a filterable run table that honors the
// project/status query params (the consolidated Runs route is a dashboard and does not filter).
// "active" is an aggregate (running+submitting+submitted+unknown) with no single Explore status,
// so it falls back to the whole-project view; concrete statuses (failed/planned/finished) map through.
function projectExploreHref(project, status = "") {
  const params = new URLSearchParams();
  if (status && status !== "active") params.set("status", status);
  params.set("project", project);
  return `/explore?${params.toString()}`;
}
function projectStatusSummary(p) {
  const failed = projectStatusCount(p, "failed");
  const active = projectActiveCount(p);
  const planned = projectStatusCount(p, "planned");
  const finished = projectStatusCount(p, "finished");
  const state = failed ? "failed" : active ? "active" : "quiet";
  return `<div class="project-status-summary mt-3" data-project-state="${esc(state)}" aria-label="Project run state summary">
    ${projectStatusLink(p.project, "failed", failed, "failed", "ti-alert-circle")}
    ${projectStatusLink(p.project, "active", active, "active", "ti-player-play")}
    ${projectStatusLink(p.project, "planned", planned, "planned", "ti-calendar-time")}
    ${projectStatusLink(p.project, "finished", finished, "finished", "ti-circle-check")}
  </div>`;
}
function projectStatusLink(project, view, count, label, icon) {
  const text = `${count} ${label}`;
  const title = count ? `Open ${text} run${count === 1 ? "" : "s"} in Explore` : `No ${label} runs`;
  const content = `<i class="ti ${esc(icon)}"></i><span>${esc(text)}</span>`;
  if (!count) {
    return `<span class="project-status-pill" data-status="${esc(view)}" title="${esc(title)}">${content}</span>`;
  }
  return `<a class="project-status-pill" data-status="${esc(view)}" href="${projectExploreHref(project, view)}" title="${esc(title)}">${content}</a>`;
}
function projectStatusCount(p, status) {
  return Number(p.by_status?.[status] || 0);
}
function projectActiveCount(p) {
  return ["running", "submitting", "submitted", "unknown"].reduce((sum, status) => sum + projectStatusCount(p, status), 0);
}
function projectOrderedStatusCounts(p) {
  const known = new Set(PROJECT_STATUS_ORDER);
  const byStatus = p.by_status || {};
  const extraStatuses = Object.keys(byStatus).filter((status) => !known.has(status)).sort();
  return [...PROJECT_STATUS_ORDER, ...extraStatuses].map((status) => ({
    status,
    label: PROJECT_STATUS_LABELS[status] || status,
    count: Number(byStatus[status] || 0)
  }));
}
function projectHealth(p) {
  const failed = projectStatusCount(p, "failed");
  const unknown = projectStatusCount(p, "unknown");
  const active = projectActiveCount(p);
  const planned = projectStatusCount(p, "planned");
  if (failed) return { state: "failed", label: "Needs review", detail: `${failed} failed run${failed === 1 ? "" : "s"}` };
  if (unknown) return { state: "unknown", label: "Evidence gap", detail: `${unknown} run${unknown === 1 ? "" : "s"} need status evidence` };
  if (active) return { state: "active", label: "In progress", detail: `${active} active run${active === 1 ? "" : "s"}` };
  if (planned) return { state: "planned", label: "Planned", detail: `${planned} planned run${planned === 1 ? "" : "s"}` };
  return { state: "quiet", label: "Quiet", detail: `${p.total || 0} total run${p.total === 1 ? "" : "s"}` };
}
function projectSort(a, b) {
  const rankA = projectHealthRank(a);
  const rankB = projectHealthRank(b);
  if (rankA !== rankB) return rankA - rankB;
  const updatedA = Date.parse(a.last_updated || "") || 0;
  const updatedB = Date.parse(b.last_updated || "") || 0;
  if (updatedA !== updatedB) return updatedB - updatedA;
  return String(a.project || "").localeCompare(String(b.project || ""));
}
function projectHealthRank(p) {
  if (projectStatusCount(p, "failed")) return 0;
  if (projectStatusCount(p, "unknown")) return 1;
  if (projectActiveCount(p)) return 2;
  if (projectStatusCount(p, "planned")) return 3;
  if (projectStatusCount(p, "cancelled")) return 4;
  return 5;
}
function projectStatusComposition(p) {
  const total = Math.max(Number(p.total || 0), 0);
  const entries = projectOrderedStatusCounts(p).filter((entry) => entry.count > 0);
  if (!total || !entries.length) {
    return `<div class="project-status-composition project-status-composition-empty mt-3" role="img" aria-label="No run status evidence yet"></div>`;
  }
  const label = entries.map((entry) => `${entry.count} ${entry.label}`).join(", ");
  return `<div class="project-status-composition mt-3" role="img" aria-label="Project status composition: ${esc(label)}">
    ${entries.map((entry) => {
      const width = Math.max(4, Math.round((entry.count / total) * 100));
      const title = `${entry.count} ${entry.label} run${entry.count === 1 ? "" : "s"}`;
      return `<span class="project-status-segment" data-status="${esc(entry.status)}" style="width:${esc(width)}%" title="${esc(title)}"></span>`;
    }).join("")}
  </div>`;
}
