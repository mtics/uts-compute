#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import YAML from "yaml";

const DEFAULT_REQUIRED_SKILL_KEYS = ["name", "description"];

export function validatePluginPackage(root = process.cwd()) {
  const pluginRoot = path.resolve(root);
  const issues = [];
  const claudeManifest = readJson(path.join(pluginRoot, ".claude-plugin", "plugin.json"), issues, "claude-manifest");
  // Claude Code installs as a plugin; its MCP launch arg uses ${CLAUDE_PLUGIN_ROOT} so the
  // server starts regardless of the client's working directory. Codex and other agents do not
  // get a plugin wrapper — they use the standard mcpServers config + .agents/skills. See ADR 0005.
  const claudeMcpConfig = readJson(path.join(pluginRoot, ".mcp.json"), issues, "claude-mcp-config");

  validateManifest({
    manifest: claudeManifest,
    manifestPath: path.join(pluginRoot, ".claude-plugin", "plugin.json"),
    pluginRoot,
    issues
  });
  validateThinShimDirectory(
    path.join(pluginRoot, ".claude-plugin"),
    [".claude-plugin/plugin.json", ".claude-plugin/marketplace.json"],
    pluginRoot,
    issues
  );
  validateClientMcpConfig({ config: claudeMcpConfig, ownerRel: ".mcp.json", rootVar: "CLAUDE_PLUGIN_ROOT", pluginRoot, issues });
  validateSkills(path.join(pluginRoot, "skills"), issues);
  validateAgentsSkills(pluginRoot, issues);
  validateRequiredFile(path.join(pluginRoot, "scripts", "host-neutral-plugin-smoke.mjs"), "plugin-smoke-script", issues);
  validateRequiredFile(path.join(pluginRoot, "scripts", "client-installed-smoke.mjs"), "client-smoke-prompt-script", issues);
  validateRequiredFile(path.join(pluginRoot, "scripts", "validate-client-smoke-evidence.mjs"), "client-smoke-evidence-validator", issues);
  validateRequiredFile(path.join(pluginRoot, "schemas", "client-smoke-evidence.schema.json"), "client-smoke-evidence-schema", issues);

  return {
    ok: issues.length === 0,
    root: pluginRoot,
    checked: [
      ".claude-plugin/plugin.json",
      ".claude-plugin/marketplace.json",
      ".mcp.json",
      "skills/",
      "skills/*/agents/openai.yaml",
      ".agents/skills/",
      "mcp-server/dist/index.js",
      "scripts/host-neutral-plugin-smoke.mjs",
      "scripts/client-installed-smoke.mjs",
      "scripts/validate-client-smoke-evidence.mjs",
      "schemas/client-smoke-evidence.schema.json"
    ],
    issues
  };
}

function validateRequiredFile(filePath, code, issues) {
  if (!fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
    issues.push({
      code,
      path: filePath,
      message: "Required plugin validation file is missing"
    });
  }
}

function readJson(filePath, issues, code) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch (error) {
    issues.push({
      code,
      path: filePath,
      message: `Unable to read JSON: ${error instanceof Error ? error.message : String(error)}`
    });
    return undefined;
  }
}

// Validate the Claude Code plugin manifest (.claude-plugin/plugin.json). Codex and other agents
// have no plugin wrapper post-ADR 0005, so this is the only client manifest the package ships.
function validateManifest({ manifest, manifestPath, pluginRoot, issues }) {
  if (!manifest || typeof manifest !== "object" || Array.isArray(manifest)) {
    return;
  }
  for (const key of ["name", "version", "description", "skills", "mcpServers"]) {
    if (!(key in manifest)) {
      issues.push({
        code: `claude-manifest-missing-${key}`,
        path: manifestPath,
        message: `Manifest is missing required key ${key}`
      });
    }
  }
  validateRootRelativePath(manifest.skills, {
    code: "claude-skills-path",
    label: "claude skills",
    expected: "./skills/",
    pluginRoot,
    ownerPath: manifestPath,
    issues
  });
  validateRootRelativePath(manifest.mcpServers, {
    code: "claude-mcp-path",
    label: "claude mcpServers",
    expected: "./.mcp.json",
    pluginRoot,
    ownerPath: manifestPath,
    issues
  });
}

function validateRootRelativePath(value, { code, label, expected, pluginRoot, ownerPath, issues }) {
  if (value !== expected) {
    issues.push({
      code,
      path: ownerPath,
      message: `${label} must be ${expected}`
    });
  }
  if (typeof value !== "string") {
    return;
  }
  if (!value.startsWith("./") || value.includes("..") || path.isAbsolute(value) || value.startsWith("~")) {
    issues.push({
      code: `${code}-unsafe`,
      path: ownerPath,
      message: `${label} must be plugin-root-relative and must not escape the plugin root`
    });
    return;
  }
  const resolved = path.resolve(pluginRoot, value);
  if (!isInside(resolved, pluginRoot)) {
    issues.push({
      code: `${code}-escape`,
      path: ownerPath,
      message: `${label} resolves outside the plugin root`
    });
  }
  if (!fs.existsSync(resolved)) {
    issues.push({
      code: `${code}-missing-target`,
      path: ownerPath,
      message: `${label} target does not exist: ${value}`
    });
  }
}

function validateThinShimDirectory(dir, allowedRelativeFiles, pluginRoot, issues) {
  if (!fs.existsSync(dir)) {
    issues.push({
      code: "shim-missing",
      path: dir,
      message: "Client shim directory is missing"
    });
    return;
  }
  for (const entry of walkFiles(dir)) {
    const rel = normalizeRelative(pluginRoot, entry);
    if (!allowedRelativeFiles.includes(rel)) {
      issues.push({
        code: "shim-extra-file",
        path: entry,
        message: "Client-specific shim directories must contain only plugin manifests"
      });
    }
  }
}

// Validate one client's MCP config. The launch arg must be an absolute path built from the
// client's plugin-root variable (${CLAUDE_PLUGIN_ROOT} for Claude, ${PLUGIN_ROOT} for Codex)
// so `node` finds the entrypoint regardless of the client's working directory. The env config
// path stays plugin-root-relative: the server resolves it against its own location.
function validateClientMcpConfig({ config, ownerRel, rootVar, pluginRoot, issues }) {
  const ownerPath = path.join(pluginRoot, ownerRel);
  const server = config?.mcpServers?.["uts-compute"];
  if (!server || typeof server !== "object" || Array.isArray(server)) {
    issues.push({
      code: "mcp-server-missing",
      path: ownerPath,
      message: `${ownerRel} must define mcpServers.uts-compute`
    });
    return;
  }
  if (server.type !== "stdio") {
    issues.push({ code: "mcp-server-type", path: ownerPath, message: `${ownerRel} MCP server must use stdio` });
  }
  if (server.command !== "node") {
    issues.push({ code: "mcp-server-command", path: ownerPath, message: `${ownerRel} MCP server command must be node` });
  }
  const prefix = `\${${rootVar}}/`;
  const expectedArg = `${prefix}mcp-server/dist/index.js`;
  const args = Array.isArray(server.args) ? server.args : [];
  if (args.length !== 1 || args[0] !== expectedArg) {
    issues.push({
      code: "mcp-server-args",
      path: ownerPath,
      message: `${ownerRel} MCP server must launch node ${expectedArg}`
    });
  } else {
    const distPath = path.resolve(pluginRoot, args[0].slice(prefix.length));
    if (!isInside(distPath, pluginRoot) || !fs.existsSync(distPath)) {
      issues.push({
        code: "mcp-server-dist-missing",
        path: distPath,
        message: "mcp-server/dist/index.js must exist before plugin testing"
      });
    }
  }
  const env = server.env && typeof server.env === "object" && !Array.isArray(server.env) ? server.env : {};
  // UTS_COMPUTING_CONFIG is a plugin-root-relative path; UTS_COMPUTING_APPROVAL_TOKEN (C2) is a
  // user_config placeholder the host substitutes at runtime (never a real secret in the shipped file).
  const SUPPORTED_MCP_ENV_KEYS = new Set(["UTS_COMPUTING_CONFIG", "UTS_COMPUTING_APPROVAL_TOKEN"]);
  for (const [key, value] of Object.entries(env)) {
    if (!SUPPORTED_MCP_ENV_KEYS.has(key)) {
      issues.push({ code: "mcp-env-unsupported-key", path: ownerPath, message: `Unsupported MCP environment key ${key}` });
    }
    if (typeof value !== "string" || path.isAbsolute(value) || value.startsWith("~") || value.includes("..")) {
      issues.push({
        code: "mcp-env-unsafe-value",
        path: ownerPath,
        message: `MCP environment value for ${key} must be a safe plugin-root-relative path`
      });
    }
  }
}

// Codex and other agentskills.io-compatible agents auto-discover Skills from .agents/skills/.
// We mirror the canonical skills/ tree there (symlinks) so the same SKILL.md folders are
// usable without any per-agent plugin wrapper. See ADR 0005.
function validateAgentsSkills(pluginRoot, issues) {
  const agentsSkillsDir = path.join(pluginRoot, ".agents", "skills");
  if (!fs.existsSync(agentsSkillsDir)) {
    issues.push({
      code: "agents-skills-missing",
      path: agentsSkillsDir,
      message: ".agents/skills/ must exist so Codex and other agents discover the shared Skills"
    });
    return;
  }
  const skillsDir = path.join(pluginRoot, "skills");
  if (!fs.existsSync(skillsDir)) {
    return;
  }
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory() || !fs.existsSync(path.join(skillsDir, entry.name, "SKILL.md"))) {
      continue;
    }
    // existsSync follows symlinks, so this confirms .agents/skills/<name> resolves to a SKILL.md.
    if (!fs.existsSync(path.join(agentsSkillsDir, entry.name, "SKILL.md"))) {
      issues.push({
        code: "agents-skills-unmirrored",
        path: path.join(agentsSkillsDir, entry.name),
        message: `Skill ${entry.name} is not discoverable under .agents/skills/ (add the symlink to skills/${entry.name})`
      });
    }
  }
}

function validateSkills(skillsDir, issues) {
  if (!fs.existsSync(skillsDir)) {
    issues.push({
      code: "skills-dir-missing",
      path: skillsDir,
      message: "Shared skills directory is missing"
    });
    return;
  }
  for (const entry of fs.readdirSync(skillsDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) {
      continue;
    }
    const skillPath = path.join(skillsDir, entry.name, "SKILL.md");
    if (!fs.existsSync(skillPath)) {
      continue;
    }
    const text = fs.readFileSync(skillPath, "utf8");
    if (!text.startsWith("---\n")) {
      issues.push({
        code: "skill-frontmatter-missing",
        path: skillPath,
        message: "Skill is missing YAML frontmatter"
      });
      continue;
    }
    const end = text.indexOf("\n---\n", 4);
    if (end < 0) {
      issues.push({
        code: "skill-frontmatter-end-missing",
        path: skillPath,
        message: "Skill frontmatter is not closed"
      });
      continue;
    }
    const frontmatter = text.slice(4, end);
    for (const key of DEFAULT_REQUIRED_SKILL_KEYS) {
      if (!new RegExp(`^${key}:\\s+`, "m").test(frontmatter)) {
        issues.push({
          code: `skill-frontmatter-${key}`,
          path: skillPath,
          message: `Skill frontmatter must include ${key}`
        });
      }
    }
    validateSkillAgentMetadata(path.join(skillsDir, entry.name), issues);
  }
}

function validateSkillAgentMetadata(skillDir, issues) {
  const agentsDir = path.join(skillDir, "agents");
  if (!fs.existsSync(agentsDir)) {
    return;
  }
  for (const filePath of walkFiles(agentsDir)) {
    const relative = path.relative(skillDir, filePath).split(path.sep).join("/");
    if (relative !== "agents/openai.yaml") {
      issues.push({
        code: "skill-agent-metadata-unsupported",
        path: filePath,
        message: "Shared Skills may include only agents/openai.yaml as optional Codex-facing metadata"
      });
      continue;
    }
    try {
      const parsed = YAML.parse(fs.readFileSync(filePath, "utf8"));
      const iface = parsed?.interface;
      for (const key of ["display_name", "short_description", "default_prompt"]) {
        if (!iface || typeof iface[key] !== "string" || !iface[key].trim()) {
          issues.push({
            code: `skill-agent-openai-${key}`,
            path: filePath,
            message: `agents/openai.yaml must include interface.${key}`
          });
        }
      }
    } catch (error) {
      issues.push({
        code: "skill-agent-openai-yaml",
        path: filePath,
        message: `Unable to parse agents/openai.yaml: ${error instanceof Error ? error.message : String(error)}`
      });
    }
  }
}


function walkFiles(dir) {
  const files = [];
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop();
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }
  return files.sort();
}

function normalizeRelative(root, filePath) {
  return path.relative(root, filePath).split(path.sep).join("/");
}

function isInside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const rootArg = process.argv[2] ?? process.cwd();
  const result = validatePluginPackage(rootArg);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
