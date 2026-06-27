#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  REQUIRED_CLIENTS,
  REQUIRED_RESOURCES,
  REQUIRED_SKILLS,
  REQUIRED_TEMPLATES,
  REQUIRED_TOOLS
} from "./validate-client-smoke-evidence.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8"));

export function buildClientSmokePromptBundle(options = {}) {
  const clients = options.client ? [normalizeClient(options.client)] : REQUIRED_CLIENTS;
  return {
    ok: true,
    mode: "prompt-only",
    generated_at: new Date().toISOString(),
    purpose: "Manual release-gate smoke evidence for real Codex and Claude Code plugin hosts.",
    schema: "schemas/client-smoke-evidence.schema.json",
    validator_command:
      "node scripts/validate-client-smoke-evidence.mjs --require-both evidence/codex.json evidence/claude-code.json",
    required: {
      clients: REQUIRED_CLIENTS,
      skills: REQUIRED_SKILLS,
      tools: REQUIRED_TOOLS,
      resources: REQUIRED_RESOURCES,
      templates: REQUIRED_TEMPLATES
    },
    forbidden: [
      "Do not call access.check, quotas.refresh, docs.refresh, jobs.submit, jobs.status, jobs.logs, jobs.cancel, artifacts.fetch, artifacts.fetch.batch, artifacts.cleanup.execute, transfers.execute, or state.migrate.apply.",
      "Do not run VPN probes, SSH, PBS, iHPC, rsync, curl, or direct shell commands as substitutes for MCP tools.",
      "Do not paste real profile configuration, account identifiers, host aliases, secrets, absolute local paths, raw scripts, or fetched artifacts into evidence."
    ],
    prompts: clients.map((client) => ({
      client,
      label: client === "codex" ? "Codex" : "Claude Code",
      prompt: buildPromptText(client),
      evidence_template: buildEvidenceTemplate(client)
    }))
  };
}

function buildPromptText(client) {
  const label = client === "codex" ? "Codex" : "Claude Code";
  return [
    `You are running inside ${label} with the uts-compute plugin installed.`,
    "",
    "Goal: capture manual client-installed smoke evidence. This is a release-gate check for the real client host, not a direct MCP SDK smoke.",
    "",
    "Safe checks to perform inside this client:",
    "1. Confirm the UTS Skills are discoverable from the installed plugin.",
    "2. Confirm the MCP server is available and lists the required tools.",
    "3. Confirm the MCP resources list includes profiles, templates, and docs.",
    "4. Call profiles.list and record only the number of profiles plus redaction booleans.",
    "5. Call templates.list and record template ids only.",
    "6. Read uts://docs/schema-migration-plan, or use docs.search for schema migration plan context.",
    "7. Call state.migrate.plan and record mode, writes_planned, and plan_hash only.",
    "8. Call jobs.plan using examples/jobs/hpc-cpu.json, but change run_id to client-smoke-" +
      client +
      "-<short-id> and use a matching dry-run workdir under the example UTS workdir pattern.",
    "",
    "Forbidden during this smoke:",
    "- Do not call access.check, quotas.refresh, docs.refresh, jobs.submit, jobs.status, jobs.logs, jobs.cancel, artifacts.fetch, artifacts.fetch.batch, artifacts.cleanup.execute, transfers.execute, or state.migrate.apply.",
    "- Do not run VPN probes, SSH, PBS, iHPC, rsync, curl, or direct shell commands as substitutes for MCP tools.",
    "- Do not include real profile config, account identifiers, host aliases, secrets, absolute local paths, raw scripts, fetched artifacts, stdout dumps, or stderr dumps in the evidence.",
    "",
    "Return only JSON matching this evidence template, with observed_at set to the actual UTC time and plan hashes copied from the safe MCP outputs:",
    JSON.stringify(buildEvidenceTemplate(client), null, 2)
  ].join("\n");
}

export function buildEvidenceTemplate(client) {
  const normalizedClient = normalizeClient(client);
  return {
    schema_version: "0.1.0",
    kind: "client-installed-smoke-evidence",
    client: normalizedClient,
    client_version: "unknown",
    observed_at: "2026-06-15T00:00:00.000Z",
    operator: {
      confirmed_manual_client_run: true
    },
    plugin: {
      name: "uts-compute",
      version: packageJson.version,
      source: normalizedClient === "codex" ? "repository-root" : "installed-plugin-root",
      server_name: "uts-compute",
      install_method: normalizedClient === "codex" ? "mcp-config" : "plugin",
      skills_path: normalizedClient === "codex" ? ".agents/skills/" : "./skills/",
      ...(normalizedClient === "codex"
        ? { mcp_registration: "codex mcp add uts-compute -- node <abs>/mcp-server/dist/index.js" }
        : { manifest_path: ".claude-plugin/plugin.json", mcp_servers_path: "./.mcp.json" }),
      mcp_server: {
        type: "stdio",
        command: "node",
        args: [
          normalizedClient === "codex"
            ? "/absolute/path/to/mcp-server/dist/index.js"
            : "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"
        ]
      },
      uses_shared_skills: true,
      uses_shared_mcp_config: true
    },
    host_context: {
      client_host_observed: true,
      mcp_server_available: true,
      skills_available: true,
      state_scope: normalizedClient === "codex" ? "repository-root" : "installed-plugin-root"
    },
    checks: {
      skills_discovered: {
        ok: true,
        skills: REQUIRED_SKILLS
      },
      tools_discovered: {
        ok: true,
        tools: REQUIRED_TOOLS
      },
      resources_discovered: {
        ok: true,
        resources: REQUIRED_RESOURCES
      },
      profiles_list: {
        ok: true,
        profiles_seen: 1,
        host_alias_redacted: true,
        secret_refs_redacted: true
      },
      templates_list: {
        ok: true,
        template_ids: REQUIRED_TEMPLATES
      },
      docs_context: {
        ok: true,
        method: "resource-read",
        reference: "uts://docs/schema-migration-plan"
      },
      state_migrate_plan: {
        ok: true,
        mode: "dry-run",
        writes_planned: false,
        plan_hash: "0".repeat(64)
      },
      jobs_plan_dry_run: {
        ok: true,
        mode: "dry-run",
        run_id: `client-smoke-${normalizedClient}-replace-me`,
        plan_hash: "0".repeat(64),
        script_kind: "pbs"
      }
    },
    forbidden_operations: {
      no_vpn_probe: true,
      no_ssh_or_remote_shell: true,
      no_pbs_or_ihpc_live_commands: true,
      no_rsync: true,
      no_live_uts_hosts: true,
      no_submission_status_logs_or_cancel: true,
      no_artifact_fetch_cleanup_or_transfer_execute: true,
      no_state_migrate_apply: true,
      no_profiles_local_or_secrets_included: true,
      no_generated_artifacts_committed: true
    },
    result: {
      passed: true,
      summary:
        normalizedClient === "codex"
          ? "codex observed the registered MCP server, shared Skills from .agents/skills, and offline dry-run checks."
          : "claude-code observed the installed plugin, shared Skills, shared MCP server, and offline dry-run checks."
    },
    notes: []
  };
}

function normalizeClient(client) {
  if (client === "codex" || client === "claude-code") {
    return client;
  }
  throw new Error(`Unknown client: ${client}`);
}

function parseArgs(argv) {
  const result = {
    promptOnly: false,
    client: undefined,
    out: undefined,
    help: false
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--prompt-only") {
      result.promptOnly = true;
    } else if (arg === "--client") {
      result.client = argv[++index];
    } else if (arg === "--out") {
      result.out = argv[++index];
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }
  return result;
}

function usage() {
  return [
    "Usage: node scripts/client-installed-smoke.mjs --prompt-only [--client codex|claude-code] [--out file]",
    "",
    "Generates fixed prompts and evidence templates for manual smoke checks inside real Codex and Claude Code plugin hosts."
  ].join("\n");
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  try {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
      console.log(usage());
      process.exit(0);
    }
    if (!args.promptOnly) {
      console.error(usage());
      process.exit(2);
    }
    const bundle = buildClientSmokePromptBundle({ client: args.client });
    const output = `${JSON.stringify(bundle, null, 2)}\n`;
    if (args.out) {
      fs.mkdirSync(path.dirname(path.resolve(args.out)), { recursive: true });
      fs.writeFileSync(args.out, output, "utf8");
    } else {
      process.stdout.write(output);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
