// Protocol-test executors and fetchers. Kept OUT of the production entrypoint (index.ts) so the
// server's main module ships no test scaffolding; these are wired in only when the
// UTS_COMPUTING_TEST_MODE / *_TEST_JOB_OPS / *_TEST_DOCS env flags are set (see index.ts).

import type { JobCommandExecutor } from "../ops/jobs/jobs.js";
import type { DocsFetcher } from "../ops/catalog/docs.js";
import type { CommandExecutor } from "./access.js";

export const protocolTestJobExecutor: JobCommandExecutor = async (program, args, _timeoutMs, stdin = "") => {
  if (program !== "ssh") {
    throw new Error(`Protocol test job executor only supports ssh, got ${program}`);
  }
  const encodedSpec = args.at(-1) ?? "";
  const spec = decodeProtocolTestSpec(encodedSpec);
  if (stdin.includes("os.kill(pid, 0)")) {
    return {
      exitCode: 0,
      stdout: `${JSON.stringify({ alive: process.env.UTS_COMPUTING_TEST_IHPC_ALIVE !== "0" })}\n`,
      stderr: ""
    };
  }
  if (stdin.includes("getsize")) {
    const streams = Array.isArray(spec.streams)
      ? spec.streams
          .filter((entry): entry is { stream: "stdout" | "stderr" } =>
            Boolean(entry) &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            ((entry as { stream?: unknown }).stream === "stdout" || (entry as { stream?: unknown }).stream === "stderr")
          )
          .map((entry) => ({
            stream: entry.stream,
            status: "passed",
            content: `${entry.stream} token=protocol-secret\n`,
            truncated: false,
            summary: `${entry.stream} log tail completed`
          }))
      : [];
    return { exitCode: 0, stdout: `${JSON.stringify({ streams })}\n`, stderr: "" };
  }
  if (stdin.includes("os.killpg(pid, signal.SIGTERM)")) {
    return { exitCode: 0, stdout: `${JSON.stringify({ result: "cancelled" })}\n`, stderr: "" };
  }
  throw new Error("Protocol test job executor received unsupported iHPC helper stdin");
};

// Read-only quota executor for the protocol test's quotas.capacity refresh seam. Mirrors the SSH
// CommandExecutor shape and answers the allowlisted HPC + iHPC quota probes with deterministic
// fixtures so a live `quotas.capacity { refresh:true }` can build a fresh snapshot without a cluster.
export const protocolTestQuotaExecutor: CommandExecutor = async (program, args, _timeoutMs) => {
  if (program !== "ssh") {
    throw new Error(`Protocol test quota executor only supports ssh, got ${program}`);
  }
  const remoteArgv = remoteArgvAfterHost(args);
  const joined = remoteArgv.join(" ");
  if (joined === "whoami") {
    return { exitCode: 0, stdout: "protocoluser\n", stderr: "" };
  }
  if (joined === "id") {
    return { exitCode: 0, stdout: "uid=1000(protocoluser) gid=1000(research)\n", stderr: "" };
  }
  if (joined === "groups") {
    return { exitCode: 0, stdout: "research\n", stderr: "" };
  }
  if (joined === "qstat -Q") {
    return { exitCode: 0, stdout: "Queue Max Run\n----- ---\nsmallq 0\n", stderr: "" };
  }
  if (joined === "qstat -Qf") {
    return {
      exitCode: 0,
      stdout: "Queue: smallq\n    enabled = True\n    started = True\n    max_run = [u:PBS_GENERIC=4]\n",
      stderr: ""
    };
  }
  if (remoteArgv[0] === "qstat" && remoteArgv[1] === "-u") {
    return { exitCode: 0, stdout: "", stderr: "" };
  }
  if (joined === "pbsnodes -F json -a") {
    return { exitCode: 0, stdout: JSON.stringify({ nodes: { node001: { state: "free" } } }), stderr: "" };
  }
  if (joined === "quota -s") {
    return { exitCode: 0, stdout: "Disk quotas for user protocoluser\n", stderr: "" };
  }
  if (joined === "cnode avail" || joined === "cnode all") {
    return { exitCode: 0, stdout: "mars001 free\n", stderr: "" };
  }
  if (joined === "cnode mynodes") {
    return { exitCode: 0, stdout: "Node Index\n", stderr: "" };
  }
  if (joined === "sessiontime") {
    return { exitCode: 0, stdout: "Remaining session time: 01:00:00\n", stderr: "" };
  }
  if (joined === "projvolu") {
    return { exitCode: 0, stdout: "project volume for protocoluser: 1G used\n", stderr: "" };
  }
  if (remoteArgv[0] === "df" && remoteArgv[1] === "-hP") {
    return {
      exitCode: 0,
      stdout: `Filesystem Size Used Avail Use% Mounted on\nstorage 1T 10G 990G 1% ${remoteArgv[2]}\n`,
      stderr: ""
    };
  }
  if (remoteArgv[0] === "du") {
    return { exitCode: 0, stdout: `1G\t${remoteArgv.at(-1) ?? ""}\n`, stderr: "" };
  }
  return { exitCode: 1, stdout: "", stderr: `protocol test quota executor: unhandled ${joined}\n` };
};

// sshReadOnlyArgs builds `[...outerHopFlags, hostAlias, ...remoteArgv]`. The outer-hop flags end with
// the `-o ConnectTimeout=<n>` pair, so the host alias is the token right after `ConnectTimeout=...`
// and the remote argv is everything that follows. This is robust even when the remote command itself
// contains dash-flags (e.g. `qstat -Qf`, `df -hP`).
function remoteArgvAfterHost(args: string[]): string[] {
  const connectTimeoutIndex = args.findIndex((token) => token.startsWith("ConnectTimeout="));
  if (connectTimeoutIndex < 0 || connectTimeoutIndex + 2 > args.length) {
    return [];
  }
  // connectTimeoutIndex → the value; +1 → host alias; +2 → first remote argv token.
  return args.slice(connectTimeoutIndex + 2);
}

export const protocolTestDocsFetcher: DocsFetcher = async (url, _options) => {
  const body = [
    "<!doctype html>",
    "<html>",
    "<head><title>Mock UTS Documentation</title><script>secret()</script></head>",
    "<body>",
    "<h1>Mock UTS Documentation</h1>",
    `<p>Protocol mock fetched ${url}</p>`,
    "<p>PBS queues and iHPC node limits require VPN-visible official documentation evidence.</p>",
    "</body>",
    "</html>"
  ].join("");
  return {
    status: 200,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "content-length": String(Buffer.byteLength(body))
    },
    body,
    finalUrl: url
  };
};

function decodeProtocolTestSpec(encoded: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(encoded)) {
    return {};
  }
  try {
    return JSON.parse(Buffer.from(encoded, "base64url").toString("utf8")) as Record<string, unknown>;
  } catch {
    return {};
  }
}
