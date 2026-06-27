# iHPC 内化 — Phase 0(first-party 切换 + 契约 build-ordinal)实现计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development(推荐)或 superpowers:executing-plans 逐任务实现。步骤用 checkbox(`- [ ]`)跟踪。

**Goal:** 把 `ihpc-scheduler/` 从「vendored 上游镜像」彻底转为插件的 first-party 子系统,并把调度器契约格式从钉上游 SHA 改为带单调 build ordinal 的 first-party 身份(`version+stateN+buildM+sha`),作为后续 Phase A 部署加硬的基石。

**Architecture:** (1) 退役上游 sync/provenance/redaction 机制(脚本 + CI lane + package.json),`UPSTREAM`/`PROVENANCE.json` 降为一次性来源说明。(2) 契约字符串增加 `+buildM` 段;`_contract.py`(Python)与 `lib/ihpc-contract.ts`(TS)双侧同步;新增 `scripts/stamp-scheduler-contract.mjs` 在 build/发版时从仓库 commit + STATE_VERSION + pyproject 版本 + BUILD 常量确定性地写两侧的戳(取代退役的 sync 脚本的 stamp 职责)。运行期边界、节点行为本阶段不动。

**Tech Stack:** TypeScript(ES modules)、`node --test`;Python 3 stdlib(`_contract.py`);`node` 脚本。依据 spec:`docs/superpowers/specs/2026-06-20-ihpc-scheduler-internalized-design.md` §0、§4(契约 build-ordinal 部分)。

**基线:** 全套 `npm test` 当前应绿(485)。每个 Task 末尾 commit;不 push(控制器统一处理)。

---

## 文件结构

| 文件 | 责任 | 动作 |
|---|---|---|
| `scripts/redactions.local.txt` | 上游内嵌 id 的脱敏对照(gitignored) | **删除**(源码已 id-clean,first-party 后无意义) |
| `scripts/sync-ihpc-scheduler.sh` | 从上游重新 vendoring + stamp | **删除**(first-party 直接编辑) |
| `scripts/check-provenance.mjs` | 校验 vendored 树与 PROVENANCE 一致 | **删除** |
| `package.json` | `check:provenance` script | **移除该脚本项** |
| `.github/workflows/ci.yml` | js lane 跑 check-provenance;python lane 跑 pytest | **移除 check-provenance 步骤**;保留 python pytest(现测 first-party 代码) |
| `ihpc-scheduler/UPSTREAM` / `PROVENANCE.json` | 持续 sync 目标 | **改写头部为一次性来源说明**(「<日期> 由 mtics/uts-ihpc 整合,此后 first-party」) |
| `ihpc-scheduler/src/scheduler/_contract.py` | Python 侧契约戳 | 加 `_BUILD`;`contract_version()` 输出 `+buildM`;注释改 first-party |
| `ihpc-scheduler/tests/test_scheduler_contract.py` | Python 契约测试 | 断言新 `+build` 格式 |
| `mcp-server/src/lib/ihpc-contract.ts` | TS 侧契约 primitives | `ContractParts.build`;`CONTRACT_RE`;format;`EXPECTED` 新格式 |
| `mcp-server/tests/lib/ihpc-contract.test.mjs` | TS 契约测试 | 断言新格式 parse/round-trip |
| `scripts/stamp-scheduler-contract.mjs` | **新建** build 时戳两侧 | 从 `git rev-parse --short HEAD` + pyproject 版本 + STATE_VERSION + BUILD 常量写 `_contract.py` 与 `ihpc-contract.ts` 的 `EXPECTED` |

---

## Task 1:退役 redaction + 确认源码 id-clean

**Files:**
- Delete: `scripts/redactions.local.txt`
- Verify: `ihpc-scheduler/` 全树

- [ ] **Step 1: 确认 vendored 源码已无真实 id**

Run:
```bash
grep -rnIE "u00000001|u00000002|u00000003|u00000004" ihpc-scheduler/ | grep -v redactions || echo CLEAN
```
Expected: `CLEAN`(历史 scrub 已清;若非空,先用合成占位替换后再继续)。

- [ ] **Step 2: 删除 redaction 对照文件**

Run:
```bash
git rm --ignore-unmatch scripts/redactions.local.txt 2>/dev/null; rm -f scripts/redactions.local.txt
ls scripts/redactions.local.txt 2>&1 | grep -q "No such" && echo GONE
```
Expected: `GONE`(该文件是 gitignored,可能本就未被 git 跟踪)。

- [ ] **Step 3: Commit**

```bash
git add -A scripts/
git commit -m "chore(ihpc): retire redactions.local.txt — vendored source is first-party + id-clean"
```

---

## Task 2:退役上游 sync/provenance 机制 + CI

**Files:**
- Delete: `scripts/sync-ihpc-scheduler.sh`, `scripts/check-provenance.mjs`
- Modify: `package.json`(移除 `check:provenance`)、`.github/workflows/ci.yml`(移除 provenance 步骤)、`ihpc-scheduler/UPSTREAM`、`ihpc-scheduler/PROVENANCE.json`

- [ ] **Step 1: 删除两个脚本**

```bash
git rm scripts/sync-ihpc-scheduler.sh scripts/check-provenance.mjs
```

- [ ] **Step 2: 移除 package.json 的 check:provenance**

把这一行从 `"scripts"` 中删除:
```json
    "check:provenance": "node scripts/check-provenance.mjs",
```

- [ ] **Step 3: 改 CI——移除 provenance 步骤,保留 python pytest**

在 `.github/workflows/ci.yml` 中删除这一步:
```yaml
      - run: node scripts/check-provenance.mjs
```
并把文件头注释里描述 provenance 的那行(`#   js … then the vendoring provenance check.`)改为 `#   js — build + the JS/TS test suite.`。python lane(`pytest`)**保留**——它现在测的是我们的 first-party 调度器代码。

- [ ] **Step 4: UPSTREAM/PROVENANCE 降为一次性来源说明**

在 `ihpc-scheduler/UPSTREAM` 顶部加一段(保留下方历史 SHA 作为来源记录):
```
# FIRST-PARTY (2026-06-20): consolidated from mtics/uts-ihpc into this plugin.
# No longer synced from upstream; edit ihpc-scheduler/ directly. The fields below
# are a one-time provenance record of the origin, not a live sync target.
```
在 `ihpc-scheduler/PROVENANCE.json` 顶层加 `"status": "first-party-consolidated"` 与 `"consolidated_at": "2026-06-20"`(保留 `upstream_sha` 作历史)。

- [ ] **Step 5: 确认无残留引用 + 套件绿**

```bash
grep -rnE "check-provenance|sync-ihpc-scheduler|redactions" package.json .github/ scripts/ || echo "no live refs"
npm test 2>&1 | tail -3
```
Expected:`no live refs`;`npm test` 仍绿(provenance 退役不影响 JS 套件)。

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore(ihpc): retire upstream sync + provenance machinery (first-party subsystem)"
```

---

## Task 3:契约格式加 build ordinal(first-party 身份)

格式从 `version+stateN+sha` 改为 `version+stateN+buildM+sha`。`build` 是单调整数(每次发布调度器 agent 时 +1),`sha` 改为我们仓库的 build 短 SHA(发版时由 stamp 脚本写,不再钉上游 `e6883a9`)。本任务只改**格式 + parse + round-trip**;排序判定(`contractOrdering`)留给 Phase A。

**Files:**
- Modify: `mcp-server/src/lib/ihpc-contract.ts`
- Test: `mcp-server/tests/lib/ihpc-contract.test.mjs`
- Modify: `ihpc-scheduler/src/scheduler/_contract.py`
- Test: `ihpc-scheduler/tests/test_scheduler_contract.py`
- Create: `scripts/stamp-scheduler-contract.mjs`

- [ ] **Step 1: 写 TS 失败测试**

在 `mcp-server/tests/lib/ihpc-contract.test.mjs` 追加:
```javascript
import test from "node:test";
import assert from "node:assert/strict";
import { parseContractVersion, schedulerContractVersion } from "../../dist/lib/ihpc-contract.js";

test("contract round-trips the build ordinal", () => {
  const parts = { version: "0.1.0", stateVersion: 2, build: 7, gitSha: "abc1234" };
  const s = schedulerContractVersion(parts);
  assert.equal(s, "0.1.0+state2+build7+abc1234");
  assert.deepEqual(parseContractVersion(s), parts);
});

test("parseContractVersion rejects the old no-build format", () => {
  assert.equal(parseContractVersion("0.1.0+state2+e6883a9"), null);
});
```

- [ ] **Step 2: Run — FAIL**

Run: `npm run build && node --test mcp-server/tests/lib/ihpc-contract.test.mjs`
Expected: FAIL(`build` 未定义 / 旧格式仍被解析)。

- [ ] **Step 3: 改 `lib/ihpc-contract.ts`**

```typescript
export interface ContractParts {
  version: string;      // pyproject [project].version(first-party,我们自有)
  stateVersion: number; // src/scheduler/state.py STATE_VERSION
  build: number;        // 单调 build ordinal(每次发版 +1)
  gitSha: string;       // 我们仓库的 build 短 SHA(非上游)
}

export type ContractVerdict = "match" | "stale" | "unknown";

const CONTRACT_RE = /^(\d+\.\d+\.\d+)\+state(\d+)\+build(\d+)\+([0-9a-f]{7,40})$/;

export function schedulerContractVersion(parts: ContractParts): string {
  return `${parts.version}+state${parts.stateVersion}+build${parts.build}+${parts.gitSha}`;
}

export function parseContractVersion(value: string | undefined | null): ContractParts | null {
  if (!value) return null;
  const m = CONTRACT_RE.exec(value.trim());
  if (!m) return null;
  return {
    version: m[1],
    stateVersion: Number.parseInt(m[2], 10),
    build: Number.parseInt(m[3], 10),
    gitSha: m[4]
  };
}

export function compareContract(live: string | undefined | null, expected: string): ContractVerdict {
  const liveParts = parseContractVersion(live);
  if (!liveParts) return "unknown";
  return live!.trim() === expected ? "match" : "stale";
}

// First-party 身份,由 scripts/stamp-scheduler-contract.mjs 在 build/发版时重写(Task 3 Step 8)。
export const EXPECTED_SCHEDULER_CONTRACT = "0.1.0+state2+build1+e6883a9";
```
> 注:`compareContract` 逻辑不变(仍 match/stale/unknown);只是它现在比对的字符串带 build 段。`EXPECTED` 的 `gitSha` 暂留 `e6883a9` 占位,Step 8 的 stamp 脚本会把它改成本仓库 commit。

- [ ] **Step 4: Run — PASS**

Run: `npm run build && node --test mcp-server/tests/lib/ihpc-contract.test.mjs`
Expected: PASS。

- [ ] **Step 5: 改 Python `_contract.py`**

```python
"""Contract-version stamp (FIRST-PARTY — part of this plugin; written by the stamp script).

Dependency-light: imports only the in-package state module, so the stamp is runnable
with a plain `python3 -c`. The three constants below are written by
scripts/stamp-scheduler-contract.mjs from this repo's pyproject version + a monotonic
BUILD ordinal + this repo's short commit SHA.

`contract_version()` emits the exact format the MCP server pins in
mcp-server/src/lib/ihpc-contract.ts (EXPECTED_SCHEDULER_CONTRACT).
"""

import re

from .state import STATE_VERSION

# Written by scripts/stamp-scheduler-contract.mjs (first-party; not upstream).
_VERSION = "0.1.0"
_BUILD = "1"
_GIT_SHA = "e6883a9"

CONTRACT_RE = re.compile(r"^(\d+\.\d+\.\d+)\+state(\d+)\+build(\d+)\+([0-9a-f]{7,40})$")


def contract_version() -> str:
    """Return e.g. '0.1.0+state2+build1+e6883a9'."""
    return f"{_VERSION}+state{STATE_VERSION}+build{_BUILD}+{_GIT_SHA}"
```

- [ ] **Step 6: 改 Python 测试 `test_scheduler_contract.py`**

替换其断言为新格式(完整文件):
```python
from src.scheduler._contract import CONTRACT_RE, contract_version


def test_contract_version_matches_the_pinned_format():
    v = contract_version()
    assert CONTRACT_RE.match(v), f"{v!r} must match {CONTRACT_RE.pattern}"


def test_contract_version_components():
    v = contract_version()
    m = CONTRACT_RE.match(v)
    assert m is not None
    version, state, build, sha = m.group(1), int(m.group(2)), int(m.group(3)), m.group(4)
    assert version.count(".") == 2
    assert state >= 1
    assert build >= 1
    assert len(sha) >= 7
```
(Python 套件由 CI 跑——本地无 paramiko/pyyaml,但 `_contract.py` 只 import state,可本地验证:)
```bash
cd ihpc-scheduler && python3 -c "from src.scheduler._contract import contract_version; print(contract_version())"
```
Expected: 形如 `0.1.0+state2+build1+e6883a9`。

- [ ] **Step 7: 新建 stamp 脚本 `scripts/stamp-scheduler-contract.mjs`**

```javascript
#!/usr/bin/env node
// First-party 契约戳:从本仓库的 pyproject 版本 + STATE_VERSION + BUILD 常量 + git 短 SHA,
// 确定性地写 _contract.py 与 lib/ihpc-contract.ts 的 EXPECTED_SCHEDULER_CONTRACT。
// 取代退役的 sync 脚本的 stamp 职责。发版/build 时运行。
import fs from "node:fs";
import { execSync } from "node:child_process";

const root = new URL("..", import.meta.url).pathname;
const contractPy = `${root}ihpc-scheduler/src/scheduler/_contract.py`;
const statePy = `${root}ihpc-scheduler/src/scheduler/state.py`;
const pyproject = `${root}ihpc-scheduler/pyproject.toml`;
const tsContract = `${root}mcp-server/src/lib/ihpc-contract.ts`;

const version = /^version\s*=\s*"([^"]+)"/m.exec(fs.readFileSync(pyproject, "utf8"))[1];
const stateVersion = /STATE_VERSION\s*=\s*(\d+)/.exec(fs.readFileSync(statePy, "utf8"))[1];
const py = fs.readFileSync(contractPy, "utf8");
const build = /_BUILD\s*=\s*"(\d+)"/.exec(py)[1];           // 由维护者在发版时 +1
const sha = execSync("git rev-parse --short HEAD", { cwd: root }).toString().trim();
const contract = `${version}+state${stateVersion}+build${build}+${sha}`;

fs.writeFileSync(contractPy, py
  .replace(/_VERSION = "[^"]*"/, `_VERSION = "${version}"`)
  .replace(/_GIT_SHA = "[^"]*"/, `_GIT_SHA = "${sha}"`));
fs.writeFileSync(tsContract, fs.readFileSync(tsContract, "utf8")
  .replace(/export const EXPECTED_SCHEDULER_CONTRACT = "[^"]*";/,
           `export const EXPECTED_SCHEDULER_CONTRACT = "${contract}";`));
console.log("stamped contract:", contract);
```
加 package.json 脚本:`"stamp:contract": "node scripts/stamp-scheduler-contract.mjs"`。

- [ ] **Step 8: 运行 stamp,使两侧契约一致 + 全套件绿**

```bash
npm run stamp:contract
npm test 2>&1 | tail -3
```
Expected:stamp 打印 `0.1.0+state2+build1+<本仓库 SHA>`;`_contract.py` 与 `EXPECTED_SCHEDULER_CONTRACT` 同值;`npm test` 绿(scheduler-version.test.mjs / scheduler-deploy.test.mjs 用新 EXPECTED 比对仍一致——因为两侧都被 stamp 写成同一字符串)。
> 若 `scheduler-version.test.mjs` / `scheduler-deploy.test.mjs` 中硬编码了旧 `"0.1.0+state2+e6883a9"`,改成从 `EXPECTED_SCHEDULER_CONTRACT` import,或更新为 stamp 后的值。

- [ ] **Step 9: Commit**

```bash
git add mcp-server/src/lib/ihpc-contract.ts mcp-server/tests/lib/ihpc-contract.test.mjs \
  ihpc-scheduler/src/scheduler/_contract.py ihpc-scheduler/tests/test_scheduler_contract.py \
  scripts/stamp-scheduler-contract.mjs package.json
git commit -m "feat(ihpc): first-party contract identity with monotonic build ordinal (version+stateN+buildM+sha)"
```

---

## Phase 0 退出条件

- [ ] `grep -rnE "u00000001|u00000002|u00000003|u00000004" ihpc-scheduler/` 为空。
- [ ] `scripts/{sync-ihpc-scheduler.sh,check-provenance.mjs,redactions.local.txt}` 不存在;`package.json` 无 `check:provenance`;CI 无 provenance 步骤(python pytest 保留)。
- [ ] `UPSTREAM`/`PROVENANCE.json` 标注 first-party-consolidated。
- [ ] 契约两侧格式为 `version+stateN+buildM+sha` 且经 stamp 后同值;`parseContractVersion` 拒绝旧无-build 格式。
- [ ] `npm test` 绿;`python3 -c "...contract_version()"` 输出新格式。
- [ ] 运行期/节点行为未改动(本阶段纯 first-party + 契约格式)。

## 自查(spec 覆盖)
- §0 first-party「退役 sync/provenance/redaction」→ Task 1+2 ✓;「契约身份不再钉上游 SHA、build 时写我们 commit」→ Task 3 ✓。
- §4「加单调 build ordinal → 格式 `version+stateN+buildM+sha`;first-party」→ Task 3 ✓。`contractOrdering`(排序判定)**刻意留给 Phase A**(本阶段只落格式),退出条件已注明。
