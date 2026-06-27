import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runIhpcPreflight } from "../../dist/ops/jobs/ihpc-preflight.js";

// P3 (ingest): ihpc.campaign.preflight can validate an operator's EXISTING hand-written queue YAML by
// FILE PATH, not only a pre-parsed object. The path is confined to the project root (assertInsideProject),
// read + YAML-parsed locally, then run through the SAME validateQueueContract. No SSH on this path.

// A scratch queue YAML written INSIDE the project root (the confinement boundary). We place it under the
// gitignored .uts-computing/ scratch area used by other tests and clean it up after.
const here = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(here, "..", "..", "..");
const scratchDir = path.join(projectRoot, ".uts-computing", "preflight-ingest-test");
const queuePath = path.join(scratchDir, "queue.ingest.yaml");

function writeQueue(text) {
  fs.mkdirSync(scratchDir, { recursive: true });
  fs.writeFileSync(queuePath, text, "utf8");
}

test("preflight ingests an existing queue YAML file path and validates it (no SSH)", async () => {
  writeQueue(
    [
      "my_nodes:",
      "  - turing2",
      "experiments:",
      "  - name: e1",
      "    command: \"python train.py --dataset MovieLens\"",
      "    requires_gpu: true"
    ].join("\n") + "\n"
  );
  const rel = path.relative(projectRoot, queuePath);
  const result = await runIhpcPreflight({ queueYamlPath: rel, datasetDirs: ["MovieLens"] });
  assert.equal(result.preflight.valid, true);
  assert.equal(result.preflight.findings.filter((f) => f.level === "error").length, 0);
});

test("preflight ingest surfaces contract errors from the file (dataset typo)", async () => {
  writeQueue(
    [
      "my_nodes:",
      "  - turing2",
      "experiments:",
      "  - name: e1",
      "    command: \"python train.py --dataset MovieLens\"",
      "    requires_gpu: true"
    ].join("\n") + "\n"
  );
  const rel = path.relative(projectRoot, queuePath);
  const result = await runIhpcPreflight({ queueYamlPath: rel, datasetDirs: ["ML"] }); // MovieLens not present
  assert.equal(result.preflight.valid, false);
  assert.ok(result.preflight.findings.some((f) => /dataset|MovieLens/.test(f.message)));
});

test("preflight ingest rejects a path that escapes the project root (no arbitrary traversal)", async () => {
  await assert.rejects(
    () => runIhpcPreflight({ queueYamlPath: "../../../../etc/passwd" }),
    /inside the project root/i
  );
});

test("preflight rejects supplying BOTH queueYaml and queueYamlPath", async () => {
  await assert.rejects(
    () => runIhpcPreflight({ queueYaml: { my_nodes: ["x"], experiments: [] }, queueYamlPath: "queue.yaml" }),
    /both|exactly one|queueYaml/i
  );
});

test("preflight rejects supplying NEITHER queueYaml nor queueYamlPath", async () => {
  await assert.rejects(() => runIhpcPreflight({}), /queueYaml|exactly one|require/i);
});

test("preflight ingest rejects a symlink inside the project that escapes via realpath", async () => {
  // assertInsideProject is lexical; a symlink that LIVES inside the project but POINTS outside must
  // still be refused by realpath confinement, so an operator can't ingest /etc/secrets via a link.
  fs.mkdirSync(scratchDir, { recursive: true });
  const outsideDir = fs.mkdtempSync(path.join(os.tmpdir(), "preflight-escape-"));
  const outsideTarget = path.join(outsideDir, "queue.yaml");
  fs.writeFileSync(outsideTarget, "my_nodes: [x]\nexperiments: []\n", "utf8");
  const link = path.join(scratchDir, "escape.yaml");
  try { fs.unlinkSync(link); } catch { /* fresh */ }
  fs.symlinkSync(outsideTarget, link);
  try {
    const rel = path.relative(projectRoot, link);
    await assert.rejects(
      () => runIhpcPreflight({ queueYamlPath: rel }),
      /must stay inside|inside the project/i
    );
  } finally {
    fs.rmSync(outsideDir, { recursive: true, force: true });
  }
});

test.after(() => {
  try {
    fs.rmSync(scratchDir, { recursive: true, force: true });
  } catch {
    /* best-effort cleanup */
  }
});
