import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { SAFE_RUN_ID_PATTERN } from "../../dist/core/ids.js";

// The same shapes are inlined into more than one schema (there is no codegen). These guards fail if
// one copy is edited without the other, so the duplicated definitions can't silently drift apart.
const schemasDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..", "schemas");
const read = (name) => JSON.parse(fs.readFileSync(path.join(schemasDir, name), "utf8"));

test("retry_lineage $defs stays identical between planned-job and run-record", () => {
  const planned = read("planned-job.schema.json").$defs?.retry_lineage;
  const run = read("run-record.schema.json").$defs?.retry_lineage;
  assert.ok(planned && run, "both schemas must define $defs.retry_lineage");
  assert.deepEqual(planned, run, "retry_lineage drifted between planned-job and run-record $defs");
});

test("job_spec body stays identical between job-spec.schema.json and planned-job $defs.job_spec", () => {
  const standalone = read("job-spec.schema.json");
  const inlined = read("planned-job.schema.json").$defs?.job_spec;
  assert.ok(inlined, "planned-job must define $defs.job_spec");
  // Compare the body only; the standalone file additionally carries $id/$schema/title metadata.
  const body = (s) => ({
    type: s.type,
    required: s.required,
    additionalProperties: s.additionalProperties,
    properties: s.properties
  });
  assert.deepEqual(body(standalone), body(inlined), "job_spec body drifted between the standalone schema and planned-job $defs");
});

// The run-id grammar lives in ONE place (core/ids.ts SAFE_RUN_ID_PATTERN). Every run-id `pattern`
// literal carried by a JSON Schema MUST equal SAFE_RUN_ID_PATTERN.source, or a name assertSafeRunId
// admits (e.g. `MMPFedRec_Cards_lr0.001_mainhpo`) is rejected at schema validation — defeating the P0
// run-id relaxation on the plan/sweep/lineage path. This sweep finds every run-id-grammar literal
// across the schemas that carry one and pins them all to the code's source of truth.
test("every run-id pattern literal in the schemas equals SAFE_RUN_ID_PATTERN.source", () => {
  const expected = SAFE_RUN_ID_PATTERN.source;
  // (schema file, JSON pointer-ish path, the pattern value) for every run-id-grammar carrier.
  const runIdPatternLocations = [
    ["job-spec.schema.json", "properties.run_id.pattern", read("job-spec.schema.json").properties.run_id.pattern],
    [
      "planned-job.schema.json",
      "properties.run_id.pattern",
      read("planned-job.schema.json").properties?.run_id?.pattern
    ],
    [
      "planned-job.schema.json",
      "$defs.job_spec.properties.run_id.pattern",
      read("planned-job.schema.json").$defs?.job_spec?.properties?.run_id?.pattern
    ],
    [
      "planned-job.schema.json",
      "$defs.retry_lineage.properties.source_run_id.pattern",
      read("planned-job.schema.json").$defs?.retry_lineage?.properties?.source_run_id?.pattern
    ],
    [
      "planned-job.schema.json",
      "$defs.sweep_retry_lineage.properties.source_run_id.pattern",
      read("planned-job.schema.json").$defs?.sweep_retry_lineage?.properties?.source_run_id?.pattern
    ],
    [
      "run-record.schema.json",
      "$defs.retry_lineage.properties.source_run_id.pattern",
      read("run-record.schema.json").$defs?.retry_lineage?.properties?.source_run_id?.pattern
    ],
    [
      "run-record.schema.json",
      "$defs.sweep_retry_lineage.properties.source_run_id.pattern",
      read("run-record.schema.json").$defs?.sweep_retry_lineage?.properties?.source_run_id?.pattern
    ],
    // The transfer path validates run_id through assertSafeRunId too (ops/data/transfer.ts), so its
    // run_id schema literals must track the same grammar or a real campaign name fails transfer
    // schema validation while passing the code check — the identical divergence on the transfer path.
    ["transfer-plan.schema.json", "properties.run_id.pattern", read("transfer-plan.schema.json").properties?.run_id?.pattern],
    [
      "planned-transfer.schema.json",
      "properties.run_id.pattern",
      read("planned-transfer.schema.json").properties?.run_id?.pattern
    ],
    [
      "transfer-execution-record.schema.json",
      "properties.run_id.pattern",
      read("transfer-execution-record.schema.json").properties?.run_id?.pattern
    ]
  ];
  for (const [file, where, value] of runIdPatternLocations) {
    assert.ok(typeof value === "string", `${file} ${where} should carry a run-id pattern literal`);
    assert.equal(value, expected, `${file} ${where} drifted from SAFE_RUN_ID_PATTERN.source`);
  }
});
