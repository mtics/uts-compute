#!/usr/bin/env node
//
// run-pytest.mjs — run the vendored ihpc-scheduler/ Python test suite.
//
// The vendored pyproject.toml sets `[tool.pytest.ini_options] pythonpath = ["."]`,
// so pytest must be invoked WITH cwd `ihpc-scheduler/` — that makes `import
// src.scheduler…` / `import src.scanner…` resolve against the vendored layout
// (`ihpc-scheduler/src/{scheduler,scanner}/`). Do NOT set PYTHONPATH=.../src and
// do NOT `pip install -e`: both expose a bare `scheduler` namespace and break the
// vendored `from src.scheduler…` imports.
//
// This dev environment does not ship pytest/pyyaml/paramiko (paramiko needs a
// crypto build on Python 3.14); the vendored suite is verified by the GitHub
// Actions `python` job (.github/workflows/ci.yml), not run locally. When pytest
// is missing this script prints a clear `pytest-missing` issue and exits non-zero
// so CI fails loudly and a local dev sees the guidance.
//
// Mirrors scripts/validate-plugin-package.mjs conventions
// (ESM, fileURLToPath, { ok, checked, issues } result shape, isCli guard,
// exit(1) on failure).
//
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const VENDOR_DIRNAME = "ihpc-scheduler";
const PYTHON = process.env.PYTHON ?? "python3";

// The repo root is two levels up from this script (scripts/run-pytest.mjs).
const repoRoot = path.resolve(fileURLToPath(import.meta.url), "..", "..");

// Is pytest importable by the chosen interpreter? `python -m pytest --version`
// exits 0 when present, and prints `No module named pytest` (exit 1) when not.
function pytestAvailable() {
  const probe = spawnSync(PYTHON, ["-m", "pytest", "--version"], {
    cwd: repoRoot,
    encoding: "utf8"
  });
  return probe.status === 0;
}

export function runPytest(root = repoRoot) {
  const pluginRoot = path.resolve(root);
  const vendorDir = path.join(pluginRoot, VENDOR_DIRNAME);
  const issues = [];
  const checked = [`${VENDOR_DIRNAME}/tests`];

  if (!fs.existsSync(vendorDir) || !fs.statSync(vendorDir).isDirectory()) {
    issues.push({
      code: "vendor-dir-missing",
      path: vendorDir,
      message: `Vendored ${VENDOR_DIRNAME}/ directory is missing`
    });
    return { ok: false, root: pluginRoot, checked, issues };
  }

  if (!pytestAvailable()) {
    issues.push({
      code: "pytest-missing",
      path: vendorDir,
      message:
        `pytest is not available to ${PYTHON}. The vendored suite is verified by ` +
        `the GitHub Actions python job; to run it locally install the deps ` +
        `(pip install pytest pyyaml paramiko) and re-run \`npm run test:python\`.`
    });
    return { ok: false, root: pluginRoot, checked, issues };
  }

  // Anchor at ihpc-scheduler/ so the vendored pyproject pythonpath = ["."] makes
  // `import src.scheduler…` resolve. Stream pytest output to the console.
  const result = spawnSync(PYTHON, ["-m", "pytest", "tests", "-q"], {
    cwd: vendorDir,
    stdio: "inherit"
  });

  if (result.status !== 0) {
    issues.push({
      code: "pytest-failed",
      path: vendorDir,
      message: `pytest exited with status ${result.status ?? "<signal>"}`
    });
  }

  return { ok: issues.length === 0, root: pluginRoot, checked, issues };
}

const isCli = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (isCli) {
  const result = runPytest(repoRoot);
  if (!result.ok) {
    console.error(JSON.stringify(result, null, 2));
    process.exit(1);
  }
  console.log(JSON.stringify(result, null, 2));
}
