import assert from "node:assert/strict";
import test from "node:test";
import {
  canonicalizeProjectName,
  projectHashFor,
  gitProjectName,
  resolveProjectIdentity
} from "../../dist/ops/profiles/project.js";

test("canonicalizeProjectName slugifies and defaults empty input to unassigned", () => {
  assert.equal(canonicalizeProjectName("My Cool Project"), "my-cool-project");
  assert.equal(canonicalizeProjectName("  Diffusion_Ablation v2 "), "diffusion-ablation-v2");
  assert.equal(canonicalizeProjectName("UTS//compute@@2026"), "utscompute2026");
  assert.equal(canonicalizeProjectName("   "), "unassigned");
  assert.equal(canonicalizeProjectName("!!!"), "unassigned");
});

test("projectHashFor is deterministic, prefixed, and 12 hex chars", () => {
  const hash = projectHashFor("my-cool-project");
  assert.match(hash, /^proj-[0-9a-f]{12}$/);
  assert.equal(projectHashFor("my-cool-project"), hash);
  assert.notEqual(projectHashFor("other-project"), hash);
});

test("gitProjectName returns the repo toplevel basename, or null outside a repo", () => {
  const inRepo = (args) =>
    args.join(" ") === "rev-parse --show-toplevel"
      ? { ok: true, stdout: "/Users/x/code/uts-computing-platform" }
      : { ok: false, stdout: "" };
  assert.equal(gitProjectName(inRepo), "uts-computing-platform");
  assert.equal(gitProjectName(() => ({ ok: false, stdout: "" })), null);
});

test("resolveProjectIdentity derives from git, falling back to unassigned", () => {
  const gitRunner = (args) =>
    args.includes("--show-toplevel") ? { ok: true, stdout: "/home/u/Diffusion Ablation" } : { ok: false, stdout: "" };
  const fromGit = resolveProjectIdentity(gitRunner);
  assert.equal(fromGit.project, "diffusion-ablation");
  assert.equal(fromGit.source, "git");
  assert.equal(fromGit.project_hash, projectHashFor("diffusion-ablation"));

  const noGit = resolveProjectIdentity(() => ({ ok: false, stdout: "" }));
  assert.equal(noGit.project, "unassigned");
  assert.equal(noGit.source, "unassigned");
  assert.equal(noGit.project_hash, projectHashFor("unassigned"));
});
