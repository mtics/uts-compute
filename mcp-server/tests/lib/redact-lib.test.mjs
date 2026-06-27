import assert from "node:assert/strict";
import test from "node:test";
import {
  maskCommandArgs,
  maskHostAlias,
  redactLocalHome,
  redactProjectRoot,
  redactWithTokens,
  summarizeRemoteFailure
} from "../../dist/lib/redact.js";
import { maskUserRootPath } from "../../dist/core/config.js";

// ---------------------------------------------------------------------------------------------------
// These snapshots pin the emitted, redacted command object / failure summary that each caller
// produces, reconstructed from the exact replacement spec + mode that caller now passes to the shared
// helper. The pre-refactor copies produced these same values; the assertions below are the contract
// that the consolidation must keep. Crucially they prove that NOTHING that was masked before becomes
// unmasked, and that the security-relevant exact-vs-substring distinction is preserved.
// ---------------------------------------------------------------------------------------------------

const HOST = "uts-hpc-access";
const USER_HOST = "alice@uts-ihpc-access";
const NODE = "mars001";
const SPEC = "eyJraW5kIjoic3VwZXJ2aXNvciJ9"; // base64url-ish standalone argv token

test("maskCommandArgs exact mode — submit ssh argv (host alias only)", () => {
  const args = ["-o", "BatchMode=yes", HOST, "qsub", "job.pbs"];
  const masked = maskCommandArgs(args, [{ match: HOST, replace: "<profile-host>" }], { mode: "exact" });
  assert.deepEqual(masked, ["-o", "BatchMode=yes", "<profile-host>", "qsub", "job.pbs"]);
  assert.equal(masked.includes(HOST), false, "host alias must not survive");
});

test("maskCommandArgs exact mode — ihpc-start ssh argv (host + compute node + supervisor spec)", () => {
  const args = ["-o", "BatchMode=yes", USER_HOST, "ssh", NODE, "python3", "-", SPEC];
  const masked = maskCommandArgs(
    args,
    [
      { match: USER_HOST, replace: "<profile-host>" },
      { match: NODE, replace: "<ihpc-compute-node>" },
      { match: SPEC, replace: "<supervisor-spec>" }
    ],
    { mode: "exact" }
  );
  assert.deepEqual(masked, [
    "-o",
    "BatchMode=yes",
    "<profile-host>",
    "ssh",
    "<ihpc-compute-node>",
    "python3",
    "-",
    "<supervisor-spec>"
  ]);
  assert.equal(masked.some((a) => a.includes("alice") || a === NODE || a === SPEC), false);
});

test("maskCommandArgs exact mode — artifacts ssh argv (host + artifact spec)", () => {
  const args = [USER_HOST, "python3", "-", SPEC];
  const masked = maskCommandArgs(
    args,
    [
      { match: USER_HOST, replace: "<profile-host>" },
      { match: SPEC, replace: "<artifact-spec>" }
    ],
    { mode: "exact" }
  );
  assert.deepEqual(masked, ["<profile-host>", "python3", "-", "<artifact-spec>"]);
});

test("maskCommandArgs exact mode does NOT rewrite an arg that merely contains the alias as a substring", () => {
  // A path-prefix arg containing the alias is left intact under exact mode — the security reason the
  // exact callers (submit/ihpc/artifacts) must NOT use substring mode.
  const args = [`${HOST}-backup`, HOST];
  const masked = maskCommandArgs(args, [{ match: HOST, replace: "<profile-host>" }], { mode: "exact" });
  assert.deepEqual(masked, [`${HOST}-backup`, "<profile-host>"]);
});

test("maskCommandArgs substring mode — transfer rsync argv (host + roots + project, in order)", () => {
  const PROJECT = "/Users/runner/work/uts-computing-platform";
  const SRC = "/shared/homes/${USER}/experiments/run-1";
  const DST = `${PROJECT}/.uts-computing/transfers/run-1/files`;
  const args = [
    "-a",
    `${USER_HOST}:${SRC}/`,
    `${PROJECT}/.uts-computing/transfers/run-1/files/`
  ];
  const masked = maskCommandArgs(
    args,
    [
      { match: USER_HOST, replace: "<profile-host>" },
      { match: SRC, replace: maskUserRootPath(SRC) },
      { match: DST, replace: "<endpoint>" },
      { match: PROJECT, replace: "<project>" }
    ],
    { mode: "substring" }
  );
  // host alias and embedded ${USER} are gone; the local project root is masked to <project>.
  assert.equal(masked.some((a) => a.includes("alice@") || a.includes("${USER}")), false);
  assert.equal(
    masked.some((a) => a.includes("/Users/runner/work/uts-computing-platform/.uts-computing")),
    false,
    "the local project root must be masked to <project>"
  );
  assert.equal(masked[1], "<profile-host>:/shared/homes/<user>/experiments/run-1/");
});

// maskHostAlias names the universal hostAlias -> '<profile-host>' exact mask shared by submit / jobs /
// ihpc-start / artifacts; the `extra` masks layer AFTER the host mask, in order, exactly as the prior
// literal arrays did. These reproduce the four redactors' outputs byte-for-byte.
test("maskHostAlias — submit/jobs (host alias only)", () => {
  const args = ["-o", "BatchMode=yes", HOST, "qsub", "job.pbs"];
  assert.deepEqual(maskHostAlias(args, HOST), ["-o", "BatchMode=yes", "<profile-host>", "qsub", "job.pbs"]);
});

test("maskHostAlias — ihpc-start layers compute node + supervisor spec after the host mask", () => {
  const args = ["-o", "BatchMode=yes", USER_HOST, "ssh", NODE, "python3", "-", SPEC];
  const masked = maskHostAlias(args, USER_HOST, [
    { match: NODE, replace: "<ihpc-compute-node>" },
    { match: SPEC, replace: "<supervisor-spec>" }
  ]);
  assert.deepEqual(masked, [
    "-o",
    "BatchMode=yes",
    "<profile-host>",
    "ssh",
    "<ihpc-compute-node>",
    "python3",
    "-",
    "<supervisor-spec>"
  ]);
});

test("maskHostAlias — artifacts layers the artifact spec after the host mask", () => {
  const args = [USER_HOST, "python3", "-", SPEC];
  assert.deepEqual(maskHostAlias(args, USER_HOST, [{ match: SPEC, replace: "<artifact-spec>" }]), [
    "<profile-host>",
    "python3",
    "-",
    "<artifact-spec>"
  ]);
});

test("maskHostAlias is exact mode — an arg merely containing the alias as a substring is left intact", () => {
  assert.deepEqual(maskHostAlias([`${HOST}-backup`, HOST], HOST), [`${HOST}-backup`, "<profile-host>"]);
});

test("redactWithTokens — quotas: every token collapses to the single remote-user marker, after secret scrub", () => {
  const out = redactWithTokens("user alice on alice ran token=hunter2", ["alice"], () => "<redacted-remote-user>");
  // redactCommand first scrubs token=…, then every 'alice' occurrence is masked.
  assert.equal(out.includes("alice"), false);
  assert.equal(out.includes("hunter2"), false);
  assert.match(out, /token=<redacted>/);
  assert.match(out, /<redacted-remote-user>/);
});

test("redactWithTokens — jobs: path tokens map to <plan-log-path>, non-path tokens to <remote-job-id>", () => {
  const placeholder = (t) => (t.startsWith("/") ? "<plan-log-path>" : "<remote-job-id>");
  const out = redactWithTokens(
    "tail /shared/homes/x/logs/run.out for 12345.pbs",
    ["/shared/homes/x/logs/run.out", "12345.pbs"],
    placeholder
  );
  assert.equal(out.includes("/shared/homes/x/logs/run.out"), false);
  assert.equal(out.includes("12345.pbs"), false);
  assert.match(out, /<plan-log-path>/);
  assert.match(out, /<remote-job-id>/);
});

test("redactWithTokens skips empty tokens (no between-character match)", () => {
  const out = redactWithTokens("abc", ["", "b"], () => "X");
  assert.equal(out, "aXc");
});

test("summarizeRemoteFailure — bare wording (artifacts/jobs/transfer): timeout / scrubbed stderr / exit N", () => {
  const bare = {
    timedOut: "command timed out",
    failed: (s) => s,
    exited: (code) => `exit ${String(code)}`
  };
  assert.equal(summarizeRemoteFailure({ exitCode: null, stderr: "x", timedOut: true }, bare), "command timed out");
  assert.equal(summarizeRemoteFailure({ exitCode: 2, stderr: "  boom  ", timedOut: false }, bare), "boom");
  assert.equal(summarizeRemoteFailure({ exitCode: 7, stderr: "   ", timedOut: false }, bare), "exit 7");
  // secret in stderr is scrubbed by the shared summarizer's redactCommand pass.
  assert.equal(
    summarizeRemoteFailure({ exitCode: 1, stderr: "fatal token=sekret123value", timedOut: false }, bare).includes("sekret123value"),
    false
  );
});

test("summarizeRemoteFailure — labelled wording (submit/ihpc/access): <label> timed out / failed / exited", () => {
  const wording = {
    timedOut: "ssh true timed out",
    failed: (s) => `ssh true failed: ${s}`,
    exited: (code) => `ssh true exited with ${String(code)}`
  };
  assert.equal(summarizeRemoteFailure({ exitCode: null, stderr: "", timedOut: true }, wording), "ssh true timed out");
  assert.equal(summarizeRemoteFailure({ exitCode: 255, stderr: "denied", timedOut: false }, wording), "ssh true failed: denied");
  assert.equal(summarizeRemoteFailure({ exitCode: 255, stderr: "", timedOut: false }, wording), "ssh true exited with 255");
});

// ---------------------------------------------------------------------------------------------------
// redactArtifactPath delegation equivalence: maskUserRootPath with the default mounts reproduces the
// three hand-written regexes the resource-display layer used, for every path those regexes masked.
// ---------------------------------------------------------------------------------------------------
test("maskUserRootPath reproduces the prior /data, /scratch, /shared/homes display-layer masking", () => {
  assert.equal(maskUserRootPath("/data/alice/experiments/run/out.json"), "/data/<user>/experiments/run/out.json");
  assert.equal(maskUserRootPath("/scratch/${USER}/run/out.json"), "/scratch/<user>/run/out.json");
  assert.equal(maskUserRootPath("/shared/homes/bob/run/out.json"), "/shared/homes/<user>/run/out.json");
  // non-default roots are untouched by the default-prefix mask (caller passes no profile here).
  assert.equal(maskUserRootPath("/projects/labx/alice/run"), "/projects/labx/alice/run");
  // already-masked path is idempotent (the display pass runs on artifacts.ts-masked manifests).
  assert.equal(maskUserRootPath("/data/<user>/run/out.json"), "/data/<user>/run/out.json");
});

// ---------------------------------------------------------------------------------------------------
// redactLocalHome / redactProjectRoot — the single canonical home/project-path scrub. The inline
// `value.replace(/\/Users\/[^/\s]+/g, …)` + `value.replaceAll(projectRoot, "<project>")` regexes were
// copy-pasted across index.ts (redactConfigPath), resources.ts (redactLocalResourcePath /
// redactTransferEndpoint / redactTransferCommandArg) and docs.ts (sanitizeErrorMessage) with one site
// drifted to a DIFFERENT placeholder ("/Users/<user>"). These pin the ONE standardized token so a
// future drift back to a per-site token fails the suite, and prove no over-redaction / no raw-home leak.
// ---------------------------------------------------------------------------------------------------

// The ONE standardized placeholder. Pinned literally (not via the helper) so a drift to a different
// token in lib/redact.ts is caught here.
const LOCAL_HOME_TOKEN = "<local-home>";

test("redactLocalHome — a /Users/<name>/... path collapses to the single placeholder", () => {
  assert.equal(redactLocalHome("/Users/alice/data/run.json"), `${LOCAL_HOME_TOKEN}/data/run.json`);
});

test("redactLocalHome — the placeholder token is the ONE standardized value (pinned)", () => {
  const out = redactLocalHome("/Users/bob");
  assert.equal(out, LOCAL_HOME_TOKEN);
  // Guard against silent reintroduction of the previously-divergent docs.ts token.
  assert.equal(out.includes("/Users/<user>"), false, "must not emit the old per-site /Users/<user> token");
});

test("redactLocalHome — a value with NO home prefix is returned unchanged (no over-redaction)", () => {
  assert.equal(redactLocalHome("relative/path/run.json"), "relative/path/run.json");
  assert.equal(redactLocalHome("/data/<user>/experiments/run"), "/data/<user>/experiments/run");
  assert.equal(redactLocalHome("<project>/.uts-computing/run"), "<project>/.uts-computing/run");
});

test("redactLocalHome — masks every /Users segment in a value (idempotent, no raw home survives)", () => {
  const out = redactLocalHome("from /Users/alice/src to /Users/bob/dst");
  assert.equal(out, `from ${LOCAL_HOME_TOKEN}/src to ${LOCAL_HOME_TOKEN}/dst`);
  assert.equal(out.includes("/Users/alice"), false);
  assert.equal(out.includes("/Users/bob"), false);
  // re-running over an already-masked value is a no-op.
  assert.equal(redactLocalHome(out), out);
});

test("redactLocalHome — leak: a home path embedding a keyed-secret-looking segment still reduces to the placeholder", () => {
  // Even a username that looks like a token must not survive — the whole /Users/<name> head collapses.
  const out = redactLocalHome("/Users/svc-token=hunter2/keys/id_rsa");
  assert.equal(out, `${LOCAL_HOME_TOKEN}/keys/id_rsa`);
  assert.equal(out.includes("hunter2"), false, "the OS username segment (incl. secret-looking text) must not leak");
  assert.equal(out.includes("/Users/"), false, "no raw home prefix may leak through");
});

test("redactProjectRoot — a <project> path collapses correctly and a non-project value is unchanged", () => {
  const PROJECT = "/Users/runner/work/uts-computing-platform";
  assert.equal(
    redactProjectRoot(`${PROJECT}/.uts-computing/run-1/out.json`, PROJECT),
    "<project>/.uts-computing/run-1/out.json"
  );
  // no project prefix => unchanged (no over-redaction).
  assert.equal(redactProjectRoot("/elsewhere/data/run.json", PROJECT), "/elsewhere/data/run.json");
});

test("redactProjectRoot + redactLocalHome compose to the prior inline scrub (project first, then home)", () => {
  const PROJECT = "/Users/runner/work/uts-computing-platform";
  // The prior copies ran replaceAll(projectRoot, "<project>") THEN the /Users regex. Project root is
  // itself under /Users on this CI box, so order matters: project must collapse before the home pass.
  const value = `${PROJECT}/.uts-computing/run and /Users/alice/external/data`;
  const out = redactLocalHome(redactProjectRoot(value, PROJECT));
  assert.equal(out, `<project>/.uts-computing/run and ${LOCAL_HOME_TOKEN}/external/data`);
  assert.equal(out.includes("/Users/runner"), false, "the local project root's home segment must not leak");
  assert.equal(out.includes("/Users/alice"), false);
});
