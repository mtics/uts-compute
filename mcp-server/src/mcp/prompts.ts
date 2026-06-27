import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { completable } from "@modelcontextprotocol/sdk/server/completable.js";
import { z } from "zod";
import { PLATFORM_HINT_ENUM } from "./schemas.js";

const NO_DIRECT_COMMANDS =
  "Do not use direct shell, SSH, PBS, iHPC, rsync, curl, VPN probes, or hand edits to runtime state files as substitutes for MCP tools. One carve-out: first-run PROVISIONING (cloning the experiment repo, creating a Python env, staging a dataset directory onto a clean node) is out of plugin scope — doing it manually over SSH once is a permitted prerequisite, not a tool you are routing around. See docs/accounts-and-safety.md.";
const REDACTED_PROMPT_INPUT = "<redacted-prompt-input>";

// Prompt-argument autocompleters are injected by the server wiring so this module stays pure —
// it never imports state/action modules (config, audit, ...). Implementations live in index.ts.
export interface PromptCompleters {
  profileId: (value: string | undefined) => string[];
  runId: (value: string | undefined) => string[];
}

export function registerUtsPrompts(server: McpServer, completers: PromptCompleters): void {
  server.registerPrompt(
    "plan-experiment",
    {
      title: "Plan UTS Experiment",
      description: "Guide a safe UTS HPC/iHPC experiment plan before any live compute action.",
      argsSchema: {
        goal: z.string().min(1).max(500).optional(),
        platform: PLATFORM_HINT_ENUM.optional(),
        profileId: completable(z.string().min(1).max(120).optional(), completers.profileId),
        intent: z.enum(["dry-run", "prepare-live-submission"]).optional()
      }
    },
    ({ goal, platform = "auto", profileId, intent = "dry-run" }) => ({
      description: "Safe planning workflow for UTS HPC or UTS iHPC experiments.",
      messages: [
        userPrompt([
          "Use the UTS experiment-planning Skills and the shared MCP server to prepare an experiment plan.",
          `Goal: ${safePromptValue(goal, "<ask the user for the experiment goal>")}`,
          `Preferred platform: ${platform}`,
          `Profile hint: ${safePromptValue(profileId, "<select exactly one profile after profiles.list>")}`,
          `Intent: ${intent}`,
          "",
          "Workflow:",
          "1. Use the relevant Skill: plan-experiment, then select-profile, then platform-specific Skill if needed.",
          "2. Call profiles.list and choose exactly one profile_id; do not combine accounts or quotas.",
          "3. Use docs.search or existing uts://docs resources for local policy context.",
          "4. For live preparation, call access.check and quotas.refresh for the selected profile before any approval or submission.",
          "5. Call jobs.plan first and inspect plan_hash, warnings, resources, workdir, outputs, and approval reasons.",
          "6. If live submission is needed, request operation-specific approval through approvals.request; never self-approve.",
          "7. Stop before jobs.submit unless the user has supplied a trusted approval decision and the quota snapshot is fresh.",
          "",
          NO_DIRECT_COMMANDS
        ])
      ]
    })
  );

  server.registerPrompt(
    "triage-run",
    {
      title: "Triage UTS Run",
      description: "Guide diagnosis, logs, retry, or cancellation for one recorded UTS run.",
      argsSchema: {
        runId: completable(z.string().min(1).max(120), completers.runId),
        symptom: z.string().min(1).max(500).optional(),
        desiredOutcome: z.enum(["diagnose", "logs", "retry-review", "cancel-review"]).optional()
      }
    },
    ({ runId, symptom, desiredOutcome = "diagnose" }) => ({
      description: "Safe monitoring and recovery workflow for a recorded UTS run.",
      messages: [
        userPrompt([
          "Use the monitor-and-recover Skill to diagnose one recorded UTS run.",
          `Run id: ${safePromptValue(runId)}`,
          `Symptom: ${safePromptValue(symptom, "<inspect local state and ask for missing symptom details if needed>")}`,
          `Desired outcome: ${desiredOutcome}`,
          "",
          "Workflow:",
          "1. Read uts://run-records and uts://run-records/{runId}; confirm the run id exists before taking action.",
          "2. Read the latest local quota snapshot resource for the profile if available; refresh quotas only when live state is needed.",
          "3. Use jobs.status for submitted/running jobs, then jobs.logs with bounded maxBytes if logs are needed.",
          "4. For failed runs, prefer jobs.retry.plan; cancelled runs require an explicit reason.",
          "5. For cancellation, require operation-specific approval through approvals.request with operation jobs.cancel and a trusted approvals.decide before jobs.cancel.",
          "6. For artifact questions, use artifacts.list before any approved fetch; do not browse arbitrary remote paths.",
          "",
          NO_DIRECT_COMMANDS
        ])
      ]
    })
  );

  server.registerPrompt(
    "collect-artifacts",
    {
      title: "Collect UTS Artifacts",
      description: "Guide manifest-based artifact collection and local metric summarization.",
      argsSchema: {
        runId: completable(z.string().min(1).max(120), completers.runId),
        purpose: z.enum(["inspect-outputs", "summarize-metrics", "prepare-report"]).optional()
      }
    },
    ({ runId, purpose = "summarize-metrics" }) => ({
      description: "Safe artifact collection workflow for one recorded UTS run.",
      messages: [
        userPrompt([
          "Use the analyze-artifacts Skill to collect and summarize declared run outputs.",
          `Run id: ${safePromptValue(runId)}`,
          `Purpose: ${purpose}`,
          "",
          "Workflow:",
          "1. Read the run record and saved plan context before touching artifacts.",
          "2. Call artifacts.list to create or refresh the manifest from saved plan outputs.",
          "3. For one file, use artifacts.fetch only with a matching artifacts.fetch approval.",
          "4. For several files, use artifacts.fetch.batch only with explicit manifest artifact ids, manifest_hash, and total byte bounds.",
          "5. After files are already local, call artifacts.summarize for bounded metric-like JSON/JSONL/NDJSON/CSV/TSV summaries.",
          "6. Use artifacts.cleanup.plan only as a dry-run cleanup inventory.",
          "7. If the user explicitly asks to delete artifacts, use artifacts.cleanup.execute only for terminal runs with the latest manifest_hash, explicit artifact ids, captured SHA-256 and size evidence, and a matching unlink-regular-files-only cleanup approval.",
          "",
          NO_DIRECT_COMMANDS
        ])
      ]
    })
  );

  server.registerPrompt(
    "stage-transfer",
    {
      title: "Stage UTS Transfer",
      description: "Guide fixed-file upload/download transfer planning without arbitrary rsync behavior.",
      argsSchema: {
        profileId: completable(z.string().min(1).max(120).optional(), completers.profileId),
        runId: completable(z.string().min(1).max(120).optional(), completers.runId),
        direction: z.enum(["upload-to-uts", "download-from-uts"]).optional(),
        purpose: z.string().min(1).max(500).optional()
      }
    },
    ({ profileId, runId, direction, purpose }) => ({
      description: "Safe fixed-file transfer workflow for UTS staging or result download.",
      messages: [
        userPrompt([
          "Use the stage-transfer Skill to plan a fixed-file transfer.",
          `Profile hint: ${safePromptValue(profileId, "<select exactly one profile after profiles.list>")}`,
          `Run id: ${safePromptValue(runId, "<optional; use when transferring outputs tied to a run>")}`,
          `Direction: ${direction ?? "<ask whether this is upload-to-uts or download-from-uts>"}`,
          `Purpose: ${safePromptValue(purpose, "<ask for transfer purpose and expected files>")}`,
          "",
          "Workflow:",
          "1. Select exactly one profile_id; do not combine accounts or quota pools.",
          "2. Require an explicit fixed file list and max_total_bytes before transfer execution.",
          "3. Call transfers.plan first and inspect plan_hash, direction, files, source, destination policy, and warnings.",
          "4. For execution, request operation-specific transfers.execute approval whose resource_summary matches the saved plan.",
          "5. Call transfers.execute only after trusted approval; do not widen scope at execution time.",
          "6. Report checksum_status and SHA-256 evidence when present; describe skipped-large files as not content-hash verified.",
          "",
          "Do not generate rsync flags, SSH options, globs, filters, --delete, --remove-source-files, arbitrary checksum commands, arbitrary local destinations, or broad directory recursion.",
          NO_DIRECT_COMMANDS
        ])
      ]
    })
  );

  server.registerPrompt(
    "client-smoke-evidence",
    {
      title: "Collect Client Smoke Evidence",
      description: "Guide real Codex/Claude Code installed-client smoke evidence collection.",
      argsSchema: {
        client: z.enum(["codex", "claude-code"])
      }
    },
    ({ client }) => ({
      description: "Manual installed-client smoke evidence workflow.",
      messages: [
        userPrompt([
          "Collect client-installed smoke evidence for the real plugin host.",
          `Client: ${client}`,
          "",
          "Workflow:",
          "1. Use npm run client-smoke:prompt to get the fixed evidence template if it is not already available.",
          "2. Confirm the UTS Skills are discoverable inside this installed client.",
          "3. Confirm MCP tools/resources are visible through the installed plugin, not direct SDK smoke output.",
          "4. Run only the safe checks: profiles.list, templates.list, docs context, state.migrate.plan, and dry-run jobs.plan.",
          "5. Fill one evidence JSON file with observed non-placeholder hashes and a client-smoke-* run id.",
          "6. Validate both Codex and Claude Code evidence files with client-smoke:validate -- --require-both.",
          "",
          "Do not call access.check, quotas.refresh, docs.refresh, jobs.submit, jobs.status, jobs.logs, jobs.cancel, artifacts.fetch, artifacts.cleanup.execute, transfers.execute, state.migrate.apply, or approvals.decide during this smoke.",
          NO_DIRECT_COMMANDS
        ])
      ]
    })
  );
}

function userPrompt(lines: string[]) {
  return {
    role: "user" as const,
    content: {
      type: "text" as const,
      text: lines.join("\n")
    }
  };
}

function safePromptValue(value: string | undefined, fallback = "<not provided>"): string {
  if (value === undefined || value.length === 0) {
    return fallback;
  }
  const normalized = value.replace(/\s+/g, " ").trim().slice(0, 500);
  if (isSensitivePromptInput(normalized)) {
    return REDACTED_PROMPT_INPUT;
  }
  return normalized;
}

function isSensitivePromptInput(value: string): boolean {
  return [
    /profiles\.local\.ya?ml/i,
    /(^|\s)(\/Users\/|\/home\/[^/\s]+\/|[A-Za-z]:\\|~\/|\.\.\/)/,
    /(^|\/)\.ssh(\/|$)/i,
    /UTS_COMPUTING_APPROVAL_TOKEN|confirmationToken/i,
    /BEGIN (OPENSSH|RSA|DSA|EC|PRIVATE) KEY/i,
    /(password|passwd|api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|secret|bearer|mfa|otp)\s*[:=]/i
  ].some((pattern) => pattern.test(value));
}
