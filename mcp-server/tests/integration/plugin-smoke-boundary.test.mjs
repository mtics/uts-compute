import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { buildSmokeEnv, createSmokePluginRoot } from "../../../scripts/host-neutral-plugin-smoke.mjs";

function tempSourceRoot() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "uts-plugin-smoke-source-"));
  for (const dir of [
    ".claude-plugin",
    ".agents/skills",
    "docs",
    "examples",
    "mcp-server/dist",
    "profiles",
    "scripts",
    "schemas",
    "skills",
    "templates"
  ]) {
    fs.mkdirSync(path.join(root, dir), { recursive: true });
  }
  fs.writeFileSync(path.join(root, "profiles", "README.md"), "# Profiles\n", "utf8");
  fs.writeFileSync(path.join(root, "profiles", "profiles.example.yaml"), "profiles: []\n", "utf8");
  fs.writeFileSync(path.join(root, "profiles", "profiles.local.yaml"), "real_profile: should-not-copy\n", "utf8");
  fs.writeFileSync(path.join(root, "profiles", "another.local.yaml"), "real_profile: should-not-copy\n", "utf8");
  fs.writeFileSync(path.join(root, ".mcp.json"), "{}\n", "utf8");
  fs.writeFileSync(path.join(root, "package.json"), "{}\n", "utf8");
  return root;
}

test("host-neutral plugin smoke root excludes local profile files", () => {
  const pluginRoot = createSmokePluginRoot(tempSourceRoot());

  assert.equal(fs.existsSync(path.join(pluginRoot, "profiles", "profiles.example.yaml")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "profiles", "README.md")), true);
  assert.equal(fs.existsSync(path.join(pluginRoot, "profiles", "profiles.local.yaml")), false);
  assert.equal(fs.existsSync(path.join(pluginRoot, "profiles", "another.local.yaml")), false);
});

test("host-neutral plugin smoke env forces example profiles and strips secret-like parent env", () => {
  const pluginRoot = createSmokePluginRoot(tempSourceRoot());
  const previous = {
    UTS_COMPUTING_APPROVAL_TOKEN: process.env.UTS_COMPUTING_APPROVAL_TOKEN,
    SSH_AUTH_SOCK: process.env.SSH_AUTH_SOCK,
    OPENAI_API_KEY: process.env.OPENAI_API_KEY,
    AWS_SECRET_ACCESS_KEY: process.env.AWS_SECRET_ACCESS_KEY,
    HTTPS_PROXY: process.env.HTTPS_PROXY
  };
  process.env.UTS_COMPUTING_APPROVAL_TOKEN = "approval-secret";
  process.env.SSH_AUTH_SOCK = "/tmp/ssh-agent.sock";
  process.env.OPENAI_API_KEY = "sk-secret";
  process.env.AWS_SECRET_ACCESS_KEY = "aws-secret";
  process.env.HTTPS_PROXY = "https://user:pass@example.test";

  try {
    const warnings = [];
    const env = buildSmokeEnv(pluginRoot, { UTS_COMPUTING_CONFIG: "profiles/profiles.local.yaml" }, warnings);

    assert.equal(env.UTS_COMPUTING_CONFIG, "profiles/profiles.example.yaml");
    assert.equal(Object.hasOwn(env, "UTS_COMPUTING_APPROVAL_TOKEN"), false);
    assert.equal(Object.hasOwn(env, "SSH_AUTH_SOCK"), false);
    assert.equal(Object.hasOwn(env, "OPENAI_API_KEY"), false);
    assert.equal(Object.hasOwn(env, "AWS_SECRET_ACCESS_KEY"), false);
    assert.equal(Object.hasOwn(env, "HTTPS_PROXY"), false);
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /used profiles\/profiles\.example\.yaml/);
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
});
