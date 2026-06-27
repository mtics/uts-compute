// Seed illustrative run-records into .uts-computing/runs so the dashboard has something to show
// without a live cluster. Pure demo data — no secrets, no real account identifiers. Run via
// `npm run webui:demo` (seeds, then serves), or `node webui/demo-seed.mjs` on its own. Safe to re-run;
// it overwrites only its own demo-* files. Note: `npm test`'s pretest wipes .uts-computing/, so re-run
// this if the samples disappear.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const runsDir = path.join(repoRoot, ".uts-computing", "runs");
fs.mkdirSync(runsDir, { recursive: true });

// Deterministic fake 64-hex plan hash from a seed (demo only — not a real digest).
const fakeHash = (seed) => {
  let h = 2166136261;
  const out = [];
  for (let i = 0; i < 64; i++) {
    h = (h ^ seed.charCodeAt(i % seed.length)) >>> 0;
    h = (h * 16777619) >>> 0;
    out.push("0123456789abcdef"[(h >>> (i % 24)) & 15]);
  }
  return out.join("");
};
// ISO timestamp `days`/`hours` before the fixed demo "now" (2026-06-17T04:00Z), so the activity trend
// spans a week regardless of when the seed runs.
const NOW = Date.parse("2026-06-17T04:00:00.000Z");
const at = (days, hours = 0) => new Date(NOW - (days * 24 + hours) * 3600 * 1000).toISOString();

const PROJECTS = {
  "diffusion-ablation": "proj-abc123def456",
  "rlhf-q3": "proj-9988ccddeeff",
  "vision-pretrain": "proj-55aa11bb22cc"
};

const base = (o) => ({
  run_id: o.run_id,
  profile_id: o.profile_id ?? "uts-hpc-account-a",
  platform: o.platform ?? "uts-hpc",
  remote_job_id: o.remote_job_id ?? null,
  project: o.project ?? "diffusion-ablation",
  project_hash: PROJECTS[o.project ?? "diffusion-ablation"],
  job_type: o.job_type,
  status: o.status,
  plan_hash: o.plan_hash ?? fakeHash(o.run_id),
  created_at: o.created_at,
  updated_at: o.updated_at ?? o.created_at,
  events: o.events ?? [{ at: o.created_at, kind: "dry-run-plan", summary: "Rendered pbs-cpu in local dry-run mode" }],
  ...(o.submission ? { submission: o.submission } : {}),
  ...(o.usage ? { usage: o.usage } : {}),
  ...(o.retry_of ? { retry_of: o.retry_of } : {}),
  reproducibility: { captured_at: o.created_at, command: o.command ?? "python train.py --epochs 10", git: { sha: fakeHash(o.run_id).slice(0, 40), branch: "main", dirty: o.dirty ?? false } }
});

// requested + usage builders (HPC PBS shape).
const sub = (q, node, ncpus, mem, wt, ngpus, submittedAt) => ({
  account_label: "Account A", cluster: "cetus.hpc.uts.edu.au", queue: q, node, submitted_at: submittedAt,
  requested: { ncpus, memory_gb: mem, walltime: wt, ngpus }
});
const use = (wallS, mem, ncpus, ngpus, coreH, gpuH, eff) =>
  ({ walltime_seconds: wallS, mem_gb: mem, ncpus, ngpus, core_hours: coreH, gpu_hours: gpuH, cpu_efficiency_percent: eff });

const records = [
  // diffusion-ablation
  base({ run_id: "demo-train-01", project: "diffusion-ablation", job_type: "train", status: "finished", remote_job_id: "4321.cetus",
    created_at: at(0, 3), updated_at: at(0, 2.3), submission: sub("smallq", "node07", 8, 32, "08:00:00", 0, at(0, 3)),
    usage: use(2640, 6.2, 8, 0, 5.87, 0, 88) }),
  base({ run_id: "demo-eval-02", project: "diffusion-ablation", job_type: "eval", status: "running", remote_job_id: "4322.cetus",
    created_at: at(0, 2.9), submission: sub("smallq", "node11", 4, 16, "04:00:00", 0, at(0, 2.8)),
    events: [{ at: at(0, 2.9), kind: "dry-run-plan", summary: "Rendered pbs-cpu in local dry-run mode" },
             { at: at(0, 2.8), kind: "live-submit", summary: "Submitted PBS job 4322.cetus", redacted_command: "ssh <profile-host> qsub" }] }),
  base({ run_id: "demo-eval-08", project: "diffusion-ablation", job_type: "eval", status: "finished", remote_job_id: "4318.cetus",
    created_at: at(2, 1), updated_at: at(2, 0.5), submission: sub("smallq", "node04", 4, 16, "04:00:00", 0, at(2, 1)),
    usage: use(5400, 9.5, 4, 0, 6.0, 0, 61) }),
  base({ run_id: "demo-train-13", project: "diffusion-ablation", job_type: "train", status: "finished", remote_job_id: "4309.cetus", dirty: true,
    created_at: at(2, 6), updated_at: at(2, 2), submission: sub("smallq", "node09", 16, 96, "12:00:00", 0, at(2, 6)),
    usage: use(14400, 18, 16, 0, 64, 0, 31) }),
  base({ run_id: "demo-train-10", project: "diffusion-ablation", job_type: "train", status: "failed", remote_job_id: "4290.cetus",
    created_at: at(5, 4), updated_at: at(5, 3.8), submission: sub("smallq", "node02", 8, 32, "08:00:00", 0, at(5, 4)),
    usage: use(900, 31, 8, 0, 2.0, 0, 18) }),

  // rlhf-q3 (GPU)
  base({ run_id: "demo-sweep-03", project: "rlhf-q3", job_type: "sweep-member", status: "failed", remote_job_id: "4323.cetus",
    created_at: at(0, 3.2), updated_at: at(0, 3.1), submission: sub("gpuq", "gpu03", 8, 64, "12:00:00", 1, at(0, 3.1)),
    usage: use(360, 61, 8, 1, 0.8, 0.1, 12) }),
  base({ run_id: "demo-train-04", project: "rlhf-q3", job_type: "train", status: "finished", remote_job_id: "4324.cetus",
    created_at: at(1, 6), updated_at: at(0, 18), submission: sub("gpuq", "gpu05", 12, 48, "24:00:00", 2, at(1, 6)),
    usage: use(30000, 44, 12, 2, 100, 16.7, 74) }),
  base({ run_id: "demo-sweep-09", project: "rlhf-q3", job_type: "sweep-member", status: "finished", remote_job_id: "4315.cetus",
    created_at: at(1, 2), updated_at: at(1, 0.5), submission: sub("gpuq", "gpu02", 8, 64, "10:00:00", 1, at(1, 2)),
    usage: use(4200, 30, 8, 1, 9.3, 1.2, 22) }),
  base({ run_id: "demo-sweep-12", project: "rlhf-q3", job_type: "sweep-member", status: "finished", remote_job_id: "4280.cetus",
    created_at: at(6, 5), updated_at: at(6, 1), submission: sub("gpuq", "gpu06", 16, 96, "24:00:00", 4, at(6, 5)),
    usage: use(50400, 88, 16, 4, 224, 56, 79) }),
  base({ run_id: "demo-clone-05", project: "rlhf-q3", job_type: "sweep-member", status: "planned",
    created_at: at(0, 1), submission: sub("gpuq", "—", 8, 96, "12:00:00", 1, null),
    retry_of: { source_run_id: "demo-sweep-03", source_status: "failed", source_plan_hash: fakeHash("demo-sweep-03"), planned_at: at(0, 1), reason: "rerun after OOM (exit 137) with more memory" } }),

  // vision-pretrain
  base({ run_id: "demo-pretrain-06", project: "vision-pretrain", job_type: "train", status: "finished", remote_job_id: "4300.cetus",
    created_at: at(3, 5), updated_at: at(3, 1), submission: sub("smallq", "node15", 16, 32, "12:00:00", 0, at(3, 5)),
    usage: use(13200, 28, 16, 0, 58.7, 0, 81) }),
  base({ run_id: "demo-pretrain-07", project: "vision-pretrain", job_type: "train", status: "finished", remote_job_id: "4295.cetus",
    created_at: at(4, 7), updated_at: at(4, 1), submission: sub("gpuq", "gpu01", 12, 80, "24:00:00", 2, at(4, 7)),
    usage: use(21600, 50, 12, 2, 72, 12, 35) }),
  base({ run_id: "demo-eval-11", project: "vision-pretrain", job_type: "eval", status: "running", remote_job_id: "4326.cetus",
    created_at: at(0, 0.5), submission: sub("smallq", "node18", 4, 16, "06:00:00", 0, at(0, 0.4)),
    events: [{ at: at(0, 0.5), kind: "dry-run-plan", summary: "Rendered pbs-cpu in local dry-run mode" },
             { at: at(0, 0.4), kind: "live-submit", summary: "Submitted PBS job 4326.cetus", redacted_command: "ssh <profile-host> qsub" }] })
];

for (const record of records) {
  fs.writeFileSync(path.join(runsDir, `${record.run_id}.json`), `${JSON.stringify(record, null, 2)}\n`, "utf8");
}
process.stdout.write(`demo-seed: wrote ${records.length} sample runs to .uts-computing/runs\n`);
