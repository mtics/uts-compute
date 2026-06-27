#!/usr/bin/env node
import { spawnSync } from "node:child_process";

const DEFAULT_PORT = 4173;
const STALE_PORT_START = DEFAULT_PORT + 1;
const STALE_PORT_END = 4189;
const action = process.argv[2] ?? "stop";
const port = DEFAULT_PORT;

if (!["status", "stop"].includes(action) || process.argv.length > 3) {
  process.stderr.write("Usage: node scripts/webui-port.mjs [status|stop]\n");
  process.stderr.write(`The WebUI always uses fixed local port ${DEFAULT_PORT}.\n`);
  process.exit(2);
}

if (action === "status") {
  const pids = listenerPids(port);
  const stalePids = staleWebuiListenerPids();
  process.stdout.write(
    pids.length || stalePids.length
      ? [
          pids.length ? `webui port ${port}: listener pid(s) ${pids.join(", ")}` : `webui port ${port}: no listener`,
          stalePids.length
            ? `stale webui listener pid(s) on ${STALE_PORT_START}-${STALE_PORT_END}: ${stalePids.join(", ")}`
            : `stale webui listeners on ${STALE_PORT_START}-${STALE_PORT_END}: none`
        ].join("\n") + "\n"
      : `webui port ${port}: no listener\n`
  );
  process.exit(0);
}

const stopped = await stopListeners(port);
const stoppedStale = await stopPids(staleWebuiListenerPids(), () => staleWebuiListenerPids());
const stoppedAll = uniqueNumbers([...stopped, ...stoppedStale]);
process.stdout.write(
  stoppedAll.length
    ? `webui port ${port}: stopped listener pid(s) ${stoppedAll.join(", ")}\n`
    : `webui port ${port}: no existing listener\n`
);

function listenerPids(portNumber) {
  const result = spawnSync("lsof", ["-nP", `-tiTCP:${portNumber}`, "-sTCP:LISTEN"], {
    encoding: "utf8"
  });
  if (result.error?.code === "ENOENT") {
    process.stderr.write("lsof is unavailable; cannot inspect an existing WebUI listener.\n");
    return [];
  }
  if (result.status !== 0 && !result.stdout.trim()) {
    return [];
  }
  return result.stdout
    .split(/\s+/)
    .map((pid) => Number.parseInt(pid, 10))
    .filter((pid) => Number.isInteger(pid) && pid > 0 && pid !== process.pid);
}

async function stopListeners(portNumber) {
  const pids = listenerPids(portNumber);
  if (!pids.length) return [];
  return stopPids(pids, () => listenerPids(portNumber));
}

async function stopPids(pids, currentPids) {
  const targets = uniqueNumbers(pids);
  if (!targets.length) return [];

  for (const pid of targets) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  await sleep(350);
  const remaining = currentPids().filter((pid) => targets.includes(pid));
  for (const pid of remaining) {
    try {
      process.kill(pid, "SIGKILL");
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }

  await sleep(100);
  const stillListening = currentPids().filter((pid) => targets.includes(pid));
  if (stillListening.length) {
    process.stderr.write(`webui port ${port}: failed to stop pid(s) ${stillListening.join(", ")}\n`);
    process.exit(1);
  }
  return targets;
}

function staleWebuiListenerPids() {
  const stale = [];
  for (let portNumber = STALE_PORT_START; portNumber <= STALE_PORT_END; portNumber += 1) {
    for (const pid of listenerPids(portNumber)) {
      if (isWebuiServerPid(pid)) stale.push(pid);
    }
  }
  return uniqueNumbers(stale);
}

function isWebuiServerPid(pid) {
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8" });
  if (result.status !== 0) return false;
  return result.stdout.includes("webui/server.mjs");
}

function uniqueNumbers(values) {
  return [...new Set(values)].filter((value) => Number.isInteger(value) && value > 0);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
