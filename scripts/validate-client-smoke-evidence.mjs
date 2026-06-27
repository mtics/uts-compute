#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { validatePluginPackage } from "./validate-plugin-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const REQUIRED_CLIENTS = ["codex", "claude-code"];
// All shipped Skills must be discoverable in the installed client (they are all mirrored under
// .agents/skills/ and surfaced in /help), so the release-gate evidence must list all 13.
export const REQUIRED_SKILLS = [
  "analyze-artifacts",
  "fleet-status",
  "hpc-submit-pbs",
  "ihpc-run-background",
  "monitor-and-recover",
  "plan-experiment",
  "reproduce-run",
  "review-approvals",
  "run-experiment",
  "run-sweep",
  "select-profile",
  "stage-transfer",
  "triage-and-retry"
];
export const REQUIRED_TOOLS = ["profiles.list", "templates.list", "state.migrate.plan", "jobs.plan"];
export const REQUIRED_RESOURCES = ["profiles", "templates", "docs"];
export const REQUIRED_TEMPLATES = ["pbs-cpu"];

const FORBIDDEN_STRING_PATTERNS = [
  {
    code: "profiles-local-leak",
    pattern: /profiles\.local\.ya?ml/i,
    message: "Evidence must not include the real local profile filename"
  },
  {
    code: "absolute-local-path-leak",
    pattern: /(^|\s)(\/Users\/|\/home\/[^/\s]+\/|[A-Za-z]:\\)/,
    message: "Evidence must not include absolute local filesystem paths"
  },
  {
    code: "private-key-leak",
    pattern: /BEGIN (OPENSSH|RSA|DSA|EC|PRIVATE) KEY/i,
    message: "Evidence must not include private key material"
  },
  {
    code: "secret-like-leak",
    pattern: /(api[_-]?key|access[_-]?token|refresh[_-]?token|client[_-]?secret|password|passwd|bearer)\s*[:=]/i,
    message: "Evidence must not include secret-like key/value material"
  },
  {
    code: "forbidden-tool-mentioned",
    pattern:
      /\b(access\.check|quotas\.refresh|docs\.refresh|jobs\.submit|jobs\.status|jobs\.logs|jobs\.cancel|artifacts\.fetch|artifacts\.fetch\.batch|artifacts\.cleanup\.execute|transfers\.execute|state\.migrate\.apply|approvals\.decide)\b/,
    message: "Evidence must not include forbidden live or mutating tool invocations"
  }
];

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const schema = JSON.parse(fs.readFileSync(path.join(repoRoot, "schemas", "client-smoke-evidence.schema.json"), "utf8"));
const validateSchema = ajv.compile(schema);

export function validateClientSmokeEvidence(evidence) {
  const issues = [];
  const schemaOk = validateSchema(evidence) === true;
  if (!schemaOk) {
    for (const error of validateSchema.errors ?? []) {
      issues.push({
        code: "schema",
        path: error.instancePath || "/",
        message: error.message ?? "is invalid"
      });
    }
  }

  if (evidence && typeof evidence === "object" && !Array.isArray(evidence)) {
    requireItems({
      issues,
      code: "missing-skill",
      label: "Skill",
      actual: evidence.checks?.skills_discovered?.skills,
      required: REQUIRED_SKILLS,
      path: "/checks/skills_discovered/skills"
    });
    requireItems({
      issues,
      code: "missing-tool",
      label: "Tool",
      actual: evidence.checks?.tools_discovered?.tools,
      required: REQUIRED_TOOLS,
      path: "/checks/tools_discovered/tools"
    });
    requireItems({
      issues,
      code: "missing-resource",
      label: "Resource",
      actual: evidence.checks?.resources_discovered?.resources,
      required: REQUIRED_RESOURCES,
      path: "/checks/resources_discovered/resources"
    });
    requireItems({
      issues,
      code: "missing-template",
      label: "Template",
      actual: evidence.checks?.templates_list?.template_ids,
      required: REQUIRED_TEMPLATES,
      path: "/checks/templates_list/template_ids"
    });
    requireClientManifestBinding(evidence, issues);
    rejectTemplatePlaceholders(evidence, issues);
    collectForbiddenStrings(evidence, issues);
  }

  return {
    ok: issues.length === 0,
    client: typeof evidence?.client === "string" ? evidence.client : null,
    issues
  };
}

export function validateClientSmokeEvidenceSet(entries, options = {}) {
  const perFile = entries.map((entry) => ({
    file: entry.file,
    ...validateClientSmokeEvidence(entry.evidence)
  }));
  const setIssues = [];
  const packageValidation = options.skipPackageValidation
    ? { ok: true, checked: [], issues: [] }
    : validatePluginPackage(options.pluginRoot ?? repoRoot);
  if (!packageValidation.ok) {
    setIssues.push({
      code: "plugin-package-invalid",
      message: "Current plugin package validation failed",
      issues: packageValidation.issues
    });
  }
  const seen = new Map();

  for (const result of perFile) {
    if (!result.client) {
      continue;
    }
    if (seen.has(result.client)) {
      setIssues.push({
        code: "duplicate-client",
        client: result.client,
        message: `Multiple evidence files were provided for ${result.client}`
      });
    }
    seen.set(result.client, true);
  }

  if (options.requireBothClients === true) {
    for (const client of REQUIRED_CLIENTS) {
      if (!seen.has(client)) {
        setIssues.push({
          code: "missing-client",
          client,
          message: `Missing client-installed smoke evidence for ${client}`
        });
      }
    }
  }

  const releaseGatePassed =
    REQUIRED_CLIENTS.every((client) => seen.has(client)) && perFile.every((result) => result.ok) && setIssues.length === 0;

  return {
    ok: perFile.every((result) => result.ok) && setIssues.length === 0,
    release_gate_passed: releaseGatePassed,
    package_validation: {
      ok: packageValidation.ok,
      checked: packageValidation.checked,
      issues: packageValidation.issues
    },
    required_clients: REQUIRED_CLIENTS,
    clients_seen: [...seen.keys()].sort(),
    files: perFile,
    set_issues: setIssues
  };
}

// Each client uses its documented install method (ADR 0005): Claude Code installs the plugin
// (.claude-plugin + .mcp.json, ${CLAUDE_PLUGIN_ROOT} launch arg); Codex registers the same
// stdio MCP server via standard config (codex mcp add / config.toml, absolute launch path) and
// discovers Skills from .agents/skills/ — no plugin.
function requireClientManifestBinding(evidence, issues) {
  if (!REQUIRED_CLIENTS.includes(evidence.client)) {
    return;
  }
  const plugin = evidence.plugin ?? {};
  const arg = plugin.mcp_server?.args?.[0];
  if (evidence.client === "claude-code") {
    if (plugin.install_method !== "plugin") {
      issues.push({ code: "client-install-method", path: "/plugin/install_method", message: "claude-code evidence must use install_method \"plugin\"" });
    }
    if (plugin.manifest_path !== ".claude-plugin/plugin.json") {
      issues.push({ code: "client-manifest-mismatch", path: "/plugin/manifest_path", message: "claude-code evidence must reference .claude-plugin/plugin.json" });
    }
    if (plugin.mcp_servers_path !== "./.mcp.json") {
      issues.push({ code: "client-mcp-config-mismatch", path: "/plugin/mcp_servers_path", message: "claude-code evidence must reference ./.mcp.json" });
    }
    if (arg !== "${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js") {
      issues.push({ code: "client-mcp-arg-mismatch", path: "/plugin/mcp_server/args/0", message: "claude-code evidence MCP launch arg must be ${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js" });
    }
    return;
  }
  // codex
  if (plugin.install_method !== "mcp-config") {
    issues.push({ code: "client-install-method", path: "/plugin/install_method", message: "codex evidence must use install_method \"mcp-config\" (no Codex plugin; ADR 0005)" });
  }
  if (typeof plugin.mcp_registration !== "string" || plugin.mcp_registration.length === 0) {
    issues.push({ code: "codex-mcp-registration-missing", path: "/plugin/mcp_registration", message: "codex evidence must record how the MCP server was registered (e.g. codex mcp add / ~/.codex/config.toml)" });
  }
  if (plugin.skills_path !== ".agents/skills/") {
    issues.push({ code: "codex-skills-source", path: "/plugin/skills_path", message: "codex evidence must discover Skills from .agents/skills/" });
  }
  if (typeof arg !== "string" || !arg.endsWith("mcp-server/dist/index.js") || arg.includes("PLUGIN_ROOT")) {
    issues.push({ code: "codex-mcp-arg", path: "/plugin/mcp_server/args/0", message: "codex evidence MCP launch arg must be an absolute path ending in mcp-server/dist/index.js (no plugin-root variable)" });
  }
}

function rejectTemplatePlaceholders(evidence, issues) {
  const planHashes = [
    ["/checks/state_migrate_plan/plan_hash", evidence.checks?.state_migrate_plan?.plan_hash],
    ["/checks/jobs_plan_dry_run/plan_hash", evidence.checks?.jobs_plan_dry_run?.plan_hash]
  ];
  for (const [issuePath, value] of planHashes) {
    if (value === "0".repeat(64)) {
      issues.push({
        code: "placeholder-plan-hash",
        path: issuePath,
        message: "Evidence must replace template plan_hash placeholders with observed nonzero hashes"
      });
    }
  }
  const runId = evidence.checks?.jobs_plan_dry_run?.run_id;
  if (typeof runId === "string" && runId.endsWith("replace-me")) {
    issues.push({
      code: "placeholder-run-id",
      path: "/checks/jobs_plan_dry_run/run_id",
      message: "Evidence must replace the template dry-run run_id"
    });
  }
}

function requireItems({ issues, code, label, actual, required, path: issuePath }) {
  const actualSet = new Set(Array.isArray(actual) ? actual : []);
  for (const item of required) {
    if (!actualSet.has(item)) {
      issues.push({
        code,
        path: issuePath,
        message: `${label} ${item} was not present in client evidence`
      });
    }
  }
}

function collectForbiddenStrings(value, issues, jsonPath = "") {
  if (typeof value === "string") {
    for (const forbidden of FORBIDDEN_STRING_PATTERNS) {
      if (forbidden.pattern.test(value)) {
        issues.push({
          code: forbidden.code,
          path: jsonPath || "/",
          message: forbidden.message
        });
      }
    }
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => collectForbiddenStrings(item, issues, `${jsonPath}/${index}`));
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      collectForbiddenStrings(child, issues, `${jsonPath}/${escapeJsonPointer(key)}`);
    }
  }
}

function escapeJsonPointer(value) {
  return value.replaceAll("~", "~0").replaceAll("/", "~1");
}

function readEvidenceFile(file) {
  try {
    return {
      file,
      evidence: JSON.parse(fs.readFileSync(file, "utf8")),
      read_error: null
    };
  } catch (error) {
    return {
      file,
      evidence: null,
      read_error: error instanceof Error ? error.message : String(error)
    };
  }
}

function parseArgs(argv) {
  const files = [];
  let requireBothClients = false;
  for (const arg of argv) {
    if (arg === "--require-both") {
      requireBothClients = true;
    } else if (arg === "--help" || arg === "-h") {
      return { help: true, files, requireBothClients };
    } else {
      files.push(arg);
    }
  }
  return { help: false, files, requireBothClients };
}

function usage() {
  return [
    "Usage: node scripts/validate-client-smoke-evidence.mjs [--require-both] <evidence.json>...",
    "",
    "Validates manual smoke evidence captured inside real Codex and Claude Code plugin hosts.",
    "Use --require-both for the release gate."
  ].join("\n");
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || args.files.length === 0) {
    console.log(usage());
    process.exit(args.help ? 0 : 2);
  }

  const readEntries = args.files.map(readEvidenceFile);
  const readFailures = readEntries
    .filter((entry) => entry.read_error)
    .map((entry) => ({
      file: entry.file,
      ok: false,
      client: null,
      issues: [
        {
          code: "read-error",
          path: "/",
          message: entry.read_error
        }
      ]
    }));
  const loaded = readEntries.filter((entry) => !entry.read_error);
  const result = validateClientSmokeEvidenceSet(loaded, { requireBothClients: args.requireBothClients });
  result.files = [...readFailures, ...result.files];
  result.ok = result.ok && readFailures.length === 0;
  result.release_gate_passed = result.release_gate_passed && readFailures.length === 0;

  console.log(JSON.stringify(result, null, 2));
  if (!result.ok) {
    process.exit(1);
  }
}
