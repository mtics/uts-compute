#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolCallback } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AnySchema, ZodRawShapeCompat } from "@modelcontextprotocol/sdk/server/zod-compat.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { effectiveConfigStatus, getProfile, listProfiles, redactProfile, validateProfiles } from "./core/config.js";
import { planJob } from "./ops/plans/planner.js";
import { makeEnvRunner } from "./ops/plans/reproducibility.js";
import { projectRoot } from "./core/paths.js";
import { redactLocalHome, redactProjectRoot } from "./lib/redact.js";
import { executeTransfer, planTransfer } from "./ops/data/transfer.js";
import { listTemplates } from "./ops/catalog/templates.js";
import { refreshDocs, searchDocs } from "./ops/catalog/docs.js";
import { checkAccess } from "./core/access.js";
import { refreshQuotas } from "./ops/quotas/quotas.js";
import { registerUtsResources, latestQuotaSnapshotForProfile } from "./mcp/resources.js";
import { registerUtsPrompts } from "./mcp/prompts.js";
import { approvalStatus, decideApproval, listApprovals, requestApproval } from "./ops/approvals/approvals.js";
import { submitJob } from "./ops/jobs/submit.js";
import { planRetryJob } from "./ops/jobs/retry.js";
import { cancelJob, getJobLogs, getJobStatus, getJobUsage, trackActiveJobs } from "./ops/jobs/jobs.js";
import { adoptExternalRun } from "./ops/jobs/adopt.js";
import {
  executeArtifactCleanup,
  fetchArtifact,
  fetchArtifactsBatch,
  listArtifacts,
  planArtifactCleanup,
  summarizeArtifacts,
  summarizeRemoteArtifact
} from "./ops/data/artifacts.js";
import { applyStateMigration, planStateMigration } from "./ops/data/migrations.js";
import { listRunRecordIds } from "./core/audit.js";
import { jobsHistory } from "./ops/jobs/history.js";
import { listProjects } from "./ops/profiles/projects.js";
import { campaignAudit, campaignStatus } from "./ops/quotas/campaign.js";
import { campaignStart } from "./ops/scheduler/campaign/start.js";
import { quotaCapacity } from "./ops/quotas/capacity.js";
import { onboardProfile } from "./ops/profiles/onboarding.js";
import { jobsRightsize } from "./ops/quotas/rightsize.js";
import { runDoctor } from "./ops/access/doctor.js";
import { sshConfigSnippet } from "./ops/access/ssh-export.js";
import { diagnoseJob } from "./ops/jobs/diagnose.js";
import { planSweep, rankSweep } from "./ops/jobs/sweep.js";
import { planRetrySweep } from "./ops/jobs/retry-sweep.js";
import { runIhpcPreflight } from "./ops/jobs/ihpc-preflight.js";
import { generateCampaignQueue } from "./ops/jobs/ihpc-generate.js";
import { runIhpcNodeUsage } from "./ops/jobs/ihpc-node-usage.js";
import { confirmUsageOnNode } from "./ops/access/confirm-usage.js";
import { protocolTestJobExecutor, protocolTestDocsFetcher, protocolTestQuotaExecutor } from "./core/test-executors.js";
import {
  APPROVAL_ID,
  PLAN_HASH,
  PLATFORM_ENUM,
  PROFILE_ID,
  QUOTA_SNAPSHOT_ID,
  MANIFEST_HASH,
  RUN_ID,
  TIMEOUT_MS_CONFIRM_USAGE,
  TIMEOUT_MS_STANDARD,
  TIMEOUT_MS_TRANSFER,
  artifactBytesField,
  artifactIdsField,
  docsRefreshMaxBytesField,
  jsonObjectField,
  logTailBytesField,
  metricSummaryBytesField,
  sweepParametersField,
  timeoutMsField
} from "./mcp/schemas.js";

// Advertise the version from package.json so it stays in lockstep with the shipped manifests, rather
// than a hand-maintained literal that drifts behind a version bump (it had already lagged at 0.1.0
// while the manifests moved to 0.1.1). package.json ships in every channel (plugin root and the .mcpb
// bundle); fall back to a sentinel only if it is somehow unreadable.
function packageVersion(): string {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(projectRoot, "package.json"), "utf8")) as { version?: unknown };
    return typeof pkg.version === "string" ? pkg.version : "0.0.0";
  } catch {
    return "0.0.0";
  }
}

const server = new McpServer({
  name: "uts-compute",
  version: packageVersion()
});

const TOOL_OUTPUT_SCHEMA = z.object({ ok: z.boolean() }).passthrough();
const EMPTY_INPUT_SCHEMA = z.object({}).strict();

function strictInput<T extends z.ZodRawShape>(shape: T) {
  return z.object(shape).strict();
}

registerUtsResources(server);
registerUtsPrompts(server, {
  profileId: (value) => listProfiles().map((profile) => profile.profile_id).filter((id) => id.startsWith(value ?? "")),
  runId: (value) => listRunRecordIds().filter((id) => id.startsWith(value ?? ""))
});

function jsonContent(value: Record<string, unknown>, isError = false) {
  return {
    isError,
    structuredContent: value,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify(value, null, 2)
      }
    ]
  };
}

// Mask the operator's home/install location out of the disclosed config path, mirroring the
// resource-display redactor (resources.ts): the bundled example collapses to <project>/…, and any
// real external config under /Users/<home> collapses to <local-home>/… — so the path stays
// recognizable (…/profiles.example.yaml) without leaking an absolute local path into tool output.
function redactConfigPath(value: string): string {
  return redactLocalHome(redactProjectRoot(value, projectRoot));
}

// H4/M13: compute the config self-disclosure for the success envelope, but never let a disclosure
// failure mask the tool's real result — degrade to omitting the field on any error.
function safeConfigStatus(): { using_example_profiles: boolean; config_path: string } | undefined {
  try {
    const status = effectiveConfigStatus();
    return { using_example_profiles: status.using_example_profiles, config_path: redactConfigPath(status.config_path) };
  } catch {
    return undefined;
  }
}

// H9: safeTool awaits the top-level return, but a handler that returns an OBJECT with an
// un-awaited Promise *property* (the "forgot to await" footgun) would otherwise serialize that
// property to `{}` on a SUCCESS envelope — silent data loss the agent cannot detect. This shallow
// guard inspects the resolved result's own-enumerable property values and throws on any thenable,
// so the surrounding try/catch turns it into the standard `{ ok:false, error }` envelope. Shallow
// (top-level only) because that is where the footgun lives, and cheap (a single Object.entries pass).
export async function safeTool(handler: () => Promise<unknown> | unknown) {
  try {
    const result = await handler();
    const body =
      result && typeof result === "object" && !Array.isArray(result) ? (result as Record<string, unknown>) : { result };
    if (result && typeof result === "object" && !Array.isArray(result)) {
      for (const [key, value] of Object.entries(body)) {
        if (value && (typeof value === "object" || typeof value === "function") && typeof (value as { then?: unknown }).then === "function") {
          throw new Error(
            `Tool handler returned an un-awaited Promise in property '${key}' — await it before returning (safeTool only awaits the top-level return).`
          );
        }
      }
    }
    // Surface config_status on SUCCESS envelopes only (error envelopes stay minimal: { ok, error }).
    const config_status = safeConfigStatus();
    return jsonContent({ ok: true, ...(config_status ? { config_status } : {}), ...body });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return jsonContent({ ok: false, error: message }, true);
  }
}

function jobOperationOptionsFromEnv(timeoutMs: number | undefined) {
  return {
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    ...(process.env.UTS_COMPUTING_TEST_MODE === "1" && process.env.UTS_COMPUTING_TEST_JOB_OPS === "mock"
      ? { executor: protocolTestJobExecutor }
      : {})
  };
}

// Executor seam for quotas.capacity { refresh:true } — re-read on every call so the test-mode env
// flag is honored per-invocation (the closure-capture footgun documented above). Default: no
// executor override, so the real SSH executor is used.
function quotaCapacityOptionsFromEnv() {
  return process.env.UTS_COMPUTING_TEST_MODE === "1" && process.env.UTS_COMPUTING_TEST_QUOTA_OPS === "mock"
    ? { executor: protocolTestQuotaExecutor }
    : {};
}

function docsRefreshOptionsFromEnv() {
  return {
    ...(process.env.UTS_COMPUTING_TEST_MODE === "1" && process.env.UTS_COMPUTING_TEST_DOCS === "mock"
      ? {
          fetcher: protocolTestDocsFetcher,
          now: new Date("2026-06-15T00:00:00.000Z")
        }
      : {})
  };
}

// Safety annotations surfaced to MCP clients so they can render this server's posture.
// readOnlyHint: no remote mutation or deletion. destructiveHint: terminates jobs, deletes files,
// overwrites transfer targets, or rewrites local state. openWorldHint: contacts UTS systems over
// SSH/HTTPS (vs purely local planning/inspection). See docs/architecture.md for the tool boundary.
interface ToolHints {
  readOnlyHint: boolean;
  destructiveHint: boolean;
  idempotentHint: boolean;
  openWorldHint: boolean;
}
const READ_LOCAL: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const READ_REMOTE: ToolHints = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true };

const ANNOTATIONS_SUBMIT: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true };
const ANNOTATIONS_EFFECTFUL_REMOTE: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true };
const ANNOTATIONS_EFFECTFUL_LOCAL_IDEMPOTENT: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const ANNOTATIONS_EFFECTFUL_LOCAL: ToolHints = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false };
const ANNOTATIONS_DESTRUCTIVE_REMOTE: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true };
const ANNOTATIONS_DESTRUCTIVE_LOCAL: ToolHints = { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false };

// A self-registering tool definition: defineTool captures each tool's input/output generics so its
// handler stays type-checked against its own inputSchema, then returns a closure that registers the
// tool on a given server. The declarative TOOLS table below is a list of these closures; the loop at
// the bottom invokes each one. outputSchema defaults to TOOL_OUTPUT_SCHEMA. The per-tool title +
// safety annotations live inline on each row (they used to sit in a separate TOOL_META map).
//
// IMPORTANT — preserved behaviors (see docs/archive/duplication-audit-2026-06.md, "Table-driven tool
// registration"):
//   - The handler keeps the sync-vs-async inner-handler contract: safeTool already awaits, so a
//     handler may return either a value or a Promise.
//   - Any env-opts threading (jobOperationOptionsFromEnv / docsRefreshOptionsFromEnv) MUST stay INSIDE
//     the handler closure so UTS_COMPUTING_TEST_MODE is re-read on every invocation, not once at
//     registration time (the documented await-/closure-capture footgun).
//   - The registered tool-name set is byte-identical to the prior 38 explicit registerTool calls;
//     tests/tool-registration.test.mjs pins the exact set, and mcp-protocol.test.mjs re-pins it live.
type ToolRegistrar = (target: McpServer) => void;

function defineTool<
  InputArgs extends undefined | ZodRawShapeCompat | AnySchema = undefined
>(
  name: string,
  meta: {
    title: string;
    annotations: ToolHints;
    description?: string;
    inputSchema?: InputArgs;
  },
  cb: ToolCallback<InputArgs>
): ToolRegistrar {
  const { title, annotations, description, inputSchema } = meta;
  return (target) => {
    target.registerTool<typeof TOOL_OUTPUT_SCHEMA, InputArgs>(
      name,
      { description, inputSchema, outputSchema: TOOL_OUTPUT_SCHEMA, title, annotations },
      cb
    );
  };
}

const TOOLS: ToolRegistrar[] = [
  defineTool(
    "profiles.list",
    {
      title: "List compute profiles",
      annotations: READ_LOCAL,
      description: "List configured UTS compute profiles with secret-bearing fields redacted.",
      inputSchema: EMPTY_INPUT_SCHEMA
    },
    async () =>
      safeTool(() => ({
        profiles: listProfiles().map((profile) =>
          redactProfile(profile, latestQuotaSnapshotForProfile(profile.profile_id))
        )
      }))
  ),
  defineTool(
    "profiles.validate",
    {
      title: "Validate profiles",
      annotations: READ_LOCAL,
      description: "Validate all profiles or one profile against the local profile schema.",
      inputSchema: strictInput({
        profileId: PROFILE_ID.optional()
      })
    },
    async ({ profileId }) => safeTool(() => ({ results: validateProfiles(undefined, profileId) }))
  ),
  defineTool(
    "templates.list",
    {
      title: "List job templates",
      annotations: READ_LOCAL,
      description: "List local dry-run templates available to jobs.plan.",
      inputSchema: EMPTY_INPUT_SCHEMA
    },
    async () => safeTool(() => ({ templates: listTemplates() }))
  ),
  defineTool(
    "access.check",
    {
      title: "Check access (VPN/SSH preflight)",
      annotations: READ_REMOTE,
      description:
        "Run read-only VPN/DNS/TCP/SSH preflight checks for one configured UTS compute profile and write redacted local evidence.",
      inputSchema: strictInput({
        profileId: PROFILE_ID,
        checks: z
          .array(z.enum(["profile", "vpn", "ssh-config", "dns", "tcp", "host-key", "ssh-auth", "remote-identity"]))
          .optional(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ profileId, checks, timeoutMs }) => safeTool(async () => ({ access: await checkAccess(profileId, { checks, timeoutMs }) }))
  ),
  defineTool(
    "access.doctor",
    {
      title: "Run access doctor (health check)",
      annotations: READ_REMOTE,
      description:
        "Run a live read-only health check across one UTS compute profile (or all when profileId is omitted): connectivity preflight (VPN/DNS/TCP/SSH/host-key/auth/identity), remote clock-skew, and PBS scheduler reachability. Aggregates an ok/warn/fail report with next-step findings. Contacts UTS systems over SSH; makes no changes and writes no evidence. " +
        "With exportSsh:true (requires a single profileId), instead emits a secret-free ~/.ssh/config snippet — login host plus env-var NAMES only, never any secret value — so a human can reach the cluster when the plugin can't (VPN down/offline); this path is pure and local, contacting nothing.",
      inputSchema: strictInput({
        profileId: PROFILE_ID.optional(),
        exportSsh: z
          .boolean()
          .default(false)
          .describe("Emit a secret-free ~/.ssh/config snippet for a single profileId instead of running live checks"),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ profileId, timeoutMs, exportSsh }) =>
      safeTool(() => {
        if (exportSsh) {
          if (!profileId) throw new Error("access.doctor --export-ssh requires a single profileId");
          const profile = getProfile(profileId);
          const exp = sshConfigSnippet(profile);
          return { access: { mode: "export-ssh", profile_id: profileId, ...exp } };
        }
        return runDoctor({ profileId, timeoutMs });
      })
  ),
  defineTool(
    "access.confirm_usage",
    {
      title: "Confirm iHPC node usage",
      annotations: ANNOTATIONS_EFFECTFUL_REMOTE,
      description:
        "Confirm active usage on a UTS iHPC interactive node in response to a node-usage-monitoring email. " +
        "SSHes through the profile's login gateway to the specified node and executes `confirm_usage <token>`. " +
        "Use only for uts-ihpc profiles. The token must be exactly as provided in the email (alphanumeric, 4–32 chars).",
      inputSchema: strictInput({
        profileId: PROFILE_ID.describe("iHPC profile ID (must have platform: uts-ihpc)"),
        node: z.string().describe("iHPC compute node name from the email, e.g. \"turing1\""),
        token: z
          .string()
          .min(4)
          .max(32)
          .regex(/^[A-Za-z0-9]+$/, "Token must be alphanumeric")
          .describe("Confirmation token from the iHPC usage-monitoring email"),
        timeoutMs: timeoutMsField(TIMEOUT_MS_CONFIRM_USAGE)
      })
    },
    async ({ profileId, node, token, timeoutMs }) =>
      safeTool(async () => confirmUsageOnNode(profileId, node, token, { timeoutMs }))
  ),
  defineTool(
    "docs.search",
    {
      title: "Search local docs",
      annotations: READ_LOCAL,
      description:
        "Search only the allowlisted local UTS computing documentation files and return bounded line snippets; does not fetch live URLs or read arbitrary paths.",
      inputSchema: strictInput({
        query: z.string().min(2).max(200),
        docIds: z.array(z.string()).max(10).optional(),
        maxResults: z.number().int().min(1).max(20).optional(),
        maxSnippetChars: z.number().int().min(80).max(500).optional()
      })
    },
    async (input) => safeTool(() => searchDocs(input))
  ),
  defineTool(
    "docs.refresh",
    {
      title: "Refresh docs cache",
      annotations: READ_REMOTE,
      description:
        "Refresh a fixed allowlist of official UTS HPC/iHPC documentation pages into the local docs cache. Requires local VPN access when UTS requires it; does not accept arbitrary URLs, paths, headers, profiles, or proxies. If network access fails and no cache exists, use `access.doctor --export-ssh` to obtain the connection path for a manual SSH handoff.",
      inputSchema: strictInput({
        sourceIds: z.array(z.string()).min(1).max(10).optional(),
        maxBytes: docsRefreshMaxBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async (input) => safeTool(() => refreshDocs(input, docsRefreshOptionsFromEnv()))
  ),
  defineTool(
    "quotas.refresh",
    {
      title: "Refresh quota snapshot",
      annotations: READ_REMOTE,
      description:
        "Refresh read-only live quota, queue, job, group, and node evidence for one selected UTS compute profile.",
      inputSchema: strictInput({
        profileId: PROFILE_ID,
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ profileId, timeoutMs }) => safeTool(async () => ({ quota: await refreshQuotas(profileId, { timeoutMs }) }))
  ),
  defineTool(
    "quotas.capacity",
    {
      title: "Advise queue capacity",
      annotations: READ_REMOTE,
      description:
        "Read-only capacity advisor: from a saved quota snapshot, report per-queue headroom (max_run - running, max_queued - queued), which queue has room, the recommended parallelism (how many jobs can start now), and storage usage. iHPC reports available cnode families + active sessions. Use it before submitting / before setting a sweep's max_concurrent. By default reads the saved snapshotId (local only; a stale snapshot is flagged, not rejected). With refresh:true it first captures a FRESH snapshot via a live read-only quotas.refresh over SSH, then advises on it (no stale-age note).",
      inputSchema: strictInput({
        profileId: PROFILE_ID,
        snapshotId: QUOTA_SNAPSHOT_ID,
        refresh: z
          .boolean()
          .default(false)
          .describe("Capture a fresh snapshot (live read-only quotas.refresh) before advising, instead of reading snapshotId")
      })
    },
    async ({ profileId, snapshotId, refresh }) =>
      safeTool(() => quotaCapacity({ profileId, snapshotId, refresh }, quotaCapacityOptionsFromEnv()))
  ),
  defineTool(
    "profiles.onboard",
    {
      title: "Onboard a profile (first-run)",
      annotations: READ_REMOTE,
      description:
        "First-run onboarding for one profile: connect to the account (live quotas.refresh), confirm access by observing the remote identity, persist an onboarding marker, and report the discovered resource-allocation limits (per-queue headroom + recommended parallelism). Required once per profile before any live submission; dry-run planning never needs it. Contacts UTS systems over SSH; writes only a local onboarding marker.",
      inputSchema: strictInput({
        profileId: PROFILE_ID,
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ profileId, timeoutMs }) => safeTool(() => onboardProfile({ profileId }, { timeoutMs }))
  ),
  defineTool(
    "approvals.request",
    {
      title: "Request an approval",
      annotations: ANNOTATIONS_EFFECTFUL_LOCAL_IDEMPOTENT,
      description:
        "Create or retrieve a local approval record bound to one run_id, operation, plan_hash, and quota_snapshot_id, deriving saved-plan risk reasons when available. For an ADOPTED bare-qsub PBS job (one the plugin never planned, so it has no plan_hash), request a jobs.cancel approval with remoteJobId INSTEAD of planHash/quotaSnapshotId — it binds the cancel to that run's adopted identity (run_id + profile + platform + remote_job_id).",
      inputSchema: strictInput({
        runId: RUN_ID,
        profileId: PROFILE_ID,
        previousProfileId: PROFILE_ID.optional(),
        platform: PLATFORM_ENUM,
        operation: z
          .enum([
            "jobs.submit",
            "jobs.cancel",
            "jobs.retry",
            "transfers.execute",
            "artifacts.fetch",
            "artifacts.fetch.batch",
            "artifacts.cleanup.execute"
          ])
          .optional(),
        // Optional only for the adopted jobs.cancel path (which binds remoteJobId); required otherwise.
        planHash: PLAN_HASH.optional(),
        quotaSnapshotId: QUOTA_SNAPSHOT_ID.optional(),
        remoteJobId: z.string().optional(),
        reasons: z.array(z.string()).optional(),
        commandSummary: z.string().optional(),
        resourceSummary: z.record(z.string(), z.unknown()).optional(),
        expiresInHours: z.number().int().min(1).max(168).optional()
      })
    },
    async (input) => safeTool(() => requestApproval(input))
  ),
  defineTool(
    "approvals.status",
    {
      title: "Read approval status",
      annotations: READ_LOCAL,
      description: "Read one local approval record and update required approvals to expired when their TTL has passed.",
      inputSchema: strictInput({
        approvalId: APPROVAL_ID
      })
    },
    async (input) => safeTool(() => approvalStatus(input))
  ),
  defineTool(
    "approvals.decide",
    {
      title: "Decide an approval",
      annotations: ANNOTATIONS_EFFECTFUL_LOCAL,
      description:
        "Record an explicit user approval or rejection for a required approval, verifying the same plan_hash, quota_snapshot_id, and trusted local confirmation token. For an adopted jobs.cancel approval (bound to remoteJobId, no plan_hash), pass the same remoteJobId instead.",
      inputSchema: strictInput({
        approvalId: APPROVAL_ID,
        decision: z.enum(["approved", "rejected"]),
        // Optional only for the adopted jobs.cancel path (verified against remoteJobId); required otherwise.
        planHash: PLAN_HASH.optional(),
        quotaSnapshotId: QUOTA_SNAPSHOT_ID.optional(),
        remoteJobId: z.string().optional(),
        confirmationToken: z.string(),
        decidedBy: z.string().optional(),
        reason: z.string().optional()
      })
    },
    async (input) => safeTool(() => decideApproval(input))
  ),
  defineTool(
    "approvals.list",
    {
      title: "List approval records",
      annotations: READ_LOCAL,
      description:
        "List local approval records as a redaction-safe summary (approval_id, run_id, profile_id, platform, " +
        "operation, state, requested_at, expires_at), newest first. Use it to find the approval id a " +
        "token-gated operation (jobs.cancel, artifacts.cleanup.execute) needs. No command or resource bodies are surfaced.",
      inputSchema: EMPTY_INPUT_SCHEMA
    },
    async () => safeTool(() => listApprovals())
  ),
  defineTool(
    "jobs.plan",
    {
      title: "Plan a job (dry-run)",
      annotations: READ_LOCAL,
      description:
        "Validate a job spec, render a local dry-run script, and write a local planned run record without SSH or remote side effects.",
      inputSchema: strictInput({
        jobSpec: jsonObjectField(
          "A JobSpec object — strictly validated against schemas/job-spec.schema.json (top-level additionalProperties:false). Required: run_id, profile_id, platform ('uts-hpc'|'uts-ihpc'), experiment, command, resources. resources holds queue, node_family, ncpus, memory_gb, walltime, ngpus, array{start,end,max_concurrent}. Optional top-level: workdir, inputs, outputs, resumable, approval."
        ),
        // Optional campaign attribution (DISCLOSURE). Lands on the run record only — never hashed
        // into plan_hash, never on the JobSpec.
        campaignId: z.string().optional()
      })
    },
    async ({ jobSpec, campaignId }) =>
      safeTool(() => ({
        plan: planJob(jobSpec, { envRunner: makeEnvRunner(projectRoot), ...(campaignId ? { campaignId } : {}) })
      }))
  ),
  defineTool(
    "jobs.submit",
    {
      title: "Submit a job",
      annotations: ANNOTATIONS_SUBMIT,
      description:
        "Submit one previously planned job: UTS HPC PBS via qsub, or UTS iHPC via a fixed supervised-start adapter. UTS HPC submits autonomously when the job conforms to a fresh quotaSnapshotId (no token); pass an approvalId instead to use the legacy approval gate. iHPC supervised starts ALWAYS require a fresh quotaSnapshotId for the ban-critical node-pool gate (the held-node evidence must be consume-time-fresh, never an approval's possibly-stale bound snapshot); an approvalId may accompany it for authorization but does not substitute for the fresh snapshot.",
      inputSchema: strictInput({
        runId: RUN_ID,
        approvalId: APPROVAL_ID.optional(),
        quotaSnapshotId: QUOTA_SNAPSHOT_ID.optional(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, approvalId, quotaSnapshotId, timeoutMs }) =>
      safeTool(() => submitJob({ runId, approvalId, quotaSnapshotId }, { timeoutMs }))
  ),
  defineTool(
    "jobs.retry.plan",
    {
      title: "Plan a job retry (dry-run)",
      annotations: READ_LOCAL,
      description:
        "Create a new local dry-run retry plan from a failed or cancelled saved run without SSH or remote side effects. Pass escalate (memory_factor / walltime_factor, 1-4x) to bump resources for an OOM/timeout retry; submit-time conformance still caps it. Only escalate ephemeral failure classes (resource/timeout) — a bigger node won't fix a code bug.",
      inputSchema: strictInput({
        sourceRunId: RUN_ID,
        retryRunId: RUN_ID,
        reason: z.string().optional(),
        escalate: z
          .object({
            memory_factor: z.number().min(1).max(4).optional(),
            walltime_factor: z.number().min(1).max(4).optional()
          })
          .optional(),
        resume: z.boolean().optional()
      })
    },
    async ({ sourceRunId, retryRunId, reason, escalate, resume }) =>
      safeTool(() => planRetryJob({ sourceRunId, retryRunId, reason, escalate, resume }))
  ),
  defineTool(
    "jobs.status",
    {
      title: "Get job status",
      annotations: READ_REMOTE,
      description:
        "Query read-only UTS HPC PBS scheduler status or UTS iHPC supervisor status for one submitted run using saved local run-record state. For an ADOPTED/foreign iHPC run (ingested via jobs.adopt; no supervisor metadata) it takes the read-only OBSERVE path instead: it reports whether the recorded pid is still alive on its node (liveness alive/dead/unknown) plus the node's live per-GPU snapshot, without requiring supervisor paths.",
      inputSchema: strictInput({
        runId: RUN_ID,
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, timeoutMs }) => safeTool(() => getJobStatus({ runId }, jobOperationOptionsFromEnv(timeoutMs)))
  ),
  defineTool(
    "jobs.track",
    {
      title: "Track active jobs",
      annotations: READ_REMOTE,
      description:
        "Re-poll every active (submitted or running) UTS HPC PBS or UTS iHPC run that already has a remote job id, reconcile each saved run record to live scheduler/supervisor state in one read-only sweep, and return a status table. Skips terminal and not-yet-submitted runs; bounds the SSH fan-out and caps the polled set, flagging truncation. Optional profileId / platform / project filters (project accepts the slug or the proj- hash). Set nodeUsage:true to ALSO fuse each active iHPC run's compute-node live GPU snapshot (per-GPU utilization + memory, via the same read-only probe as ihpc.node.usage) into its entry — one fleet view, no per-node nvidia-smi; each distinct node is probed at most once and a node it cannot read is reported node-unverifiable (never fabricated). Default off keeps the lighter sweep. Contacts UTS systems over SSH; the only local change is updating run-record status.",
      inputSchema: strictInput({
        profileId: PROFILE_ID.optional(),
        platform: PLATFORM_ENUM.optional(),
        project: z.string().optional(),
        limit: z.number().int().min(1).max(200).optional(),
        nodeUsage: z.boolean().optional(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ profileId, platform, project, limit, nodeUsage, timeoutMs }) =>
      safeTool(() => trackActiveJobs({ profileId, platform, project, limit, nodeUsage }, jobOperationOptionsFromEnv(timeoutMs)))
  ),
  defineTool(
    "jobs.usage",
    {
      title: "Get job usage/accounting",
      annotations: READ_REMOTE,
      description:
        "Report read-only PBS usage accounting for one finished or running UTS HPC run: core-hours, GPU-hours, and CPU efficiency parsed from qstat -x. Usage is framed in hours against a fixed allocation, not cost. iHPC supervised runs have no batch-scheduler accounting (usage is null).",
      inputSchema: strictInput({
        runId: RUN_ID,
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, timeoutMs }) => safeTool(() => getJobUsage({ runId }, jobOperationOptionsFromEnv(timeoutMs)))
  ),
  defineTool(
    "jobs.diagnose",
    {
      title: "Diagnose a failed job",
      annotations: READ_REMOTE,
      description:
        "Diagnose why a run failed and emit the safe next action. Combines read-only jobs.status and bounded jobs.logs, then classifies the failure (access / quota / resource-request / environment / command / data-path / session-timeout) from the redacted log tail. Contacts UTS systems over SSH; makes no changes.",
      inputSchema: strictInput({
        runId: RUN_ID,
        maxBytes: logTailBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, maxBytes, timeoutMs }) => safeTool(() => diagnoseJob({ runId, maxBytes }, jobOperationOptionsFromEnv(timeoutMs)))
  ),
  defineTool(
    "jobs.logs",
    {
      title: "Fetch job logs",
      annotations: READ_REMOTE,
      description:
        "Fetch read-only bounded UTS HPC PBS or UTS iHPC supervisor stdout/stderr log tails from paths recorded in saved local state. Adopted/foreign iHPC runs are observe-only (no supervisor log paths): logs are unavailable there — use jobs.status to observe liveness + GPU instead.",
      inputSchema: strictInput({
        runId: RUN_ID,
        stream: z.enum(["stdout", "stderr", "both"]).optional(),
        maxBytes: logTailBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, stream, maxBytes, timeoutMs }) =>
      safeTool(() => getJobLogs({ runId, stream, maxBytes }, jobOperationOptionsFromEnv(timeoutMs)))
  ),
  defineTool(
    "jobs.adopt",
    {
      title: "Adopt an external job",
      annotations: ANNOTATIONS_EFFECTFUL_REMOTE,
      description:
        "Onboard an externally-started job into local run history. For a UTS HPC PBS profile, fetches qstat -x -f over SSH for the given remoteJobId. For a UTS iHPC profile, records the supplied node+pid as a not-lineage-proven OBSERVE entry (a foreign job we only observed): jobs.status reports its recorded pid's liveness + the node's GPU snapshot (read-only observe path), while jobs.logs/jobs.cancel stay observe-only (no supervisor log/cancel path; cancel on the node directly). Jobs OUR progressor launched from OUR PLAN are instead adopted lineage-proven (real supervisor, agent_authored execution facts, full read/cancel) automatically via campaign reconciliation on jobs.track — not through this manual entry point. Idempotent on the run_id + remote_job_id pair; refuses to overwrite an existing run with a conflicting remote_job_id.",
      inputSchema: strictInput({
        runId: RUN_ID,
        profileId: PROFILE_ID,
        remoteJobId: z.string().optional(),
        node: z.string().optional(),
        pid: z.number().int().nonnegative().optional(),
        gpuIndex: z.number().int().nonnegative().optional(),
        hostname: z.string().optional(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, profileId, remoteJobId, node, pid, gpuIndex, hostname, timeoutMs }) =>
      safeTool(() =>
        adoptExternalRun(
          { runId, profileId, remoteJobId, node, pid, gpuIndex, hostname, timeoutMs },
          jobOperationOptionsFromEnv(timeoutMs)
        )
      )
  ),
  defineTool(
    "jobs.cancel",
    {
      title: "Cancel a job",
      annotations: ANNOTATIONS_DESTRUCTIVE_REMOTE,
      description:
        "Cancel one submitted UTS HPC PBS job or UTS iHPC supervised run after consuming a matching jobs.cancel approval record.",
      inputSchema: strictInput({
        runId: RUN_ID,
        approvalId: APPROVAL_ID,
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, approvalId, timeoutMs }) =>
      safeTool(() => cancelJob({ runId, approvalId }, jobOperationOptionsFromEnv(timeoutMs)))
  ),
  defineTool(
    "jobs.history",
    {
      title: "List job history",
      annotations: READ_LOCAL,
      description:
        "List a read-only summary across saved local run records (newest first) with optional profileId, platform, status, and since filters. Local state only; no SSH or remote calls. Returns compact per-run fields, not events, commands, or paths.",
      inputSchema: strictInput({
        profileId: PROFILE_ID.optional(),
        platform: PLATFORM_ENUM.optional(),
        status: z.enum(["planned", "submitted", "running", "finished", "failed", "cancelled", "unknown", "stale"]).optional(),
        project: z.string().optional(),
        since: z
          .string()
          .regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{3})?Z$/, "since must be an ISO-8601 UTC datetime like 2026-06-05T00:00:00.000Z")
          .optional(),
        limit: z.number().int().min(1).max(500).optional()
      })
    },
    async (input) => safeTool(() => jobsHistory(input))
  ),
  defineTool(
    "jobs.rightsize",
    {
      title: "Advise resource right-sizing",
      annotations: READ_LOCAL,
      description:
        "Read-only resource right-sizing advisor for a project: compare what its runs REQUESTED against what they actually USED (persisted run-record usage) and recommend a saner memory / walltime request, plus median CPU efficiency. Flags 10x-over-requests that waste a fixed allocation. Local state only; no SSH. Needs some finished runs with observed usage first (run jobs.status on them).",
      inputSchema: strictInput({
        project: z.string(),
        profileId: PROFILE_ID.optional()
      })
    },
    async (input) => safeTool(() => jobsRightsize(input))
  ),
  defineTool(
    "projects.list",
    {
      title: "List projects",
      annotations: READ_LOCAL,
      description:
        "List a read-only per-project rollup across saved local run records. Each project (the git-derived grouping captured at plan time) is returned with its deterministic project_hash, total and active run counts, a status breakdown, the profiles and platforms it spans, and its last-updated time, most-active first. Local state only; no SSH or remote calls. Optional platform / profileId filters.",
      inputSchema: strictInput({
        platform: PLATFORM_ENUM.optional(),
        profileId: PROFILE_ID.optional()
      })
    },
    async (input) => safeTool(() => listProjects(input))
  ),
  defineTool(
    "campaign.status",
    {
      title: "Disclose a campaign's allocations",
      annotations: READ_LOCAL,
      description:
        "Read-only campaign ledger: for one campaign_id, disclose which owner's allocation contributed which runs (per-account run counts, status breakdown, last-updated, and any operator fair-use attestation). This is DISCLOSURE/attribution for audit — a campaign may legitimately span different owners' allocations; it never sums usage across accounts and never computes a cap. Local state only (a derived rollup over saved run records); no SSH. Platform-neutral.",
      inputSchema: strictInput({
        campaignId: z.string()
      })
    },
    async ({ campaignId }) => safeTool(() => campaignStatus({ campaignId }))
  ),
  defineTool(
    "campaign.audit",
    {
      title: "Audit a campaign's accounts vs their own caps",
      annotations: READ_LOCAL,
      description:
        "Read-only fair-use audit of a campaign: discloses its per-owner allocations and, for each account, composes a verdict against that account's OWN latest quota snapshot to FLAG any account already over its own cap (iHPC node-pool or PBS per-user run cap). ENFORCEMENT + DISCLOSURE — it checks each account against its own caps only, NEVER sums across accounts, and never excuses an over-cap account (it surfaces it). An account with no snapshot is noted, not assumed within cap. Local state only; no SSH. Platform-neutral.",
      inputSchema: strictInput({
        campaignId: z.string()
      })
    },
    async ({ campaignId }) => safeTool(() => campaignAudit({ campaignId }))
  ),
  defineTool(
    "campaign.submit",
    {
      title: "Launch a campaign's planned iHPC runs",
      annotations: ANNOTATIONS_SUBMIT,
      description:
        "Autonomous, conformance-gated launch of one iHPC campaign: select the campaign's planned runs, " +
        "read the per-node single-writer lease from the node STATE (a live other holder => lease-blocked, " +
        "never clobbered), GATE on the HARD per-account iHPC node-pool cap using a REQUIRED fresh quota " +
        "snapshot's held-nodes evidence (the ban-prevention; never sums across accounts), build the " +
        "immutable PLAN bounded by the node's real GPU count, then over SSH write the PLAN and start the " +
        "resident progressor once for the node — the brain decides, the node executes. NO approval token " +
        "(ADR-0004, like jobs.submit): conformance is the gate, so a fresh quotaSnapshotId is REQUIRED. " +
        "Returns the outcome in-band under `campaign` ({ ok:true, launched, plan_queue_id, run_ids } on " +
        "success, or { ok:false, reason } for no-planned-runs / lease-blocked / conformance-failed / launch-failed).",
      inputSchema: strictInput({
        campaignId: z.string(),
        profileId: PROFILE_ID,
        node: z.string(),
        // REQUIRED: a fresh quotas.refresh snapshot id for this profile — supplies the account's real
        // held-nodes evidence the ban-critical node-pool conformance gate consumes.
        quotaSnapshotId: z.string(),
        // Per-node GPU placement cap. Bounded at the realistic per-node GPU ceiling (one job per GPU
        // index); campaign.submit further clamps it to the profile's node_gpu_count so it never plans
        // jobs onto GPU indices the node does not have.
        maxConcurrent: z.number().int().min(1).max(16).optional(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ campaignId, profileId, node, maxConcurrent, quotaSnapshotId, timeoutMs }) =>
      safeTool(() => campaignStart({ campaignId, profileId, node, maxConcurrent, quotaSnapshotId, timeoutMs }))
  ),
  defineTool(
    "artifacts.list",
    {
      title: "List run artifacts",
      annotations: READ_REMOTE,
      description:
        "List planned run artifacts through a fixed read-only helper using saved plan outputs; writes a local artifact manifest for later fetch by artifactId.",
      inputSchema: strictInput({
        runId: RUN_ID,
        maxEntries: z.number().int().min(1).max(2000).optional(),
        checksumMaxBytes: artifactBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, maxEntries, checksumMaxBytes, timeoutMs }) =>
      safeTool(() => listArtifacts({ runId, maxEntries, checksumMaxBytes }, { timeoutMs }))
  ),
  defineTool(
    "artifacts.fetch",
    {
      title: "Fetch one artifact",
      annotations: ANNOTATIONS_EFFECTFUL_REMOTE,
      description:
        "Fetch one file artifact by artifactId from the latest artifacts.list manifest. Runs autonomously gated by the verified plan_hash, manifest binding, byte cap, and SHA-256 verification; an artifacts.fetch approvalId is accepted but not required.",
      inputSchema: strictInput({
        runId: RUN_ID,
        artifactId: z.string(),
        approvalId: APPROVAL_ID.optional(),
        maxBytes: artifactBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, artifactId, approvalId, maxBytes, timeoutMs }) =>
      safeTool(() => fetchArtifact({ runId, artifactId, approvalId, maxBytes }, { timeoutMs }))
  ),
  defineTool(
    "artifacts.fetch.batch",
    {
      title: "Fetch artifacts (batch)",
      annotations: ANNOTATIONS_EFFECTFUL_REMOTE,
      description:
        "Fetch multiple file artifacts by explicit manifest artifactIds. Runs autonomously gated by the manifest hash binding, per-file and total byte caps, and SHA-256 verification; an artifacts.fetch.batch approvalId is accepted but not required.",
      inputSchema: strictInput({
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        artifactIds: artifactIdsField(),
        approvalId: APPROVAL_ID.optional(),
        maxBytesPerFile: artifactBytesField(),
        maxTotalBytes: artifactBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, manifestHash, artifactIds, approvalId, maxBytesPerFile, maxTotalBytes, timeoutMs }) =>
      safeTool(() => fetchArtifactsBatch({ runId, manifestHash, artifactIds, approvalId, maxBytesPerFile, maxTotalBytes }, { timeoutMs }))
  ),
  defineTool(
    "artifacts.summarize",
    {
      title: "Summarize fetched or confined-remote artifacts",
      annotations: READ_REMOTE,
      description:
        "Summarize artifacts and extract bounded metrics from allowlisted JSON, JSONL, NDJSON, CSV, and TSV files. Default source=\"local\" reads only files already fetched into local state (no remote access). Opt-in source=\"remote\" reads ONE allowlisted metric file from a confined remotePath (absolute, inside the profile's declared workspace/scratch/project root) over the existing bounded read-only SSH seam, applies the same parse/desecret/summarize logic, and records remote-sourced provenance. Remote mode runs NO arbitrary cluster-side command — only a fixed, byte-bounded remote file read.",
      inputSchema: strictInput({
        runId: RUN_ID,
        source: z.enum(["local", "remote"]).optional().describe("Byte source: \"local\" (default) summarizes fetched files; \"remote\" reads one confined metric file over SSH."),
        remotePath: z
          .string()
          .optional()
          .describe("Required when source=\"remote\": absolute remote path to a single allowlisted metric file, inside the profile workspace/scratch/project root."),
        // M1: bounded at the 1 MB metric-file ceiling the remote read actually enforces, so the
        // advertised range equals the enforced one (the shared 50 MB artifact field would over-promise).
        maxBytes: metricSummaryBytesField(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, source, remotePath, maxBytes, timeoutMs }) =>
      safeTool(() => {
        if (source === "remote") {
          if (!remotePath) {
            throw new Error("artifacts.summarize source=\"remote\" requires remotePath");
          }
          return summarizeRemoteArtifact({ runId, remotePath, maxBytes }, { timeoutMs });
        }
        return summarizeArtifacts({ runId });
      })
  ),
  defineTool(
    "artifacts.cleanup.plan",
    {
      title: "Plan artifact cleanup (dry-run)",
      annotations: READ_LOCAL,
      description: "Create a dry-run cleanup plan for declared remote outputs and local fetched artifact cache without deleting anything.",
      inputSchema: strictInput({
        runId: RUN_ID
      })
    },
    async ({ runId }) => safeTool(() => planArtifactCleanup({ runId }))
  ),
  defineTool(
    "artifacts.cleanup.execute",
    {
      title: "Delete artifacts",
      annotations: ANNOTATIONS_DESTRUCTIVE_REMOTE,
      description:
        "Delete explicit regular-file artifacts from the latest manifest after consuming a matching artifacts.cleanup.execute approval. Does not accept paths, globs, hosts, shell commands, or recursive directory deletion.",
      inputSchema: strictInput({
        runId: RUN_ID,
        manifestHash: MANIFEST_HASH,
        artifactIds: artifactIdsField(),
        approvalId: APPROVAL_ID,
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ runId, manifestHash, artifactIds, approvalId, timeoutMs }) =>
      safeTool(() => executeArtifactCleanup({ runId, manifestHash, artifactIds, approvalId }, { timeoutMs }))
  ),
  defineTool(
    "transfers.plan",
    {
      title: "Plan a transfer (dry-run)",
      annotations: READ_LOCAL,
      description:
        "Validate a local transfer plan and render an rsync dry-run script without running rsync or contacting UTS systems.",
      inputSchema: strictInput({
        transferPlan: jsonObjectField(
          "A TransferPlan object — strictly validated against schemas/transfer-plan.schema.json (additionalProperties:false). Required: run_id, profile_id, direction ('upload'|'download'), source, destination. Optional: files (explicit list), max_total_bytes (byte cap). Fixed-file rsync only — no directory recursion."
        )
      })
    },
    async ({ transferPlan }) => safeTool(() => ({ plan: planTransfer(transferPlan) }))
  ),
  defineTool(
    "transfers.execute",
    {
      title: "Execute a transfer",
      annotations: ANNOTATIONS_DESTRUCTIVE_REMOTE,
      description:
        "Execute one saved fixed-file rsync transfer plan. Runs autonomously gated by the saved plan_hash, fixed file list, byte cap, and checksum verification; a transfers.execute approvalId is accepted but not required.",
      inputSchema: strictInput({
        runId: RUN_ID,
        approvalId: APPROVAL_ID.optional(),
        timeoutMs: timeoutMsField(TIMEOUT_MS_TRANSFER)
      })
    },
    async ({ runId, approvalId, timeoutMs }) => safeTool(() => executeTransfer({ runId, approvalId, timeoutMs }))
  ),
  defineTool(
    "state.migrate.plan",
    {
      title: "Plan state migration (dry-run)",
      annotations: READ_LOCAL,
      description:
        "Inspect local .uts-computing state and return a schema-version migration dry-run report without writing files or contacting UTS systems.",
      inputSchema: EMPTY_INPUT_SCHEMA
    },
    async () => safeTool(() => planStateMigration())
  ),
  defineTool(
    "state.migrate.apply",
    {
      title: "Apply state migration",
      annotations: ANNOTATIONS_DESTRUCTIVE_LOCAL,
      description:
        "Apply the additive local schema-version migration after trusted confirmation, backing up each changed .uts-computing state file before writing.",
      inputSchema: strictInput({
        planHash: PLAN_HASH,
        confirmationToken: z.string()
      })
    },
    async ({ planHash, confirmationToken }) => safeTool(() => applyStateMigration({ planHash, confirmationToken }))
  ),
  defineTool(
    "sweep.plan",
    {
      title: "Plan a hyperparameter sweep (dry-run)",
      annotations: READ_LOCAL,
      description:
        "Expand a declared hyperparameter grid into a single PBS array job plan (one plan_hash) plus the deterministic index->params table. Each array element selects its params via an inline case on $PBS_ARRAY_INDEX built from the base command's {placeholders}; values are safety-validated. A campaignId is REQUIRED (the fan-out operator must declare campaign identity for the spawned runs; it lands on the run record for attribution, never on plan_hash). Pass a fresh snapshotId to cap max_concurrent to the queue's live per-user run headroom (quotas.capacity). Dry-run only; no SSH or remote side effects. UTS HPC CPU array jobs only.",
      inputSchema: strictInput({
        jobSpec: jsonObjectField(
          "The base JobSpec for the sweep — strictly validated against schemas/job-spec.schema.json. Required: run_id, profile_id, platform, experiment, command (with the {placeholders} the grid fills), resources{queue, ncpus, memory_gb, walltime}."
        ),
        parameters: sweepParametersField(),
        method: z.enum(["grid"]).optional(),
        maxConcurrent: z.number().int().min(1).max(1000).optional(),
        snapshotId: QUOTA_SNAPSHOT_ID.optional(),
        // REQUIRED: the fan-out operator must declare the campaign identity for the runs this sweep
        // spawns (DISCLOSURE/attribution). Lands on each run record, never on plan_hash or JobSpec.
        campaignId: z.string()
      })
    },
    async ({ jobSpec, parameters, method, maxConcurrent, snapshotId, campaignId }) =>
      safeTool(() => planSweep({ jobSpec, parameters, method, maxConcurrent, snapshotId, campaignId }))
  ),
  defineTool(
    "sweep.rank",
    {
      title: "Rank sweep results",
      annotations: READ_LOCAL,
      description:
        "Read-only sweep ranking advisor: join each finished array member's metric value (supplied from artifacts.summarize) back to its config via the original parameters grid, rank by the metric (min/max), and return the top-k winning configs so you can propose a higher-budget follow-up rung (manual successive-halving). Pure/local; never cancels or resubmits anything.",
      inputSchema: strictInput({
        parameters: sweepParametersField(),
        results: z.array(z.object({ index: z.number().int().min(0), value: z.number() })).min(1),
        mode: z.enum(["min", "max"]).optional(),
        topK: z.number().int().min(1).max(256).optional()
      })
    },
    async ({ parameters, results, mode, topK }) => safeTool(() => ({ rank: rankSweep({ parameters, results, mode, topK }) }))
  ),
  defineTool(
    "sweep.retry.plan",
    {
      title: "Re-plan a sweep's failed members (dry-run)",
      annotations: READ_LOCAL,
      description:
        "Re-plan ONLY the failed array members of a finished sweep into a new, smaller PBS array job (new run_id, new plan_hash, sweep_retry_of lineage) so you can re-submit a compacted retry through the existing autonomous, conformance-gated jobs.submit — turning O(failures) round-trips into one re-plan. Pass the original parameters grid plus failedIndices (the index->params table is not persisted, so the grid must match the source run, like sweep.rank); the failed indices are compacted to [0..n-1] and returned as an index_map. Dry-run only: no SSH, no source-run mutation, no auto-submit or orchestration. UTS HPC CPU sweeps only.",
      inputSchema: strictInput({
        sourceRunId: RUN_ID,
        retryRunId: RUN_ID,
        parameters: sweepParametersField(),
        failedIndices: z.array(z.number().int().min(0)).min(1).max(256),
        maxConcurrent: z.number().int().min(1).max(1000).optional(),
        reason: z.string().optional()
      })
    },
    async ({ sourceRunId, retryRunId, parameters, failedIndices, maxConcurrent, reason }) =>
      safeTool(() => planRetrySweep({ sourceRunId, retryRunId, parameters, failedIndices, maxConcurrent, reason }))
  ),
  defineTool(
    "ihpc.campaign.preflight",
    {
      title: "Pre-flight an iHPC campaign queue YAML",
      // openWorldHint:true because the OPT-IN canary (profileId+node) SSHes to a compute node. It stays
      // readOnlyHint:true / destructiveHint:false — the canary is a pure GPU/CUDA probe, never a mutation.
      // The DEFAULT (no profileId/node) remains pure-local and contacts nothing.
      annotations: READ_REMOTE,
      description:
        "Read-only: validate a scheduler queue YAML before launch. Supply EXACTLY ONE of queueYaml (a " +
        "pre-parsed object) or queueYamlPath (a confined local path to an operator's existing hand-written " +
        "queue YAML, read + parsed here; relative paths resolve against the project root and traversal " +
        "outside it is rejected). By DEFAULT it is PURE-LOCAL (no SSH, no GPU probing): checks structure " +
        "(my_nodes>=1; experiments>=1, each name/command/requires_gpu), each experiment's --dataset " +
        "<token> against a caller-supplied datasetDirs allowlist (exact, case-sensitive: MovieLens != ML; " +
        "skipped when datasetDirs is omitted), and the embedded --param_overrides '{...}' JSON (optionally " +
        "Ajv-checked against parameterSpace). " +
        "OPT-IN on-node canary: when you ALSO pass BOTH profileId (a uts-ihpc profile) AND node, it " +
        "SSHes to that node before launch and probes the GPU(s) — GPU presence/count (nvidia-smi), " +
        "per-GPU busy, and CUDA usability (torch.cuda.is_available) — appending canary findings " +
        "(codes: gpu-unavailable / cuda-unavailable / cuda-unverified / gpu-busy / node-unverifiable; an " +
        "unverifiable node FAILS CLOSED to an error, never 'healthy'). SSH happens ONLY when both " +
        "profileId and node are given; omit them for the byte-identical pure-local check. " +
        "Returns findings ({level,code?,path,message,suggestion?}); valid is true when none are errors.",
      inputSchema: strictInput({
        queueYaml: jsonObjectField(
          "The parsed queue config (my_nodes + experiments). Provide this OR queueYamlPath, not both."
        ).optional(),
        queueYamlPath: z
          .string()
          .optional()
          .describe(
            "Confined local path to an existing queue YAML to read + validate (relative to the project root; traversal outside it is rejected). Provide this OR queueYaml, not both."
          ),
        datasetDirs: z.array(z.string()).optional(),
        parameterSpace: jsonObjectField().optional(),
        // OPT-IN node canary: both required together to trigger the SSH probe; absent => pure-local.
        profileId: PROFILE_ID.optional().describe(
          "Opt-in node canary: a uts-ihpc profile whose login gateway reaches the node. Required together with `node` to SSH-probe the node's GPU/CUDA before launch; omit for a pure-local check."
        ),
        node: z
          .string()
          .optional()
          .describe(
            "Opt-in node canary: the iHPC compute node to probe (e.g. \"mars01\"). Required together with `profileId`; omit for a pure-local check."
          ),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ queueYaml, queueYamlPath, datasetDirs, parameterSpace, profileId, node, timeoutMs }) =>
      safeTool(() =>
        runIhpcPreflight({ queueYaml, queueYamlPath, datasetDirs, parameterSpace, profileId, node, timeoutMs })
      )
  ),
  defineTool(
    "ihpc.campaign.generate",
    {
      title: "Generate an iHPC campaign queue YAML (dry-run, preflight-clean)",
      // Pure-local, deterministic, no SSH — same class as jobs.plan / sweep.plan.
      annotations: READ_LOCAL,
      description:
        "Read-only, PURE-LOCAL, dry-run: emit a canonical scheduler queue YAML (my_nodes + experiments) " +
        "from structured inputs — the GENERATE counterpart to ihpc.campaign.preflight, so the plugin owns " +
        "the ihpc-sched queue format end-to-end (generate -> preflight -> campaign.submit) instead of " +
        "operators hand-writing queue.*.yaml. COUPLED to preflight: it runs the SAME validateQueueContract " +
        "internally and REFUSES to emit (errors out) if any error-level finding would fire, so a generated " +
        "file is preflight-clean by construction (a --dataset not in datasetDirs, a malformed " +
        "--param_overrides JSON, or empty my_nodes/experiments are all rejected here). No SSH, no GPU " +
        "probing, no state mutation; deterministic output. Returns the canonical YAML text, the parsed " +
        "queue object, the coupled preflight verdict (valid + findings), and a sha256 content_hash of the " +
        "emitted YAML.",
      inputSchema: strictInput({
        myNodes: z
          .array(
            z.union([
              z.string(),
              z
                .object({
                  hostname: z.string(),
                  gpus: z.array(z.number().int().min(0)).optional(),
                  block_gpus: z.array(z.number().int().min(0)).optional()
                })
                .strict()
            ])
          )
          .min(1)
          .describe(
            "Nodes the scheduler may use: a bare hostname string, or { hostname, gpus?, block_gpus? } to pin/exclude GPU indices. Must be non-empty (preflight requires my_nodes>=1)."
          ),
        experiments: z
          .array(
            z
              .object({
                name: z.string().min(1),
                command: z.string().min(1),
                requires_gpu: z.boolean()
              })
              .strict()
          )
          .min(1)
          .describe(
            "The experiments to run: each { name, command, requires_gpu }. The command is emitted verbatim (it is NOT executed here). Must be non-empty."
          ),
        datasetDirs: z
          .array(z.string())
          .optional()
          .describe(
            "Optional allowlist of locally-present dataset directory names. When supplied, each command's --dataset <token> is checked at generate time (exact, case-sensitive); a miss refuses generation."
          ),
        parameterSpace: jsonObjectField(
          "Optional JSON Schema for the embedded --param_overrides object; violations refuse generation."
        ).optional(),
        scheduler: jsonObjectField(
          "Optional queue-local scheduler overrides (slots_per_gpu, gpu_free_threshold_pct, ...), emitted verbatim."
        ).optional()
      })
    },
    async ({ myNodes, experiments, datasetDirs, parameterSpace, scheduler }) =>
      safeTool(() => generateCampaignQueue({ myNodes, experiments, datasetDirs, parameterSpace, scheduler }))
  ),
  defineTool(
    "ihpc.node.usage",
    {
      title: "Read live per-GPU usage on an iHPC node",
      // openWorldHint:true because it ALWAYS SSHes to the named node (the canary two-hop seam). It is
      // readOnlyHint:true / destructiveHint:false — a pure nvidia-smi read, never a mutation.
      annotations: READ_REMOTE,
      description:
        "Read-only, one-shot live GPU view for an iHPC compute node — see current per-GPU utilization " +
        "and memory WITHOUT bare SSH. It SSHes to the node (the same two-hop seam the campaign canary " +
        "uses) and runs a single fixed `nvidia-smi` query, returning each GPU's index, name, " +
        "utilization (%), and memory used/total (MiB) plus a probed_at timestamp. NOT a daemon and NOT " +
        "continuous telemetry — one probe per call. Requires a reachable node and a uts-ihpc profile " +
        "whose login gateway reaches it. FAILS CLOSED: if the node is unreachable or nvidia-smi is " +
        "absent/failing, it returns status \"node-unverifiable\" with an empty gpus[] — it never " +
        "fabricates a reading.",
      inputSchema: strictInput({
        profileId: PROFILE_ID.describe("uts-ihpc profile whose login gateway reaches the node."),
        node: z
          .string()
          .describe("The iHPC compute node to probe (e.g. \"mars01\")."),
        timeoutMs: timeoutMsField(TIMEOUT_MS_STANDARD)
      })
    },
    async ({ profileId, node, timeoutMs }) => safeTool(() => runIhpcNodeUsage({ profileId, node, timeoutMs }))
  )
];

for (const registerTool of TOOLS) {
  registerTool(server);
}

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

// Only start the stdio server when this module is executed directly (e.g. `node dist/index.js`).
// Tests import named symbols (safeTool) from this module and must NOT spin up a transport on import.
// Compare REALPATHS: node resolves symlinks for import.meta.url but not for process.argv[1], so a
// symlinked launch path (macOS /var->/private/var temp dirs, a symlinked .mcpb/install dir) would
// otherwise make this false and the server would exit 0 without ever connecting a transport.
const isEntryPoint =
  process.argv[1] !== undefined && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href;
if (isEntryPoint) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    console.error(message);
    process.exit(1);
  });
}
