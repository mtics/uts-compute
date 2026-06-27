import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { repoRoot } from "../helpers/index.mjs";

test("MCP prompt registry stays pure and does not import live/state/action modules", () => {
  const source = fs.readFileSync(path.join(repoRoot, "mcp-server", "src", "mcp", "prompts.ts"), "utf8");
  const imports = [...source.matchAll(/^\s*import\s+(?:type\s+)?[\s\S]*?\s+from\s+["']([^"']+)["'];/gm)].map((match) => match[1]);

  // ./schemas.js is a pure leaf module (imports only zod); sharing the PLATFORM_HINT_ENUM constant
  // from there keeps prompts.ts free of any state/action/live module, which is what this guard exists
  // to protect (see the denylist assertion below).
  assert.deepEqual(imports.sort(), [
    "./schemas.js",
    "@modelcontextprotocol/sdk/server/completable.js",
    "@modelcontextprotocol/sdk/server/mcp.js",
    "zod"
  ]);
  assert.doesNotMatch(
    source,
    /from\s+["']\.\.?\/(?:ops\/|core\/)?(access|approval|approvals|artifacts|audit|config|docs|ihpc-start|jobs|migrations|planner|quotas|resources|retry|submit|transfer|validation)\.js["']/
  );
  assert.doesNotMatch(source, /from\s+["']node:(fs|child_process|net|http|https|tls|dgram|readline)["']/);
});
