// Regression tests for projectRoot anchoring (Bug M12/L17).
//
// projectRoot is the single anchor every other module resolves external files against
// (schemas/, profiles/profiles.example.yaml, templates/, package.json). It was historically a
// FIXED dist-depth `resolve(distDir, "../../..")`, which renders "<outside-project>" the moment the
// compiled-module layout shifts. It now walks up to the directory whose package.json declares
// `name: "uts-compute"`, so this test pins that load-bearing invariant: projectRoot must contain the
// uts-compute package.json, the schemas/ dir, and profiles/profiles.example.yaml.
import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs";
import path from "node:path";
import { projectRoot } from "../../dist/core/paths.js";

test("projectRoot is absolute", () => {
  assert.ok(path.isAbsolute(projectRoot), `projectRoot must be absolute, got ${projectRoot}`);
});

test("projectRoot contains the uts-compute package.json marker", () => {
  const pkgPath = path.join(projectRoot, "package.json");
  assert.ok(fs.existsSync(pkgPath), `expected package.json at ${pkgPath}`);
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  assert.equal(pkg.name, "uts-compute", `projectRoot package.json must declare name "uts-compute", got ${pkg.name}`);
});

test("projectRoot contains schemas/ (schema resolution anchor)", () => {
  const schemasDir = path.join(projectRoot, "schemas");
  assert.ok(fs.existsSync(schemasDir), `expected schemas/ under projectRoot at ${schemasDir}`);
  assert.ok(fs.statSync(schemasDir).isDirectory(), "schemas/ must be a directory");
});

test("projectRoot contains profiles/profiles.example.yaml (example resolution anchor)", () => {
  const examplePath = path.join(projectRoot, "profiles", "profiles.example.yaml");
  assert.ok(fs.existsSync(examplePath), `expected profiles/profiles.example.yaml under projectRoot at ${examplePath}`);
});
