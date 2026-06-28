// uts-compute experiment-tracking dashboard — a tiny, read-mostly, localhost-only HTTP server.
//
// It serves the static Tabler frontend (webui/public/) and a small JSON API that wraps the SAME built
// domain functions the MCP server uses (mcp-server/dist/*), reading the already-redacted .uts-computing/
// JSON. Write actions (clone / rerun / abort / approve) route through the EXACT same gates as the MCP
// tools — the dashboard is just another caller, never a bypass; the Tier-B confirmation token stays
// server-side (env), never in the browser. See docs/dashboard-design.md.

import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { jobsHistory } from "../mcp-server/dist/ops/jobs/history.js";
import { listProjects } from "../mcp-server/dist/ops/profiles/projects.js";
import { readRunRecordSafe } from "../mcp-server/dist/core/audit.js";
import { listProfiles } from "../mcp-server/dist/core/config.js";
import { quotaCapacity } from "../mcp-server/dist/ops/quotas/capacity.js";
import { planRetryJob } from "../mcp-server/dist/ops/jobs/retry.js";
import { submitJob } from "../mcp-server/dist/ops/jobs/submit.js";
import { cancelJob, trackActiveJobs } from "../mcp-server/dist/ops/jobs/jobs.js";
import { requestApproval, decideApproval, approvalStatus } from "../mcp-server/dist/ops/approvals/approvals.js";
import { SAFE_RUN_ID_PATTERN } from "../mcp-server/dist/core/ids.js";
import { assertQuotaSnapshot } from "../mcp-server/dist/core/validation.js";
import { round2 } from "../mcp-server/dist/lib/shared.js";
import { runtimeRootDir } from "../mcp-server/dist/core/paths.js";
import { runIhpcNodeUsage } from "../mcp-server/dist/ops/jobs/ihpc-node-usage.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PUBLIC_DIR = path.join(__dirname, "public");
// Run-id path guard for /api/runs/:id and /api/runs/:id/logs — the SAME grammar the MCP server
// enforces, imported from dist (ids.ts) so this safety gate can't drift from the canonical rule.

const STATIC_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8"
};

// Build the dashboard server. Not yet listening — call .listen(). `options` lets tests point the
// runtime dirs at a temp tree; defaults match the MCP server's .uts-computing/ layout.
export function createWebuiServer(options = {}) {
  // Default to the SAME runtime root the MCP server writes to (~/.local/state/.uts-computing by
  // default, honoring UTS_COMPUTING_HOME). A CWD-relative ".uts-computing" used to make the dashboard
  // read an empty tree (total_runs:0) against real data — see Task W1.
  const runtimeDir = options.runtimeDir ?? runtimeRootDir();
  const cfg = {
    auditDir: options.auditDir ?? path.join(runtimeDir, "runs"),
    planDir: options.planDir ?? path.join(runtimeDir, "plans"),
    approvalDir: options.approvalDir ?? path.join(runtimeDir, "approvals"),
    artifactsDir: options.artifactsDir ?? path.join(runtimeDir, "artifacts"),
    evidenceDir: options.evidenceDir ?? path.join(runtimeDir, "job-ops"),
    quotaDir: options.quotaDir ?? path.join(runtimeDir, "quotas"),
    configPath: options.configPath,
    // Tier-B confirmation token for approvals.decide — server-side only, never sent to the browser.
    approvalToken: options.approvalToken ?? process.env.UTS_COMPUTING_APPROVAL_TOKEN,
    // L1 iHPC node-load: where node-usage snapshots are persisted, and an injectable probe executor
    // (tests inject a crafted-JSON stub; production uses the probe's default runProcess SSH executor).
    nodeUsageDir: options.nodeUsageDir ?? path.join(runtimeDir, "node-usage"),
    nodeUsageExecutor: options.nodeUsageExecutor,
    // Live status reconcile (jobs.track) — injectable executor so the refresh endpoint is unit-testable.
    jobTrackExecutor: options.jobTrackExecutor
  };

  return http.createServer(async (req, res) => {
    try {
      await route(req, res, cfg);
    } catch (error) {
      sendJson(res, 500, { ok: false, error: errMessage(error) });
    }
  });
}

async function route(req, res, cfg) {
  const url = new URL(req.url, "http://127.0.0.1");
  const { pathname } = url;
  const q = url.searchParams;

  // ---- read API (GET) ----
  if (req.method === "GET" && pathname === "/api/runs") {
    return ok(res, historyWithWebuiFields(q, cfg));
  }
  if (req.method === "GET" && pathname === "/api/explore") {
    return ok(res, exploreRuns(q, cfg));
  }
  if (req.method === "GET" && pathname === "/api/summary") {
    return ok(res, summarize(cfg));
  }
  const runMatch = pathname.match(/^\/api\/runs\/([^/]+)$/);
  if (req.method === "GET" && runMatch) {
    return ok(res, runDetail(decodeURIComponent(runMatch[1]), cfg));
  }
  const logsMatch = pathname.match(/^\/api\/runs\/([^/]+)\/logs$/);
  if (req.method === "GET" && logsMatch) {
    return ok(res, savedLogs(decodeURIComponent(logsMatch[1]), cfg));
  }
  if (req.method === "GET" && pathname === "/api/projects") {
    return ok(res, listProjects({ auditDir: cfg.auditDir }));
  }
  if (req.method === "GET" && pathname === "/api/capacity/snapshots") {
    return ok(res, listCapacitySnapshots(q, cfg));
  }
  if (req.method === "GET" && pathname === "/api/capacity") {
    const profileId = q.get("profileId");
    const snapshotId = q.get("snapshotId");
    if (!profileId || !snapshotId) {
      return sendJson(res, 400, { ok: false, error: "capacity requires profileId and snapshotId" });
    }
    return ok(res, quotaCapacity({ profileId, snapshotId }, { configPath: cfg.configPath }));
  }
  if (req.method === "GET" && pathname === "/api/ihpc/node-usage") {
    return ok(res, readNodeUsageSnapshot(cfg));
  }

  // ---- write API (POST) — same gates as the MCP tools ----
  if (req.method === "POST" && pathname.startsWith("/api/")) {
    if (!isSameOriginJson(req)) {
      return sendJson(res, 403, { ok: false, error: "write actions require a same-origin application/json request" });
    }
    const body = await readJsonBody(req);
    if (pathname === "/api/actions/clone") {
      return ok(res, planRetryJob(
        {
          sourceRunId: body.sourceRunId,
          retryRunId: body.retryRunId,
          reason: body.reason,
          escalate: body.escalate,
          resume: body.resume
        },
        { planDir: cfg.planDir, auditDir: cfg.auditDir, configPath: cfg.configPath }
      ));
    }
    if (pathname === "/api/actions/submit") {
      return ok(res, await submitJob(
        { runId: body.runId, approvalId: body.approvalId, quotaSnapshotId: body.snapshotId },
        { planDir: cfg.planDir, auditDir: cfg.auditDir, approvalDir: cfg.approvalDir, configPath: cfg.configPath }
      ));
    }
    if (pathname === "/api/actions/abort") {
      return ok(res, await cancelJob(
        { runId: body.runId, approvalId: body.approvalId },
        { auditDir: cfg.auditDir, approvalDir: cfg.approvalDir, configPath: cfg.configPath }
      ));
    }
    if (pathname === "/api/approvals/request") {
      return ok(res, requestApproval(
        {
          runId: body.runId,
          profileId: body.profileId,
          platform: body.platform,
          operation: body.operation,
          planHash: body.planHash,
          quotaSnapshotId: body.quotaSnapshotId,
          reasons: body.reasons,
          commandSummary: body.commandSummary
        },
        { approvalDir: cfg.approvalDir }
      ));
    }
    if (pathname === "/api/approvals/decide") {
      // The confirmation token is supplied by the SERVER (env), never by the browser.
      return ok(res, decideApproval(
        {
          approvalId: body.approvalId,
          decision: body.decision,
          planHash: body.planHash,
          quotaSnapshotId: body.quotaSnapshotId,
          confirmationToken: cfg.approvalToken
        },
        { approvalDir: cfg.approvalDir, confirmationToken: cfg.approvalToken }
      ));
    }
    if (pathname === "/api/runs/refresh") {
      // Live status reconcile: re-poll every active run over SSH (qstat for PBS → usage; liveness for
      // iHPC), persisting fresh usage/status onto the records — the same read-only sweep as jobs.track.
      // The dashboard then re-reads to show the refreshed usage, instead of stale "—".
      const { tracking } = await trackActiveJobs(
        {},
        { auditDir: cfg.auditDir, configPath: cfg.configPath, executor: cfg.jobTrackExecutor }
      );
      return ok(res, tracking);
    }
    if (pathname === "/api/ihpc/node-usage/refresh") {
      return ok(res, await refreshNodeUsage(cfg));
    }
    return sendJson(res, 404, { ok: false, error: `no such action: ${pathname}` });
  }

  if (pathname.startsWith("/api/")) {
    return sendJson(res, 404, { ok: false, error: `no such endpoint: ${pathname}` });
  }

  // ---- static frontend ----
  if (req.method === "GET") {
    return serveStatic(pathname, res);
  }
  return sendJson(res, 405, { ok: false, error: "method not allowed" });
}

// ---- read helpers (all over already-redacted local JSON) ----

const TERMINAL_STATUSES = new Set(["finished", "failed", "cancelled", "canceled", "stale"]);

// L1 iHPC node load. The set of {profileId, node} an ACTIVE iHPC run currently occupies (deduped). Node
// comes from the P2-a observed block or submission; terminal runs are skipped (we only probe live work).
function relevantIhpcNodes(cfg) {
  const seen = new Set();
  const out = [];
  let files;
  try { files = fs.readdirSync(cfg.auditDir); } catch { return out; }
  for (const file of files) {
    if (!file.endsWith(".json")) continue;
    let record;
    try { record = JSON.parse(fs.readFileSync(path.join(cfg.auditDir, file), "utf8")); } catch { continue; }
    if (record?.platform !== "uts-ihpc" || TERMINAL_STATUSES.has(record.status)) continue;
    const node = record.observed?.node || record.submission?.node;
    const profileId = record.profile_id;
    if (!node || !profileId) continue;
    const key = `${profileId}\t${node}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ profileId, node });
  }
  return out;
}

// Probe every relevant node via the committed ihpc.node.usage probe (fail-closed) and persist a node-load
// snapshot. Live SSH — invoked only on the explicit refresh action, never on a GET render.
async function refreshNodeUsage(cfg) {
  const targets = relevantIhpcNodes(cfg);
  const nodes = [];
  for (const { profileId, node } of targets) {
    const { usage } = await runIhpcNodeUsage(
      { profileId, node },
      { configPath: cfg.configPath, executor: cfg.nodeUsageExecutor }
    );
    nodes.push({ profile_id: profileId, node: usage.node, status: usage.status, gpus: usage.gpus, processes: usage.processes ?? [], reason: usage.reason ?? null });
  }
  const snapshot = { probed_at: new Date().toISOString(), node_count: nodes.length, nodes };
  fs.mkdirSync(cfg.nodeUsageDir, { recursive: true });
  fs.writeFileSync(path.join(cfg.nodeUsageDir, "latest.json"), `${JSON.stringify(snapshot, null, 2)}\n`, "utf8");
  return decorateNodeUsage(snapshot);
}

function readNodeUsageSnapshot(cfg) {
  let snapshot;
  try { snapshot = JSON.parse(fs.readFileSync(path.join(cfg.nodeUsageDir, "latest.json"), "utf8")); }
  catch { return { available: false, nodes: [], balance: null }; }
  return decorateNodeUsage(snapshot);
}

// Freshness + a balance summary. Per-node utilization is the busiest GPU on the node; a node whose GPUs
// are all near-idle is flagged (the "holding a GPU but wasting it" signal). node-unverifiable nodes are
// reported separately, never counted as 0% (an honest "we could not read it", not "idle").
function decorateNodeUsage(snapshot) {
  const nodes = snapshot.nodes || [];
  const probedAt = snapshot.probed_at ?? null;
  const ageMinutes = probedAt ? Math.max(0, Math.round((Date.now() - Date.parse(probedAt)) / 60000)) : null;
  const verifiable = nodes.filter((n) => n.status === "ok" && Array.isArray(n.gpus) && n.gpus.length);
  const nodeUtil = (n) => Math.max(0, ...n.gpus.map((g) => g.utilization_gpu_percent));
  const utils = verifiable.map(nodeUtil);
  const balance = {
    node_count: nodes.length,
    verifiable_count: verifiable.length,
    unverifiable_count: nodes.length - verifiable.length,
    max_util: utils.length ? Math.max(...utils) : null,
    min_util: utils.length ? Math.min(...utils) : null,
    util_spread: utils.length ? Math.max(...utils) - Math.min(...utils) : null,
    idle_nodes: verifiable.filter((n) => n.gpus.every((g) => g.utilization_gpu_percent <= 5)).map((n) => n.node)
  };
  return { available: true, probed_at: probedAt, age_minutes: ageMinutes, node_count: nodes.length, nodes, balance };
}

function historyInput(q, cfg) {
  return {
    auditDir: cfg.auditDir,
    profileId: q.get("profileId") ?? undefined,
    platform: q.get("platform") ?? undefined,
    status: q.get("status") ?? undefined,
    project: q.get("project") ?? undefined,
    since: q.get("since") ?? undefined,
    limit: clampInt(q.get("limit"), 50, 500)
  };
}

// Compact usage/requested projections the dashboard needs. These are NOT part of the shared
// jobsHistory MCP contract (history.ts), so we read them from the record at the webui layer.
function usageOf(record) {
  const u = record?.usage;
  if (!u) return undefined;
  const out = {};
  for (const k of ["core_hours", "gpu_hours", "cpu_efficiency_percent", "mem_gb", "walltime_seconds", "ncpus", "ngpus"]) {
    if (u[k] != null) out[k] = u[k];
  }
  return Object.keys(out).length ? out : undefined;
}
function requestedOf(record, plan) {
  const r = record?.submission?.requested ?? plan?.normalized_job_spec?.resources ?? plan?.job_spec?.resources ?? plan?.resources;
  if (!r) return undefined;
  const out = {};
  const queue = record?.submission?.queue ?? r.queue ?? plan?.normalized_job_spec?.resources?.queue ?? plan?.job_spec?.resources?.queue ?? plan?.resources?.queue;
  if (queue) out.queue = queue;
  for (const k of ["ncpus", "memory_gb", "ngpus", "walltime"]) {
    if (r[k] != null) out[k] = r[k];
  }
  return Object.keys(out).length ? out : undefined;
}

function profileDefaultsById(cfg) {
  try {
    return new Map(listProfiles(cfg.configPath).map((profile) => [profile.profile_id, profile.defaults ?? {}]));
  } catch {
    return new Map();
  }
}

function queueEvidenceByRemoteJob(cfg) {
  const byJob = new Map();
  if (!fs.existsSync(cfg.quotaDir)) return byJob;
  const snapshots = [];
  const realQuotaDir = fs.realpathSync(cfg.quotaDir);
  for (const entry of fs.readdirSync(cfg.quotaDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const file = path.join(cfg.quotaDir, entry.name);
    try {
      const realFile = fs.realpathSync(file);
      const relative = path.relative(realQuotaDir, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const raw = JSON.parse(fs.readFileSync(realFile, "utf8"));
      const snapshot = raw && typeof raw === "object" && !Array.isArray(raw) && "snapshot" in raw ? raw.snapshot : raw;
      assertQuotaSnapshot(snapshot);
      snapshots.push({ snapshot, outputs: Array.isArray(raw.command_outputs) ? raw.command_outputs : [] });
    } catch {
      continue;
    }
  }
  snapshots.sort((a, b) => (Date.parse(b.snapshot.observed_at) || 0) - (Date.parse(a.snapshot.observed_at) || 0));
  for (const { snapshot, outputs } of snapshots) {
    const queueNames = Array.isArray(snapshot.summary?.queues?.queue_names) ? snapshot.summary.queues.queue_names : [];
    for (const output of outputs) {
      const id = output?.id ?? output?.command_id ?? output?.label ?? "";
      if (id !== "running.qstat-u" || typeof output?.stdout !== "string") continue;
      for (const { jobId, queue } of parseQstatUserQueues(output.stdout, queueNames)) {
        const key = `${snapshot.profile_id}\t${jobId}`;
        if (!byJob.has(key)) byJob.set(key, queue);
      }
    }
  }
  return byJob;
}

function parseQstatUserQueues(stdout, queueNames = []) {
  const rows = [];
  for (const rawLine of String(stdout || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!/^\d+(?:\[[^\]]+\])?\.[A-Za-z0-9_.-]+\s+/.test(line)) continue;
    const fields = line.split(/\s+/);
    const jobId = fields[0];
    const queue = expandQstatQueue(fields[2], queueNames);
    if (jobId && queue) rows.push({ jobId, queue });
  }
  return rows;
}

function expandQstatQueue(queue, queueNames = []) {
  if (!queue || !queue.endsWith("*")) return queue;
  const prefix = queue.slice(0, -1);
  const matches = queueNames.filter((name) => typeof name === "string" && name.startsWith(prefix));
  return matches.length === 1 ? matches[0] : queue;
}

function queueOf(entry, record, requested, plan, profileDefaults, queueEvidence) {
  const remoteJobQueue = entry.remote_job_id ? queueEvidence.get(`${entry.profile_id}\t${entry.remote_job_id}`) : undefined;
  return (
    entry.queue ??
    record?.submission?.queue ??
    requested?.queue ??
    plan?.normalized_job_spec?.resources?.queue ??
    plan?.job_spec?.resources?.queue ??
    plan?.resources?.queue ??
    remoteJobQueue ??
    profileDefaults.get(entry.profile_id)?.queue ??
    record?.requested?.queue
  );
}

function planOf(runId, cfg) {
  return readJsonSafe(path.join(cfg.planDir, `${runId}.json`));
}

function enrichRunEntry(entry, cfg, profileDefaults = profileDefaultsById(cfg), queueEvidence = queueEvidenceByRemoteJob(cfg)) {
  const record = readRunRecordSafe(entry.run_id, cfg.auditDir);
  const plan = planOf(entry.run_id, cfg);
  const usage = usageOf(record);
  const requested = requestedOf(record, plan);
  const queue = queueOf(entry, record, requested, plan, profileDefaults, queueEvidence);
  const planHash = entry.plan_hash ?? record?.plan_hash ?? plan?.plan_hash;
  return {
    ...entry,
    ...(queue ? { queue } : {}),
    ...(planHash ? { plan_hash: planHash } : {}),
    ...(usage ? { usage } : {}),
    ...(requested ? { requested } : {})
  };
}

function historyWithWebuiFields(q, cfg) {
  const base = jobsHistory(historyInput(q, cfg));
  const profileDefaults = profileDefaultsById(cfg);
  const queueEvidence = queueEvidenceByRemoteJob(cfg);
  return { ...base, runs: base.runs.map((entry) => enrichRunEntry(entry, cfg, profileDefaults, queueEvidence)) };
}

// /api/explore — the history listing, enriched per-run with usage + requested read from the record.
function exploreRuns(q, cfg) {
  const base = jobsHistory({ ...historyInput(q, cfg), limit: clampInt(q.get("limit"), 500, 500) });
  const profileDefaults = profileDefaultsById(cfg);
  const queueEvidence = queueEvidenceByRemoteJob(cfg);
  const runs = base.runs.map((entry) => enrichRunEntry(entry, cfg, profileDefaults, queueEvidence));
  return { ...base, runs };
}

// /api/summary — aggregate KPIs for the dashboard header: counts by status, total core/gpu-hours,
// and a by-project core-hours rollup.
function summarize(cfg) {
  const base = jobsHistory({ auditDir: cfg.auditDir, limit: 500 });
  const by_status = {};
  const projects = new Map();
  let total_core_hours = 0;
  let total_gpu_hours = 0;
  let active = 0;
  for (const entry of base.runs) {
    by_status[entry.status] = (by_status[entry.status] ?? 0) + 1;
    if (entry.status === "running" || entry.status === "submitting" || entry.status === "submitted") active += 1;
    const usage = usageOf(readRunRecordSafe(entry.run_id, cfg.auditDir));
    const core = usage?.core_hours ?? 0;
    const gpu = usage?.gpu_hours ?? 0;
    total_core_hours += core;
    total_gpu_hours += gpu;
    const key = entry.project ?? "unassigned";
    const p = projects.get(key) ?? { project: key, runs: 0, core_hours: 0, gpu_hours: 0 };
    p.runs += 1;
    p.core_hours += core;
    p.gpu_hours += gpu;
    projects.set(key, p);
  }
  const by_project = [...projects.values()]
    .map((p) => ({ ...p, core_hours: round2(p.core_hours), gpu_hours: round2(p.gpu_hours) }))
    .sort((a, b) => b.core_hours - a.core_hours || b.runs - a.runs);
  return {
    total_runs: base.total,
    counted: base.runs.length,
    active,
    by_status,
    total_core_hours: round2(total_core_hours),
    total_gpu_hours: round2(total_gpu_hours),
    by_project
  };
}

function runDetail(runId, cfg) {
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`unsafe run id: ${runId}`);
  }
  const run = readRunRecordSafe(runId, cfg.auditDir);
  if (!run) {
    return { found: false, run: null };
  }
  const plan = readJsonSafe(path.join(cfg.planDir, `${runId}.json`));
  const manifest = readJsonSafe(path.join(cfg.artifactsDir, runId, "manifest.json"));
  return { found: true, run, plan, manifest };
}

function listCapacitySnapshots(q, cfg) {
  const profileFilter = q.get("profileId") || "";
  const limit = clampInt(q.get("limit"), 50, 200);
  const snapshots = [];
  if (!fs.existsSync(cfg.quotaDir)) {
    return { total: 0, returned: 0, profiles: [], snapshots: [] };
  }
  const realQuotaDir = fs.realpathSync(cfg.quotaDir);
  for (const entry of fs.readdirSync(cfg.quotaDir, { withFileTypes: true })) {
    if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
    const idFromFile = entry.name.slice(0, -".json".length);
    if (!isSafeSnapshotId(idFromFile)) continue;
    const file = path.join(cfg.quotaDir, entry.name);
    try {
      const realFile = fs.realpathSync(file);
      const relative = path.relative(realQuotaDir, realFile);
      if (relative.startsWith("..") || path.isAbsolute(relative)) continue;
      const stat = fs.statSync(realFile);
      const raw = JSON.parse(fs.readFileSync(realFile, "utf8"));
      const snapshot = raw && typeof raw === "object" && !Array.isArray(raw) && "snapshot" in raw ? raw.snapshot : raw;
      assertQuotaSnapshot(snapshot);
      if (snapshot.snapshot_id !== idFromFile) continue;
      if (profileFilter && snapshot.profile_id !== profileFilter) continue;
      snapshots.push(capacitySnapshotSummary(snapshot, stat.mtimeMs));
    } catch {
      continue;
    }
  }
  snapshots.sort((a, b) => (Date.parse(b.observed_at) || b.mtime_ms) - (Date.parse(a.observed_at) || a.mtime_ms));
  const profiles = [...new Set(snapshots.map((s) => s.profile_id))].sort();
  return {
    total: snapshots.length,
    returned: Math.min(limit, snapshots.length),
    profiles,
    snapshots: snapshots.slice(0, limit).map(({ mtime_ms, ...s }) => s)
  };
}

function capacitySnapshotSummary(snapshot, mtimeMs) {
  const queues = Array.isArray(snapshot.summary?.queues?.queue_limits) ? snapshot.summary.queues.queue_limits : [];
  const storage = Array.isArray(snapshot.summary?.storage?.filesystems) ? snapshot.summary.storage.filesystems : [];
  const families = snapshot.summary?.node_families || {};
  const running = snapshot.summary?.running_work || {};
  const observedMs = Date.parse(snapshot.observed_at);
  const ageMinutes = Number.isFinite(observedMs) ? Math.max(0, Math.round((Date.now() - observedMs) / 60000)) : null;
  return {
    snapshot_id: snapshot.snapshot_id,
    profile_id: snapshot.profile_id,
    platform: snapshot.platform,
    observed_at: snapshot.observed_at,
    freshness: snapshot.freshness,
    source: snapshot.source,
    age_minutes: ageMinutes,
    queue_count: queues.length,
    storage_count: storage.length,
    available_family_count: Array.isArray(families.available_families) ? families.available_families.length : 0,
    active_session_count: Number.isFinite(running.active_session_count) ? running.active_session_count : null,
    mtime_ms: mtimeMs
  };
}

function isSafeSnapshotId(value) {
  return /^[A-Za-z0-9_.:-]{1,160}$/.test(value) && !value.startsWith(".") && !value.includes("..");
}

// Read-only v1 surfaces the most recent saved status/log evidence (offline). Live log fetch (SSH) is a
// later phase and is intentionally not wired into the read-only dashboard.
function savedLogs(runId, cfg) {
  if (!SAFE_RUN_ID_PATTERN.test(runId)) {
    throw new Error(`unsafe run id: ${runId}`);
  }
  const evidence = [];
  if (fs.existsSync(cfg.evidenceDir)) {
    for (const name of fs.readdirSync(cfg.evidenceDir).filter((entry) => entry.startsWith(`${runId}-`) && entry.endsWith(".json")).sort().slice(-20)) {
      evidence.push({ name, ...(readJsonSafe(path.join(cfg.evidenceDir, name)) ?? {}) });
    }
  }
  const dir = path.join(cfg.evidenceDir, runId);
  if (!fs.existsSync(dir)) {
    return evidence.length
      ? { run_id: runId, evidence }
      : { run_id: runId, evidence: [], note: "no saved log/status evidence for this run yet" };
  }
  evidence.push(...fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".json"))
    .sort()
    .slice(-20)
    .map((name) => ({ name, ...(readJsonSafe(path.join(dir, name)) ?? {}) })));
  return { run_id: runId, evidence };
}

// ---- response + IO plumbing ----

function ok(res, result) {
  sendJson(res, 200, { ok: true, ...result });
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(body);
}

function serveStatic(pathname, res) {
  const rel = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
  const target = path.normalize(path.join(PUBLIC_DIR, rel));
  // Guard: never serve outside PUBLIC_DIR.
  if (target !== PUBLIC_DIR && !target.startsWith(PUBLIC_DIR + path.sep)) {
    return sendJson(res, 403, { ok: false, error: "forbidden" });
  }
  if (!fs.existsSync(target) || !fs.statSync(target).isFile()) {
    if (!path.extname(rel)) {
      return serveStatic("/", res);
    }
    return sendJson(res, 404, { ok: false, error: "not found" });
  }
  res.writeHead(200, {
    "content-type": STATIC_TYPES[path.extname(target)] ?? "application/octet-stream",
    "cache-control": "no-store"
  });
  fs.createReadStream(target).pipe(res);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 1_000_000) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

// CSRF defense for a localhost tool: require application/json (cross-origin forms can't set it without a
// CORS preflight this server never approves) and reject any cross-origin Origin header.
function isSameOriginJson(req) {
  const ctype = String(req.headers["content-type"] ?? "");
  if (!ctype.includes("application/json")) return false;
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return false;
  return true;
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function clampInt(value, fallback, max) {
  const n = Number.parseInt(value ?? "", 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return Math.min(n, max);
}

function errMessage(error) {
  const message = error instanceof Error ? error.message : String(error);
  return message.length > 500 ? `${message.slice(0, 497)}...` : message;
}

const WEBUI_PORT = 4173;

// CLI entry: `node webui/server.mjs` — binds 127.0.0.1 on the fixed local WebUI port only.
if (import.meta.url === `file://${process.argv[1]}`) {
  if (process.argv.length > 2) {
    process.stderr.write("Usage: node webui/server.mjs\n");
    process.stderr.write(`The dashboard uses the fixed local port ${WEBUI_PORT}; run \`npm run webui:stop\` before starting it again.\n`);
    process.exit(2);
  }
  const port = WEBUI_PORT;
  // Default to the operator's real profiles when present. The MCP server receives this path via
  // .mcp.json, but `node webui/server.mjs` did not — so the dashboard silently ran against the bundled
  // EXAMPLE (placeholder-host) profiles, and every live SSH op (snapshot probe, reconcile) failed
  // against fake hostnames. Auto-adopt the conventional untracked local config so the dashboard talks
  // to real accounts out of the box; the example profiles remain the fallback when it is absent.
  if (!process.env.UTS_COMPUTING_CONFIG) {
    const localConfig = path.resolve(__dirname, "../profiles/profiles.local.yaml");
    if (fs.existsSync(localConfig)) {
      process.env.UTS_COMPUTING_CONFIG = localConfig;
      process.stdout.write(`uts-compute: using local profiles ${localConfig}\n`);
    }
  }
  const runtimeDirOverride = process.env.UTS_WEBUI_RUNTIME_DIR
    ? path.resolve(process.env.UTS_WEBUI_RUNTIME_DIR)
    : undefined;
  const server = createWebuiServer({ ...(runtimeDirOverride ? { runtimeDir: runtimeDirOverride } : {}) });
  server.on("error", (error) => {
    if (error?.code === "EADDRINUSE") {
      process.stderr.write(
        `uts-compute dashboard port ${port} is already in use. Run \`npm run webui:stop\` before starting it again.\n`
      );
      process.exit(1);
    }
    throw error;
  });
  server.listen(port, "127.0.0.1", () => {
    process.stdout.write(`uts-compute dashboard on http://127.0.0.1:${port}\n`);
  });
}
