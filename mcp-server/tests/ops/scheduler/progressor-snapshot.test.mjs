import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync, execSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.join(here, "..", "..", "..", "src", "ops", "scheduler", "node", "progressor.py");
const GOLDEN = path.join(here, "..", "..", "fixtures", "remote-python", "PROGRESSOR_PY.py");

test("progressor.py parses under python3 (no syntax errors, mirrors remote-python golden discipline)", () => {
  const r = spawnSync("python3", ["-c", `import ast,sys; ast.parse(open(${JSON.stringify(SRC)}).read())`], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
});

test("progressor.py matches its committed golden byte-for-byte (regenerate deliberately on change)", () => {
  const live = fs.readFileSync(SRC, "utf8");
  if (!fs.existsSync(GOLDEN)) {
    fs.mkdirSync(path.dirname(GOLDEN), { recursive: true });
    fs.writeFileSync(GOLDEN, live);
  }
  assert.equal(live, fs.readFileSync(GOLDEN, "utf8"),
    "progressor.py changed — review the diff, then `cp src/.../progressor.py tests/fixtures/remote-python/PROGRESSOR_PY.py`");
});

test("dist progressor.py equals src byte-for-byte (postbuild copy ran)", () => {
  const DIST = path.join(here, "..", "..", "..", "dist", "ops", "scheduler", "node", "progressor.py");
  if (!fs.existsSync(DIST)) execSync("npm run build", { stdio: "ignore" });
  assert.equal(fs.readFileSync(DIST, "utf8"), fs.readFileSync(SRC, "utf8"),
    "dist/progressor.py diverged from src — postbuild copy did not run; check scripts/copy-progressor.mjs + package.json postbuild");
});
