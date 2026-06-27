#!/usr/bin/env node
import fs from "node:fs";
import { resolveProjectPath } from "./core/paths.js";
import { planJob } from "./ops/plans/planner.js";

function usage(): never {
  console.error("Usage: node mcp-server/dist/cli.js <job-spec.json> [profile-config.yaml]");
  process.exit(2);
}

const jobSpecPath = process.argv[2];
const configPath = process.argv[3];

if (!jobSpecPath) {
  usage();
}

const jobSpec = JSON.parse(fs.readFileSync(resolveProjectPath(jobSpecPath), "utf8"));
const plan = planJob(jobSpec, { configPath });

console.log(JSON.stringify(plan, null, 2));
