// H4/M13: every successful tool envelope must self-disclose which profiles config the server is using,
// so the AGENT (which reads results, not stderr) can tell when it is operating against the bundled
// example profiles rather than real accounts. The disclosure rides on the success envelope via safeTool
// and MUST NOT appear on error envelopes (those stay minimal: { ok:false, error }).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test, { after } from "node:test";
import { makeWithMcpClient } from "../helpers/index.mjs";

const TEST_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "uts-cfgstatus-"));
after(() => {
  try {
    fs.rmSync(TEST_HOME, { recursive: true, force: true });
  } catch {
    // best-effort cleanup
  }
});

const withMcpClient = makeWithMcpClient({ home: TEST_HOME, clientName: "uts-compute-cfgstatus" });

function parseTextResult(result) {
  assert.equal(result.isError, false);
  const parsed = JSON.parse(result.content[0].text);
  assert.deepEqual(result.structuredContent, parsed);
  return parsed;
}

test("a successful tool envelope carries config_status { using_example_profiles, config_path }", async () => {
  // Force the example-profile fallback for determinism: an empty UTS_COMPUTING_CONFIG resolves to the
  // bundled example, the canonical "no real accounts configured" case this disclosure exists for.
  await withMcpClient(async (client) => {
    const result = await client.callTool({ name: "templates.list", arguments: {} });
    const body = parseTextResult(result);
    assert.equal(body.ok, true);
    assert.ok(body.config_status, "success envelope must include config_status");
    assert.equal(typeof body.config_status.using_example_profiles, "boolean");
    assert.equal(typeof body.config_status.config_path, "string");
    assert.equal(body.config_status.using_example_profiles, true, "expected the example-profile fallback");
    assert.match(body.config_status.config_path, /profiles\.example\.yaml$/);
    // The real payload still rides alongside the disclosure.
    assert.ok(Array.isArray(body.templates));
  }, { UTS_COMPUTING_CONFIG: "" });
});

test("an error tool envelope stays minimal — NO config_status leaks onto it", async () => {
  await withMcpClient(async (client) => {
    // profiles.validate with an unknown profile_id throws inside the handler -> error envelope.
    const result = await client.callTool({
      name: "profiles.validate",
      arguments: { profileId: "no-such-profile-xyz" }
    });
    assert.equal(result.isError, true);
    const body = JSON.parse(result.content[0].text);
    assert.equal(body.ok, false);
    assert.ok(typeof body.error === "string");
    assert.equal("config_status" in body, false, "error envelopes must not carry config_status");
  }, { UTS_COMPUTING_CONFIG: "" });
});
