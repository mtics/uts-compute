import fs from "node:fs";
import path from "node:path";

// C-5 postbuild: tsc does NOT copy non-.ts assets, so after the TS build we copy the node-side
// progressor.py into dist/ so progressor-source.ts (which reads the dist copy) ships the exact bytes
// the golden snapshot pins. Runs via package.json `postbuild` (npm runs it AFTER `build`), keeping the
// order tsc -> copy deterministic.
const src = "mcp-server/src/ops/scheduler/node/progressor.py";
const dst = "mcp-server/dist/ops/scheduler/node/progressor.py";
fs.mkdirSync(path.dirname(dst), { recursive: true });
fs.copyFileSync(src, dst);
