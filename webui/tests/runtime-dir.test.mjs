import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runtimeRootDir } from "../../mcp-server/dist/core/paths.js";
import { createWebuiServer } from "../server.mjs";

// createWebuiServer returns a bare http.Server with no runtimeDir/config property, so W1 is proven
// INDIRECTLY (the truer test): with UTS_COMPUTING_HOME set and NO runtimeDir option, a record seeded
// under runtimeRootDir()/runs must surface in /api/summary. Env save/restore in try/finally so this
// does not depend on sibling-file ordering (webui.test.mjs sets UTS_COMPUTING_HOME at module top).
test("WebUI default runtimeDir resolves to runtimeRootDir() so it sees real records (W1)", async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "webui-home-"));
  const prev = process.env.UTS_COMPUTING_HOME;
  process.env.UTS_COMPUTING_HOME = home;
  try {
    // seed one schema-valid run record under the SERVER's resolved runs dir
    const runsDir = path.join(runtimeRootDir(), "runs");
    fs.mkdirSync(runsDir, { recursive: true });
    const rec = {
      run_id: "webui-seed-1",
      profile_id: "uts-hpc-account-a",
      platform: "uts-hpc",
      remote_job_id: "1.cetus",
      status: "finished",
      created_at: "2026-06-20T10:00:00.000Z",
      updated_at: "2026-06-20T10:00:00.000Z",
      events: [{ at: "2026-06-20T10:00:00.000Z", kind: "adopted-external", summary: "seed" }]
    };
    fs.writeFileSync(path.join(runsDir, "webui-seed-1.json"), `${JSON.stringify(rec, null, 2)}\n`, "utf8");

    const server = createWebuiServer(); // NO options -> default runtimeDir must be runtimeRootDir()
    await new Promise((res) => server.listen(0, "127.0.0.1", res));
    const { port } = server.address();
    try {
      const summary = await fetch(`http://127.0.0.1:${port}/api/summary`).then((r) => r.json());
      assert.ok((summary.total_runs ?? summary.total ?? 0) >= 1, "seeded record must be visible via /api/summary");
    } finally {
      await new Promise((res) => server.close(res));
    }
  } finally {
    if (prev === undefined) delete process.env.UTS_COMPUTING_HOME;
    else process.env.UTS_COMPUTING_HOME = prev;
    fs.rmSync(home, { recursive: true, force: true });
  }
});
