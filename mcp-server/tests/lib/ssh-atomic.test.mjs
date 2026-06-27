import assert from "node:assert/strict";
import test from "node:test";
import { ATOMIC_WRITE_PY, sshWriteAtomicJsonArgs, SSH_INNER_HOP_HOST_KEY } from "../../dist/lib/ssh.js";

test("ATOMIC_WRITE_PY does temp -> fsync(file) -> rename -> fsync(dir)", () => {
  // golden: 镜像 remote-python micro-worker 的可解析性 + 关键 syscall 顺序断言
  assert.match(ATOMIC_WRITE_PY, /os\.fsync\(/);          // file fsync
  assert.match(ATOMIC_WRITE_PY, /os\.replace\(|os\.rename\(/); // atomic rename
  assert.match(ATOMIC_WRITE_PY, /O_RDONLY/);             // open dir fd for dir fsync
  // 必须先 fsync 文件再 rename 再 fsync 目录:断言三者出现顺序
  const fFsync = ATOMIC_WRITE_PY.search(/handle\.flush\(\)[\s\S]*?os\.fsync\(handle\.fileno\(\)\)/);
  const fRename = ATOMIC_WRITE_PY.search(/os\.replace\(/);
  const fDir = ATOMIC_WRITE_PY.search(/os\.fsync\(dir_fd\)/);
  assert.ok(fFsync >= 0 && fRename > fFsync && fDir > fRename, "order must be fsync(file) < rename < fsync(dir)");
});

test("sshWriteAtomicJsonArgs composes a two-hop supervisor-style argv to the node", () => {
  const args = sshWriteAtomicJsonArgs("login-gw", "mars01", 10000, "QmFzZTY0U3BlYw");
  // 断言 STABLE 的内层尾段(gateway 之后),用 SSH_INNER_HOP_HOST_KEY 常量而非硬编码字面量,这样
  // 外层 hop flags 或 inner-hop 选项若调整也不会脆裂(review B-5)。`-T` 在 hostAlias 之前(外层段),
  // 故从 login-gw 切片不含它。注:实现复用 sshSupervisorArgs(ssh.ts:119),其内层尾段位置已被
  // tests/access.test.mjs pin;此处只复核「我们的 primitive 透传了它」。
  const i = args.indexOf("login-gw");
  assert.deepEqual(
    args.slice(i),
    ["login-gw", "ssh", "-o", SSH_INNER_HOP_HOST_KEY, "mars01", "python3", "-", "QmFzZTY0U3BlYw"]
  );
  // 同时复核外层段确含两跳硬化标志 -T(在 gateway 前),即真两跳而非误退化单跳。
  assert.ok(args.slice(0, i).includes("-T"), "outer hop must carry -T (two-hop, not single-hop)");
});

test("sshWriteAtomicJsonArgs rejects an unsafe encoded spec", () => {
  assert.throws(() => sshWriteAtomicJsonArgs("login-gw", "mars01", 10000, "bad spec!"), /not safe/);
});
