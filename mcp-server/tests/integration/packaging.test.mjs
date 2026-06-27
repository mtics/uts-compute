import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { validatePluginPackage } from "../../../scripts/validate-plugin-package.mjs";
import { repoRoot } from "../helpers/index.mjs";

function writeValidClaudePlugin(root) {
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(root, ".agents", "skills"), { recursive: true });
  fs.symlinkSync(path.join("..", "..", "skills", "demo"), path.join(root, ".agents", "skills", "demo"));
  fs.mkdirSync(path.join(root, "mcp-server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp-server", "dist", "index.js"), "console.log('demo');\n", "utf8");
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n", "utf8");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "uts-compute": {
          type: "stdio",
          command: "node",
          args: ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"],
          env: { UTS_COMPUTING_CONFIG: "profiles/profiles.local.yaml" }
        }
      }
    }),
    "utf8"
  );
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "uts-compute",
      version: "0.1.0",
      description: "good",
      skills: "./skills/",
      mcpServers: "./.mcp.json"
    }),
    "utf8"
  );
}

test("plugin package validation accepts the Claude plugin plus standards layout", () => {
  const result = validatePluginPackage(repoRoot);
  assert.equal(result.ok, true, JSON.stringify(result.issues, null, 2));
  assert.deepEqual(
    result.checked,
    [
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
    ]
  );
});

test("plugin package validation rejects a Claude manifest skills path that escapes the plugin root", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uts-plugin-bad-"));
  writeValidClaudePlugin(root);
  // Break the Claude manifest skills path so it escapes the plugin root.
  fs.writeFileSync(
    path.join(root, ".claude-plugin", "plugin.json"),
    JSON.stringify({
      name: "uts-compute",
      version: "0.1.0",
      description: "bad",
      skills: "../skills/",
      mcpServers: "./.mcp.json"
    }),
    "utf8"
  );

  const result = validatePluginPackage(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "claude-skills-path"));
  assert.ok(result.issues.some((issue) => issue.code === "claude-skills-path-unsafe"));
});

test("plugin package validation rejects a Skill not mirrored under .agents/skills", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uts-plugin-agents-"));
  writeValidClaudePlugin(root);
  // Remove the .agents/skills mirror so Codex/other agents could not discover the Skill.
  fs.rmSync(path.join(root, ".agents", "skills", "demo"));

  const result = validatePluginPackage(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "agents-skills-unmirrored"));
});

test("plugin package validation requires the host-neutral smoke script", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uts-plugin-missing-smoke-"));
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(root, "mcp-server", "dist"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp-server", "dist", "index.js"), "console.log('demo');\n", "utf8");
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n", "utf8");
  const manifest = {
    name: "uts-compute",
    version: "0.1.0",
    description: "good",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      capabilities: ["Skills", "MCP"]
    }
  };
  fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "uts-compute": {
          type: "stdio",
          command: "node",
          args: ["mcp-server/dist/index.js"],
          env: {
            UTS_COMPUTING_CONFIG: "profiles/profiles.local.yaml"
          }
        }
      }
    }),
    "utf8"
  );

  const result = validatePluginPackage(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "plugin-smoke-script"));
});

test("plugin package validation requires client-installed smoke evidence files", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uts-plugin-missing-client-smoke-"));
  fs.mkdirSync(path.join(root, ".codex-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, ".claude-plugin"), { recursive: true });
  fs.mkdirSync(path.join(root, "skills", "demo"), { recursive: true });
  fs.mkdirSync(path.join(root, "mcp-server", "dist"), { recursive: true });
  fs.mkdirSync(path.join(root, "scripts"), { recursive: true });
  fs.mkdirSync(path.join(root, "schemas"), { recursive: true });
  fs.writeFileSync(path.join(root, "mcp-server", "dist", "index.js"), "console.log('demo');\n", "utf8");
  fs.writeFileSync(path.join(root, "scripts", "host-neutral-plugin-smoke.mjs"), "#!/usr/bin/env node\n", "utf8");
  fs.writeFileSync(path.join(root, "skills", "demo", "SKILL.md"), "---\nname: demo\ndescription: Demo\n---\n", "utf8");
  const manifest = {
    name: "uts-compute",
    version: "0.1.0",
    description: "good",
    skills: "./skills/",
    mcpServers: "./.mcp.json",
    interface: {
      capabilities: ["Skills", "MCP"]
    }
  };
  fs.writeFileSync(path.join(root, ".codex-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(path.join(root, ".claude-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
  fs.writeFileSync(
    path.join(root, ".mcp.json"),
    JSON.stringify({
      mcpServers: {
        "uts-compute": {
          type: "stdio",
          command: "node",
          args: ["mcp-server/dist/index.js"],
          env: {
            UTS_COMPUTING_CONFIG: "profiles/profiles.local.yaml"
          }
        }
      }
    }),
    "utf8"
  );

  const result = validatePluginPackage(root);
  assert.equal(result.ok, false);
  assert.ok(result.issues.some((issue) => issue.code === "client-smoke-prompt-script"));
  assert.ok(result.issues.some((issue) => issue.code === "client-smoke-evidence-validator"));
  assert.ok(result.issues.some((issue) => issue.code === "client-smoke-evidence-schema"));
});
