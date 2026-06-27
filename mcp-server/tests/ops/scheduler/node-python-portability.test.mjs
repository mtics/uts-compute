import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// ---------------------------------------------------------------------------------------------------
// NODE PYTHON FLOOR = 3.6 (RHEL7 / CentOS7 system python3). WHY this guard exists:
//
// The iHPC compute nodes run the stock RHEL7/CentOS7 system `python3`, which is Python **3.6**. Every
// inline program the brain ships to a node over SSH (`python3 -` on stdin, or the per-job WRAPPER_SH
// heredoc) is parsed and run by THAT interpreter, NOT by the local dev/CI python (3.7+). A field run hit
// `Popen.__init__() got an unexpected keyword argument 'capture_output'` because `subprocess.run`'s
// `capture_output=`/`text=` kwargs were only added in Python **3.7** — on 3.6 they are forwarded to
// `Popen(**kwargs)` and blow up. It went uncaught because (a) the local test python is 3.7+ and (b) the
// node self-launch path was rarely exercised end-to-end.
//
// This is a STATIC guard: it reads the SOURCE of every inline node-python surface and forbids the
// 3.7+-only tokens that silently break on 3.6. f-strings (3.6) are fine — the floor is 3.6, not 3.5.
// If you need a newer construct, you must FIRST raise the documented node floor (and prove the field
// nodes have it), not just edit around this test.
//
// Forbidden 3.7+-only tokens (with the version each was introduced):
//   - capture_output=   (subprocess.run kwarg)      -> 3.7
//   - text=True         (subprocess run/Popen kwarg) -> 3.7   (use universal_newlines=True on 3.6)
//   - .fromisoformat(   (datetime.fromisoformat)     -> 3.7
//   - :=                (walrus / assignment expr)    -> 3.8
//   - {name=}           (f-string `=` debug specifier)-> 3.8
// ---------------------------------------------------------------------------------------------------

const here = path.dirname(fileURLToPath(import.meta.url));
const SRC_OPS = path.join(here, "..", "..", "..", "src", "ops");

// Every inline node-python surface, read as raw SOURCE text. We glob the seam *-py.ts (CANARY_PY today,
// plus any node-usage-py.ts / future seam py shipped on other branches), the progressor.py file, and the
// SUPERVISOR_PY string carved out of ihpc-start.ts. Reading the source (not the AST) is the point: a 3.7+
// token here would ship to a 3.6 node and fail there, where no local python can catch it.
function readSurfaces() {
  const surfaces = [];

  // (1) seam/*-py.ts — each exports one or more inline-python String.raw constants (CANARY_PY, and
  //     node-usage-py.ts / similar when present on other branches). We take the WHOLE file text: the
  //     python lives inside String.raw template literals, so the tokens we forbid appear verbatim.
  const seamDir = path.join(SRC_OPS, "scheduler", "seam");
  for (const name of fs.readdirSync(seamDir)) {
    if (name.endsWith("-py.ts")) {
      surfaces.push({ name: `seam/${name}`, text: fs.readFileSync(path.join(seamDir, name), "utf8") });
    }
  }

  // (2) the progressor — the resident on-node program (its own .py file, shipped verbatim over SSH).
  const progressor = path.join(SRC_OPS, "scheduler", "node", "progressor.py");
  surfaces.push({ name: "scheduler/node/progressor.py", text: fs.readFileSync(progressor, "utf8") });

  // (3) SUPERVISOR_PY — the single-run on-node supervisor, an inline String.raw in ihpc-start.ts. We
  //     slice the exported template so we scan the python body, not the surrounding TS.
  const ihpcStart = fs.readFileSync(path.join(SRC_OPS, "jobs", "ihpc-start.ts"), "utf8");
  const marker = "export const SUPERVISOR_PY = String.raw`";
  const start = ihpcStart.indexOf(marker);
  assert.notEqual(start, -1, "could not locate SUPERVISOR_PY in ihpc-start.ts (rename? update this guard)");
  const bodyStart = start + marker.length;
  const end = ihpcStart.indexOf("`;", bodyStart);
  assert.notEqual(end, -1, "could not find the end of the SUPERVISOR_PY template literal");
  surfaces.push({ name: "jobs/ihpc-start.ts:SUPERVISOR_PY", text: ihpcStart.slice(bodyStart, end) });

  return surfaces;
}

// Each forbidden token is a regex + a human reason. The `text=` matcher is deliberately scoped to
// `text = True` (the subprocess kwarg) so it does NOT false-positive on unrelated identifiers that
// merely contain the substring "text" (e.g. a `context=` kwarg or a `plaintext = ...` assignment).
const FORBIDDEN = [
  { token: "capture_output", re: /\bcapture_output\s*=/, why: "subprocess.run capture_output= is 3.7+; use stdout=subprocess.PIPE, stderr=subprocess.PIPE" },
  { token: "text=True", re: /\btext\s*=\s*True\b/, why: "subprocess text=True is 3.7+; use universal_newlines=True on 3.6" },
  { token: "fromisoformat", re: /\bfromisoformat\s*\(/, why: "datetime.fromisoformat is 3.7+; parse with time.strptime/calendar.timegm on 3.6" },
  { token: "walrus :=", re: /:=/, why: "the walrus operator := is 3.8+; assign on a separate line" },
  { token: "f-string {x=} debug", re: /\{[A-Za-z_][A-Za-z0-9_.]*=\}/, why: "the f-string `=` debug specifier {x=} is 3.8+; write {x} or 'x=' + str(x)" }
];

const SURFACES = readSurfaces();

test("there is at least one inline node-python surface to guard (the glob/slice actually matched)", () => {
  assert.ok(SURFACES.length >= 2, `expected the seam + progressor + supervisor surfaces, found ${SURFACES.length}`);
  const names = SURFACES.map((s) => s.name);
  assert.ok(names.some((n) => n.includes("progressor.py")), "progressor.py surface missing");
  assert.ok(names.some((n) => n.includes("SUPERVISOR_PY")), "SUPERVISOR_PY surface missing");
  assert.ok(names.some((n) => n.includes("canary-py.ts")), "canary-py.ts surface missing");
});

for (const { token, re, why } of FORBIDDEN) {
  test(`no inline node-python surface uses the 3.7+-only token: ${token}`, () => {
    const offenders = [];
    for (const surface of SURFACES) {
      const lines = surface.text.split("\n");
      lines.forEach((line, i) => {
        if (re.test(line)) offenders.push(`${surface.name}:${i + 1}  ${line.trim()}`);
      });
    }
    assert.equal(
      offenders.length,
      0,
      `node python floor is 3.6 (RHEL7) — ${why}\nOffending lines:\n${offenders.join("\n")}`
    );
  });
}
