import assert from "node:assert/strict";
import test from "node:test";
import { rankSweep } from "../../dist/ops/jobs/sweep.js";

test("rankSweep joins metric values to configs and returns the top-k (max mode)", () => {
  // expandGrid odometer order: 0:{lr0.1,bs32} 1:{lr0.1,bs64} 2:{lr0.01,bs32} 3:{lr0.01,bs64}
  const parameters = { lr: [0.1, 0.01], bs: [32, 64] };
  const results = [
    { index: 0, value: 0.9 },
    { index: 1, value: 0.7 },
    { index: 2, value: 0.95 },
    { index: 3, value: 0.6 }
  ];
  const report = rankSweep({ parameters, results, mode: "max", topK: 2 });
  assert.equal(report.metric_mode, "max");
  assert.equal(report.total, 4);
  assert.equal(report.ranked[0].index, 2);
  assert.equal(report.ranked[0].value, 0.95);
  assert.deepEqual(report.ranked[0].params, { lr: 0.01, bs: 32 });
  assert.equal(report.top_k_params.length, 2);
  assert.deepEqual(report.top_k_params[0], { lr: 0.01, bs: 32 });
});

test("rankSweep min mode ranks ascending and skips out-of-range indices", () => {
  const parameters = { lr: [0.1, 0.01] };
  const results = [
    { index: 0, value: 5 },
    { index: 1, value: 2 },
    { index: 9, value: 0.1 }
  ];
  const report = rankSweep({ parameters, results, mode: "min", topK: 1 });
  assert.equal(report.total, 2);
  assert.equal(report.ranked[0].index, 1);
  assert.deepEqual(report.top_k_params[0], { lr: 0.01 });
});
