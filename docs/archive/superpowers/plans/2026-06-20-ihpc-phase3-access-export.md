# iHPC Internalization — Phase 3 (Access export & offline handoff) Implementation Plan

> **For agentic workers:** REQUIRED: Use superpowers:subagent-driven-development (if subagents available) or superpowers:executing-plans to implement this plan. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When the plugin can't reach the cluster (VPN down, offline), a human must be able to take over. Give `access.doctor` an `--export-ssh` mode that emits a copy-pasteable `~/.ssh/config` snippet + the real `login_host` + the required env-var **NAMES** (never their values) (H5), and have `docs.refresh` tell offline users about that escape hatch on a network failure (M15).

**Architecture:** A new pure module `ops/access/ssh-export.ts` derives a secret-free SSH-config snippet from a `ComputeProfile` (no SSH, no IO). `access.doctor` gains an `exportSsh` boolean flag (NOT a new tool — the spec says "access.doctor --export-ssh", and a flag avoids the 5-touch); when set, the handler returns the export instead of running probes, requires a single `profileId`, and never touches the executor. `docs.refresh` appends an offline-handoff warning when a fetch fails with a network-class error.

**Tech Stack:** TypeScript (ES modules), Zod, `node --test`. No Python, no remote calls, no dangerous operations — every code path here is local and read-only.

---

## Conventions (read once)
- Build before targeted test: `npm run build && node --test mcp-server/tests/ops/<file>.test.mjs`. Full suite: `npm test` (baseline 427 pass on this branch).
- **Secret-free is load-bearing:** the export prints env-var NAMES (e.g. `UTS_HPC_ACCOUNT_A_USER`) and the login host, NEVER any env value, key, password, or the real remote username. Tests must assert the absence of secret values.
- `access.doctor` is an EXISTING tool; adding an input field does NOT change `tool-registration.test.mjs`/`mcp-protocol.test.mjs` (those pin tool names + annotations, not input schemas) — so the tool count stays **42** and there is no 5-touch here. Confirm by running both integration tests.
- Reuse `clusterFromHostAlias` (config.ts:133) for the login host and `getProfile` (config.ts) for the profile. Do not reinvent host parsing.
- Commit per task; do not push (the controller batches the push to the Phase 3 PR).

---

### Task 1: H5 — `ssh-export.ts` primitive + `access.doctor --export-ssh`

**Files:**
- Create: `mcp-server/src/ops/access/ssh-export.ts`
- Modify: `mcp-server/src/index.ts` (add `exportSsh` flag + branch in the `access.doctor` handler)
- Test: `mcp-server/tests/ops/ssh-export.test.mjs` (pure) and extend `mcp-server/tests/ops/doctor.test.mjs` (the flag path)

- [ ] **Step 1: Write the failing pure-primitive test** (`ssh-export.test.mjs`):

```javascript
import assert from "node:assert/strict";
import test from "node:test";
import { sshConfigSnippet } from "../../dist/ops/access/ssh-export.js";

const hpc = {
  profile_id: "uts-hpc-account-a", platform: "uts-hpc",
  account_label: "cetus-a",
  login: { host_alias: "u00000001@login-host.example", username_ref: "UTS_HPC_ACCOUNT_A_USER", identity_file_ref: "UTS_HPC_KEY", requires_vpn: true, ssh_agent: true },
  defaults: {}, quota_snapshot: null
};
const ihpc = {
  profile_id: "uts-ihpc-account-a", platform: "uts-ihpc",
  account_label: "ihpc-a",
  login: { host_alias: "ihpc-alias", username_ref: "UTS_IHPC_ACCOUNT_A_USER", requires_vpn: false },
  defaults: {}, quota_snapshot: null
};

test("sshConfigSnippet exports login_host, a config snippet, and env NAMES — no secret values", () => {
  const r = sshConfigSnippet(hpc);
  assert.equal(r.login_host, "login-host.example");
  assert.match(r.ssh_config_snippet, /^Host /m);
  assert.match(r.ssh_config_snippet, /HostName login-host\.example/);
  // username is rendered as the env-var NAME placeholder, NEVER the real username from host_alias
  assert.match(r.ssh_config_snippet, /User \$\{UTS_HPC_ACCOUNT_A_USER\}/);
  assert.equal(r.ssh_config_snippet.includes("u00000001"), false, "must not leak the real username");
  assert.deepEqual(r.required_env_names.sort(), ["UTS_HPC_ACCOUNT_A_USER", "UTS_HPC_KEY"].sort());
  assert.match(r.ssh_config_snippet, /IdentityFile \$\{UTS_HPC_KEY\}/);
  assert.match(r.ssh_config_snippet, /requires VPN/i); // informational comment since requires_vpn
});

test("sshConfigSnippet handles a bare iHPC alias and no identity file", () => {
  const r = sshConfigSnippet(ihpc);
  assert.equal(r.login_host, "ihpc-alias");
  assert.deepEqual(r.required_env_names, ["UTS_IHPC_ACCOUNT_A_USER"]);
  assert.equal(r.ssh_config_snippet.includes("IdentityFile"), false);
});

test("sshConfigSnippet throws on an empty host_alias", () => {
  assert.throws(() => sshConfigSnippet({ ...ihpc, login: { ...ihpc.login, host_alias: "" } }), /host/i);
});
```

- [ ] **Step 2: Run it — FAIL** (module missing). `npm run build && node --test mcp-server/tests/ops/ssh-export.test.mjs`.

- [ ] **Step 3: Implement `ssh-export.ts`** (pure, secret-free):

```typescript
// Pure, secret-free SSH-config export (H5). Lets a human reach the cluster when the plugin can't
// (VPN down/offline). Emits env-var NAMES and the login host only — never any secret value, key,
// password, or the real remote username (which may be embedded in host_alias as user@host).
import { clusterFromHostAlias } from "../../core/config.js";
import type { ComputeProfile } from "../../core/types.js";

export interface SshExportResult {
  login_host: string;
  ssh_config_snippet: string;
  required_env_names: string[];
}

export function sshConfigSnippet(profile: ComputeProfile): SshExportResult {
  const login = profile.login;
  const login_host = clusterFromHostAlias(login.host_alias);
  if (!login_host) {
    throw new Error(`Profile ${profile.profile_id} has no resolvable login host_alias`);
  }
  const required_env_names = [login.username_ref];
  const lines: string[] = [];
  if (login.requires_vpn) {
    lines.push("# NOTE: requires VPN connection to reach this host");
  }
  lines.push(`Host ${profile.profile_id}`);
  lines.push(`  HostName ${login_host}`);
  // username_ref is the env-var NAME holding the username; the operator substitutes its value.
  lines.push(`  User \${${login.username_ref}}   # replace with the value of $${login.username_ref}`);
  if (login.identity_file_ref) {
    required_env_names.push(login.identity_file_ref);
    lines.push(`  IdentityFile \${${login.identity_file_ref}}   # path held by $${login.identity_file_ref}`);
  }
  if (login.ssh_agent) {
    lines.push("  AddKeysToAgent yes");
  }
  if (login.keychain_ref) {
    // No standard ~/.ssh/config keychain directive — surface the env NAME as a comment, don't invent one.
    required_env_names.push(login.keychain_ref);
    lines.push(`  # macOS keychain: set $${login.keychain_ref} externally (e.g. via ssh-add --apple-use-keychain)`);
  }
  return { login_host, ssh_config_snippet: lines.join("\n"), required_env_names };
}
```

> Confirm `clusterFromHostAlias` is exported from `core/config.js` (recon: config.ts:133). If it's not exported, export it (it's a pure helper). Confirm `ComputeProfile.login` has the fields used.

- [ ] **Step 4: Add the `exportSsh` flag to `access.doctor`** in `index.ts` (around the existing registration, recon: index.ts:271-284). Add `exportSsh: z.boolean().default(false)` (or `.optional()`) to the `strictInput`, and branch in the handler:
  ```typescript
  async ({ profileId, timeoutMs, exportSsh }) =>
    safeTool(async () => {
      if (exportSsh) {
        if (!profileId) throw new Error("access.doctor --export-ssh requires a single profileId");
        const profile = getProfile(profileId);
        const exp = sshConfigSnippet(profile);
        return { access: { mode: "export-ssh", profile_id: profileId, ...exp } };
      }
      return runDoctor({ profileId, timeoutMs });
    })
  ```
  Import `sshConfigSnippet` and `getProfile`. Update the tool description to mention `--export-ssh`. The export path must NOT call the executor (it's pure/local).

- [ ] **Step 5: Add a protocol-level test for the flag path.** The export branch lives in the **index.ts handler**, not in `runDoctor` (verified: `runDoctor`'s options are `{ profileId, timeoutMs, configPath, executor, … }` with no `exportSsh`, and `DoctorResult` has no `access` field). So do NOT test via `runDoctor`. The pure primitive is already covered by Step 1; add ONE integration test that drives the `access.doctor` tool with `{ exportSsh: true }` through the MCP stdio client (reuse the client helper used by `tool-registration.test.mjs` / `mcp-protocol.test.mjs`), against the example profiles, and assert: the envelope is `{ ok: true, access: { mode: "export-ssh", login_host, ssh_config_snippet, required_env_names } }`; `required_env_names` is a non-empty array of NAMES; and the serialized result contains **no** secret value (assert the snippet has no real username and no env value). Also assert that calling the tool with `{ exportSsh: true }` and no `profileId` returns `{ ok: false }` with an error mentioning a single profileId.

- [ ] **Step 6: Run targeted + full** — `npm test`. Confirm tool count still 42 (both integration tests green). Confirm no secret values in the export (grep the test output).

- [ ] **Step 7: Commit**
  ```bash
  git add mcp-server/src/ops/access/ssh-export.ts mcp-server/src/index.ts mcp-server/src/core/config.ts \
    mcp-server/tests/ops/ssh-export.test.mjs mcp-server/tests/ops/doctor.test.mjs
  git commit -m "feat(access): add access.doctor --export-ssh secret-free handoff (H5)"
  ```

---

### Task 2: M15 — `docs.refresh` offline-handoff note

**Files:**
- Modify: `mcp-server/src/ops/catalog/docs.ts` (network-failure warning)
- Modify: `mcp-server/src/index.ts` (docs.refresh tool description)
- Test: `mcp-server/tests/ops/docs.test.mjs`

- [ ] **Step 1: Write the failing test** (`docs.test.mjs`) — a network-class fetch failure yields an offline-handoff warning:
  ```javascript
  test("docs.refresh adds an offline-handoff note pointing to access.doctor --export-ssh on a network failure", async () => {
    const fetcher = async () => { throw new Error("fetch failed: network timeout (ECONNREFUSED)"); };
    const result = await refreshDocs({ sourceIds: ["uts-hpc-pbs"] }, { docsCacheDir: cacheDir("offline-note"), fetcher });
    const src = result.refresh.sources[0];
    assert.equal(src.status, "failed");
    assert.ok(src.warnings.some((w) => /access\.doctor.*--export-ssh/.test(w)), "expected an offline-handoff note");
  });
  ```
  > Verified: `refreshDocs(input, options)` with `input = { sourceIds: [...] }` and `options = { docsCacheDir, fetcher, … }`; `DocsRefreshSourceResult.warnings: string[]` already exists (docs.ts:201) and the catch returns it (docs.ts:554-564) — so the change is a single `warnings.push(...)` in the catch. Use the `cacheDir(name)` helper from `docs.test.mjs:8-12` (a runtime-local dir, else `refreshDocs` rejects a non-runtime path) and the real source id from the existing tests. Confirm `"uts-hpc-pbs"` is a valid sourceId.

- [ ] **Step 2: Run it — FAIL** (no such warning).

- [ ] **Step 3: Implement.** In `docs.ts`'s per-source fetch-failure catch (recon: ~line 554), detect a network-class error (message matches `/fetch|timeout|ECONNREFUSED|ENOTFOUND|ERR_NETWORK|EAI_AGAIN|getaddrinfo/i`) and, when so, append to that source's `warnings`:
  ```
  "Network error: if you can't reach the UTS network/VPN right now, run access.doctor --export-ssh to get the SSH access path (~/.ssh/config snippet + login_host + required env-var names) for a manual handoff."
  ```
  Keep the raw error too (for diagnosis); just add the actionable note.

- [ ] **Step 4: Update the `docs.refresh` tool description** in `index.ts` (recon: index.ts:325-338) — add a sentence: "If network access fails and no cache exists, use `access.doctor --export-ssh` to obtain the connection path for a manual SSH handoff."

- [ ] **Step 5: Run targeted + full** — `npm test` green.

- [ ] **Step 6: Commit**
  ```bash
  git add mcp-server/src/ops/catalog/docs.ts mcp-server/src/index.ts mcp-server/tests/ops/docs.test.mjs
  git commit -m "feat(docs): docs.refresh offline-handoff note pointing to access.doctor --export-ssh (M15)"
  ```

---

### Task 3: Docs + spec tick

- [ ] Update `README.md` / `mcp-server/README.md` if they describe `access.doctor` (mention `--export-ssh`) — and note this fulfils the Phase-1 deferral of `login_host` disclosure.
- [ ] Add a short "Phase 3 delivered" note to `docs/superpowers/specs/2026-06-20-ihpc-internalization-design.md` (H5 + M15).
- [ ] `npm test` (docs-only); commit `docs(ihpc): document access.doctor --export-ssh + offline handoff (Phase 3)`.

---

## Phase 3 exit criteria
- [ ] `access.doctor` with `exportSsh:true` returns `{ login_host, ssh_config_snippet, required_env_names }`, **secret-free** (a test asserts no env value / key / real username leaks), requires a single `profileId`, and runs **no** remote probe.
- [ ] `docs.refresh` on a network failure surfaces an actionable offline-handoff note pointing to `access.doctor --export-ssh`.
- [ ] Tool count still **42** (no new tool); full suite green.
- [ ] No real account ids / hosts introduced (`git grep` clean).
