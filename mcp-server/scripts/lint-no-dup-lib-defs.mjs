#!/usr/bin/env node
// CI guard against the duplication colony coming back (see docs/archive/duplication-audit-2026-06.md).
//
// lib/ is the charter-wide home for the server's low-level primitives. The colony that this audit
// remediated grew because every large module appended its own private copy of an assertSafe* /
// normalize* / redact* / default*Executor helper to the bottom of the file, so copy-paste was the
// path of least resistance. This check makes that path FAIL CI: if any module under mcp-server/src
// (outside lib/ itself) locally DEFINES a top-level function, const, interface, or type whose name is
// already exported from a lib/ module, the build breaks here. Re-exporting (`export { name } from
// "./lib/..."`) and importing are fine — only a fresh local definition that shadows the shared name
// is rejected.
//
// Wired into the npm `lint` script and `pretest`, so a re-introduced duplicate is caught before the
// test suite even runs. Pure Node, no extra dependency.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const srcDir = path.resolve(here, "..", "src");
const libDir = path.join(srcDir, "lib");

// Collect every `.ts` file under a directory tree.
function collectTsFiles(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectTsFiles(full));
    } else if (entry.isFile() && full.endsWith(".ts")) {
      out.push(full);
    }
  }
  return out;
}

// Names that lib/ exports as a top-level `export function NAME`, `export const NAME`,
// `export interface NAME`, or `export type NAME`. These are the canonical, single-home definitions;
// nothing else in the server may re-define a name in this set. The set is collected structurally from
// EVERY `.ts` under src/lib (shared, process, redact, evidence, ssh, …), so a new lib module's exports
// — e.g. lib/ssh.ts's sshOuterHopFlags/sshNodeHopFlags/SSH_INNER_HOP_HOST_KEY — are covered the moment
// the file lands, with no list to maintain here.
function libExportedNames() {
  const names = new Set();
  const fnRe = /^export\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gm;
  const constRe = /^export\s+const\s+([A-Za-z_$][\w$]*)\s*[:=]/gm;
  const interfaceRe = /^export\s+interface\s+([A-Za-z_$][\w$]*)\b/gm;
  const typeRe = /^export\s+type\s+([A-Za-z_$][\w$]*)\s*[<=]/gm;
  for (const file of collectTsFiles(libDir)) {
    const text = fs.readFileSync(file, "utf8");
    for (const match of text.matchAll(fnRe)) {
      names.add(match[1]);
    }
    for (const match of text.matchAll(constRe)) {
      names.add(match[1]);
    }
    for (const match of text.matchAll(interfaceRe)) {
      names.add(match[1]);
    }
    for (const match of text.matchAll(typeRe)) {
      names.add(match[1]);
    }
  }
  return names;
}

// A LOCAL DEFINITION of `name` in `text`: a top-level `function name(` / `async function name(`, a
// top-level `const name =` / `const name:`, an `interface name` / `interface name<…>`, or a
// `type name =` / `type name<…>`. Crucially this does NOT match a re-export — `export { name } from
// "..."` / `export type { name } from "..."` has no `function`/`const`/`interface` keyword directly
// before the bare name (the braces sit between), so it is allowed. The `type name` branch requires a
// `=`/`<` after the name, so a re-export alias `export type Foo = Executor` (a DIFFERENT name) and the
// `export type { name } from "..."` form (braces, not the name) are both unaffected. We match at the
// start of a line (optionally preceded by `export `/`async `) to stay anchored to declarations.
function findLocalDefinition(text, name) {
  const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const fnRe = new RegExp(`^(?:export\\s+)?(?:async\\s+)?function\\s+${escaped}\\b`, "m");
  const constRe = new RegExp(`^(?:export\\s+)?const\\s+${escaped}\\s*[:=]`, "m");
  const interfaceRe = new RegExp(`^(?:export\\s+)?interface\\s+${escaped}\\b`, "m");
  const typeRe = new RegExp(`^(?:export\\s+)?type\\s+${escaped}\\s*[<=]`, "m");
  const fnMatch = fnRe.exec(text);
  if (fnMatch) {
    return text.slice(0, fnMatch.index).split("\n").length;
  }
  const constMatch = constRe.exec(text);
  if (constMatch) {
    return text.slice(0, constMatch.index).split("\n").length;
  }
  const interfaceMatch = interfaceRe.exec(text);
  if (interfaceMatch) {
    return text.slice(0, interfaceMatch.index).split("\n").length;
  }
  const typeMatch = typeRe.exec(text);
  if (typeMatch) {
    return text.slice(0, typeMatch.index).split("\n").length;
  }
  return null;
}

const canonical = libExportedNames();
if (canonical.size === 0) {
  console.error("lint-no-dup-lib-defs: found no exported names under src/lib — refusing to pass blindly.");
  process.exit(1);
}

const violations = [];
for (const file of collectTsFiles(srcDir)) {
  // Skip lib/ itself — it is the home of these names.
  if (file.startsWith(libDir + path.sep)) {
    continue;
  }
  const text = fs.readFileSync(file, "utf8");
  for (const name of canonical) {
    const line = findLocalDefinition(text, name);
    if (line !== null) {
      violations.push({ file: path.relative(path.resolve(here, "..", ".."), file), line, name });
    }
  }
}

if (violations.length > 0) {
  console.error("lint-no-dup-lib-defs: a module re-defines a name that src/lib already exports.");
  console.error("Re-route the caller to import from lib/ (or re-export) instead of defining a copy.\n");
  for (const v of violations.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line)) {
    console.error(`  ${v.file}:${v.line}  re-defines lib export '${v.name}'`);
  }
  console.error(`\n${violations.length} duplicate definition(s). See docs/archive/duplication-audit-2026-06.md.`);
  process.exit(1);
}

console.log(
  `lint-no-dup-lib-defs: OK — no module re-defines any of the ${canonical.size} names exported from src/lib.`
);
