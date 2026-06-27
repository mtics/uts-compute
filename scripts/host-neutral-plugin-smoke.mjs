#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { validatePluginPackage } from "./validate-plugin-package.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const SERVER_NAME = "uts-compute";

export async function runHostNeutralPluginSmoke(root = repoRoot) {
  const sourceRoot = path.resolve(root);
  const pluginRoot = createSmokePluginRoot(sourceRoot);
  const validation = validatePluginPackage(pluginRoot);
  assert.equal(validation.ok, true, JSON.stringify(validation.issues, null, 2));

  const sharedConfig = readJson(path.join(pluginRoot, ".mcp.json"));
  const serverConfig = sharedConfig?.mcpServers?.[SERVER_NAME];
  assertServerConfig(serverConfig);

  const warnings = [];
  const env = buildSmokeEnv(pluginRoot, serverConfig.env, warnings);
  const client = new Client({ name: "uts-compute-plugin-smoke", version: "0.1.0" });
  // Expand ${CLAUDE_PLUGIN_ROOT} to the temporary plugin root the way the installed client
  // would, so the relative-arg-free launch path resolves from any working directory.
  const resolvedArgs = serverConfig.args.map((arg) => arg.replaceAll("${CLAUDE_PLUGIN_ROOT}", pluginRoot));
  const transport = new StdioClientTransport({
    command: serverConfig.command === "node" ? process.execPath : serverConfig.command,
    args: resolvedArgs,
    cwd: pluginRoot,
    env,
    stderr: "pipe"
  });

  await client.connect(transport);
  try {
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name).sort();
    for (const expected of ["profiles.list", "templates.list", "state.migrate.plan", "jobs.plan"]) {
      assert.ok(toolNames.includes(expected), `Expected tool ${expected} to be registered`);
    }

    const resources = await client.listResources();
    const resourceNames = resources.resources.map((resource) => resource.name).sort();
    for (const expected of ["profiles", "templates", "docs"]) {
      assert.ok(resourceNames.includes(expected), `Expected resource ${expected} to be registered`);
    }

    const prompts = await client.listPrompts();
    const promptNames = prompts.prompts.map((prompt) => prompt.name).sort();
    for (const expected of [
      "plan-experiment",
      "triage-run",
      "collect-artifacts",
      "stage-transfer",
      "client-smoke-evidence"
    ]) {
      assert.ok(promptNames.includes(expected), `Expected prompt ${expected} to be registered`);
    }
    const prompt = await client.getPrompt({
      name: "plan-experiment",
      arguments: {
        goal: "host-neutral prompt smoke",
        platform: "auto",
        intent: "dry-run"
      }
    });
    assert.equal(prompt.messages.length, 1);
    assert.equal(prompt.messages[0].role, "user");
    assert.equal(prompt.messages[0].content.type, "text");
    assert.match(prompt.messages[0].content.text, /jobs\.plan/);

    const profiles = parseToolResult(
      await client.callTool({
        name: "profiles.list",
        arguments: {}
      })
    );
    assert.equal(profiles.ok, true);
    assert.ok(Array.isArray(profiles.profiles));
    assert.ok(profiles.profiles.length >= 1);
    assert.equal(Object.hasOwn(profiles.profiles[0].login, "host_alias"), false);

    const templates = parseToolResult(
      await client.callTool({
        name: "templates.list",
        arguments: {}
      })
    );
    assert.equal(templates.ok, true);
    assert.ok(templates.templates.some((template) => template.id === "pbs-cpu"));

    const migration = parseToolResult(
      await client.callTool({
        name: "state.migrate.plan",
        arguments: {}
      })
    );
    assert.equal(migration.ok, true);
    assert.equal(migration.migration.mode, "dry-run");
    assert.equal(migration.migration.writes_planned, false);

    const jobSpec = readSmokeJobSpec(pluginRoot);
    const planned = parseToolResult(
      await client.callTool({
        name: "jobs.plan",
        arguments: { jobSpec }
      })
    );
    assert.equal(planned.ok, true);
    assert.equal(planned.plan.mode, "dry-run");
    assert.equal(planned.plan.run_id, jobSpec.run_id);
    assert.match(planned.plan.plan_hash, /^[a-f0-9]{64}$/);
    assert.match(planned.plan.script, /#PBS/);

    return {
      ok: true,
      smoke_kind: "direct-mcp-stdio-host-neutral",
      root: pluginRoot,
      server: {
        name: SERVER_NAME,
        command: serverConfig.command,
        args: serverConfig.args
      },
      checked: {
        validation: validation.checked,
        tools: ["profiles.list", "templates.list", "state.migrate.plan", "jobs.plan"],
        resources: ["profiles", "templates", "docs"],
        prompts: [
          "plan-experiment",
          "triage-run",
          "collect-artifacts",
          "stage-transfer",
          "client-smoke-evidence"
        ],
        dry_run_job: jobSpec.run_id
      },
      warnings
    };
  } finally {
    await client.close();
  }
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8"));
}

function assertServerConfig(value) {
  assert.ok(value && typeof value === "object" && !Array.isArray(value), "Shared MCP config must define the UTS server");
  assert.equal(value.type, "stdio");
  assert.equal(value.command, "node");
  assert.deepEqual(value.args, ["${CLAUDE_PLUGIN_ROOT}/mcp-server/dist/index.js"]);
}

export function buildSmokeEnv(pluginRoot, configuredEnv = {}, warnings) {
  const env = {
    ...safeProcessEnv()
  };
  const configuredProfilePath = configuredEnv.UTS_COMPUTING_CONFIG;
  if (typeof configuredProfilePath !== "string" || configuredProfilePath.includes("..") || path.isAbsolute(configuredProfilePath)) {
    throw new Error("UTS_COMPUTING_CONFIG must be a safe plugin-root-relative path");
  }
  env.UTS_COMPUTING_CONFIG = "profiles/profiles.example.yaml";
  warnings.push("Host-neutral smoke used profiles/profiles.example.yaml without changing plugin manifests");
  if (!fs.existsSync(path.join(pluginRoot, env.UTS_COMPUTING_CONFIG))) {
    throw new Error("profiles/profiles.example.yaml must exist in the temporary smoke plugin root");
  }
  return env;
}

export function createSmokePluginRoot(sourceRoot) {
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "uts-plugin-smoke-"));
  for (const entry of [
    ".claude-plugin",
    ".agents",
    "docs",
    "examples",
    "mcp-server/dist",
    "scripts",
    "schemas",
    "skills",
    "templates"
  ]) {
    copyPath(path.join(sourceRoot, entry), path.join(tempRoot, entry));
  }
  copyPath(path.join(sourceRoot, "profiles", "README.md"), path.join(tempRoot, "profiles", "README.md"));
  copyPath(path.join(sourceRoot, "profiles", "profiles.example.yaml"), path.join(tempRoot, "profiles", "profiles.example.yaml"));
  for (const entry of [".mcp.json", "package.json"]) {
    copyPath(path.join(sourceRoot, entry), path.join(tempRoot, entry));
  }
  linkNodeModules(sourceRoot, tempRoot);
  return tempRoot;
}

function copyPath(source, destination) {
  if (!fs.existsSync(source)) {
    return;
  }
  fs.mkdirSync(path.dirname(destination), { recursive: true });
  fs.cpSync(source, destination, {
    recursive: true,
    dereference: false,
    force: true
  });
}

function linkNodeModules(sourceRoot, tempRoot) {
  const sourceNodeModules = path.join(sourceRoot, "node_modules");
  if (!fs.existsSync(sourceNodeModules)) {
    return;
  }
  const target = path.join(tempRoot, "node_modules");
  try {
    fs.symlinkSync(sourceNodeModules, target, "dir");
  } catch {
    fs.cpSync(sourceNodeModules, target, {
      recursive: true,
      dereference: true,
      force: true
    });
  }
}

function safeProcessEnv() {
  const allowed = ["PATH", "HOME", "TMPDIR", "TEMP", "TMP", "SystemRoot", "WINDIR"];
  return Object.fromEntries(allowed.flatMap((key) => (typeof process.env[key] === "string" ? [[key, process.env[key]]] : [])));
}

function parseToolResult(result) {
  assert.equal(result.isError, false, result.content?.[0]?.text ?? "tool returned an error");
  assert.equal(result.content.length, 1);
  assert.equal(result.content[0].type, "text");
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

function readSmokeJobSpec(pluginRoot) {
  const jobSpec = readJson(path.join(pluginRoot, "examples", "jobs", "hpc-cpu.json"));
  const suffix = `${process.pid}-${Date.now()}`;
  jobSpec.run_id = `plugin-smoke-hpc-cpu-${suffix}`;
  jobSpec.workdir = `/shared/homes/\${USER}/experiments/${jobSpec.run_id}`;
  return jobSpec;
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const rootArg = process.argv[2] ?? repoRoot;
  runHostNeutralPluginSmoke(rootArg)
    .then((result) => {
      console.log(JSON.stringify(result, null, 2));
    })
    .catch((error) => {
      console.error(error instanceof Error ? error.stack || error.message : String(error));
      process.exit(1);
    });
}
