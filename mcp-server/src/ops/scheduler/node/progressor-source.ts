import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The progressor is shipped over SSH stdin exactly like SUPERVISOR_PY (spec 2.8). We read the
// committed .py source once at import time so the wire bytes equal the file the golden snapshot
// pins (tests/fixtures/remote-python/PROGRESSOR_PY.py). At runtime `here` is dist/ops/scheduler/node;
// the postbuild copy (scripts/copy-progressor.mjs) places progressor.py alongside this module there.
const here = path.dirname(fileURLToPath(import.meta.url));
export const PROGRESSOR_PY: string = fs.readFileSync(path.join(here, "progressor.py"), "utf8");
