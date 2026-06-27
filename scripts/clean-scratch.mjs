#!/usr/bin/env node
// Remove the gitignored .uts-computing/ test scratch.
//
// The test suite creates throwaway runtime dirs under .uts-computing/ on every run (per-file
// `tempRuntimeDir` helpers) and also writes fixtures into the fixed default dirs (.uts-computing/
// quotas, runs). None of it is cleaned up, so across many iterative runs it accumulates into tens
// of thousands of stray entries — enough to slow filesystem traversal and push a protocol test past
// its timeout under full-suite load. Wired into `pretest` and `posttest`, this clears the scratch
// before each `npm test` so the suite always starts fresh, and after a successful run so the WebUI
// does not render test-created snapshots/runs as local user evidence. The tests (and the server)
// recreate what they need on demand. The whole tree is regenerable and gitignored, so removal is safe.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = path.join(repoRoot, ".uts-computing");

// Safety: only ever remove a directory literally named ".uts-computing" that sits directly inside
// this repository — never a parent, a symlink target outside the repo, or anything unexpected.
if (path.dirname(scratch) !== repoRoot || path.basename(scratch) !== ".uts-computing") {
  console.error(`clean-scratch: refusing to remove unexpected path: ${scratch}`);
  process.exit(1);
}

if (fs.existsSync(scratch)) {
  fs.rmSync(scratch, { recursive: true, force: true });
  console.log("clean-scratch: removed .uts-computing/ test scratch");
} else {
  console.log("clean-scratch: nothing to remove");
}
