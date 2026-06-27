// jobs.diagnose: classify why a run failed and emit the safe next action. Automates the
// failure-playbooks taxonomy (access / quota / resource-request / environment / command /
// data-path / session-timeout) over the bounded, redacted job logs plus scheduler status.
// classifyFailure is a pure function; diagnoseJob orchestrates jobs.status + jobs.logs.

import { getJobLogs, getJobStatus, type JobOperationOptions } from "./jobs.js";
import type { Platform, RunRecord } from "../../core/types.js";

export type FailureCategory =
  | "none"
  | "session-timeout"
  | "resource-request"
  | "quota"
  | "access"
  | "environment"
  | "data-path"
  | "command"
  | "unknown";

export type Confidence = "high" | "medium" | "low";

export interface Diagnosis {
  category: FailureCategory;
  confidence: Confidence;
  likely_cause: string;
  next_action: string;
  evidence: string[];
}

export interface DiagnoseResult extends Diagnosis {
  run_id: string;
  profile_id: string;
  platform: Platform;
  status: RunRecord["status"];
  scheduler_state?: string;
}

interface Rule {
  category: FailureCategory;
  confidence: Confidence;
  patterns: RegExp[];
  likely_cause: string;
  next_action: string;
}

// Priority order: most specific / highest-severity first; the first matching rule wins.
const RULES: Rule[] = [
  {
    category: "session-timeout",
    confidence: "high",
    patterns: [/=>>\s*PBS:\s*job killed:\s*walltime/i, /walltime.{0,30}(exceed|kill|limit|reached)/i, /(exceed|kill|over).{0,30}walltime/i],
    likely_cause: "The job exceeded its walltime limit and was killed by the scheduler.",
    next_action: "Re-plan with a longer walltime, or checkpoint and resume, then jobs.retry.plan."
  },
  {
    category: "resource-request",
    confidence: "high",
    patterns: [/out of memory|oom-?kill|MemoryError|std::bad_alloc|cannot allocate memory|exceed.{0,20}(memory|mem|pmem|vmem)|Killed\b.{0,40}signal 9/i],
    likely_cause: "The job likely ran out of memory or exceeded its requested resources.",
    next_action: "Check actuals with jobs.usage, re-plan with more memory/CPUs, then jobs.retry.plan."
  },
  {
    category: "quota",
    confidence: "high",
    patterns: [/Disk quota exceeded|over quota|quota exceeded|EDQUOT/i],
    likely_cause: "A storage or account quota was exceeded.",
    next_action: "Run quotas.refresh, free space or request more allocation, then re-plan."
  },
  {
    category: "access",
    confidence: "high",
    patterns: [/Permission denied \(publickey|Connection (refused|timed out|closed)|Could not resolve hostname|Host key verification failed|No route to host|ssh:.*(Could not|connect)/i],
    likely_cause: "A connectivity or SSH problem prevented reaching UTS.",
    next_action: "Run access.check / access.doctor; reconnect the VPN or fix SSH, then retry."
  },
  {
    category: "environment",
    confidence: "high",
    patterns: [/ModuleNotFoundError|No module named|ImportError|command not found|GLIBCXX|version `GLIBC|cannot find -l|undefined symbol|No such file or directory:.{0,200}\.so|conda:.{0,40}not found/i],
    likely_cause: "A required module, library, or environment dependency was missing.",
    next_action: "Fix the declared modules/environment in the job spec (module load / env) and re-plan."
  },
  {
    category: "data-path",
    confidence: "medium",
    patterns: [/No such file or directory|FileNotFoundError|cannot open|cannot access|Is a directory|Not a directory|Permission denied:?\s*['"]?\//i],
    likely_cause: "An input or output path was missing or inaccessible.",
    next_action: "Verify the workdir, inputs, and outputs paths and re-plan; do not browse arbitrary remote paths."
  },
  {
    category: "command",
    confidence: "medium",
    patterns: [/Traceback \(most recent call last\)|Segmentation fault|core dumped|Exception\b|[A-Za-z.]{0,40}Error:|assert(ion)? failed/i],
    likely_cause: "The job command raised an error or exited non-zero.",
    next_action: "Inspect the bounded logs, fix the command, and re-plan."
  }
];

export function classifyFailure(input: { status: string; schedulerState?: string; logText: string }): Diagnosis {
  const text = input.logText ?? "";
  for (const rule of RULES) {
    for (const pattern of rule.patterns) {
      const match = pattern.exec(text);
      if (match) {
        return {
          category: rule.category,
          confidence: rule.confidence,
          likely_cause: rule.likely_cause,
          next_action: rule.next_action,
          evidence: [lineContaining(text, match.index)]
        };
      }
    }
  }
  if (input.status === "finished") {
    return {
      category: "none",
      confidence: "low",
      likely_cause: "No failure signal was detected in the available status and logs.",
      next_action: "If the run still looks wrong, inspect fuller logs or the run record.",
      evidence: []
    };
  }
  return {
    category: "unknown",
    confidence: "low",
    likely_cause: "Could not classify the failure from the available status and logs.",
    next_action: "Inspect fuller jobs.logs and the run record manually, then jobs.retry.plan if appropriate.",
    evidence: []
  };
}

export async function diagnoseJob(
  input: { runId: string; maxBytes?: number },
  options: JobOperationOptions = {}
): Promise<{ diagnosis: DiagnoseResult }> {
  const status = (await getJobStatus({ runId: input.runId }, options)).status;
  let logText = "";
  try {
    const logs = (await getJobLogs({ runId: input.runId, stream: "both", maxBytes: input.maxBytes ?? 8000 }, options)).logs;
    logText = logs.streams.map((stream) => stream.content).join("\n");
  } catch {
    logText = "";
  }
  const classification = classifyFailure({ status: status.status, schedulerState: status.scheduler_state, logText });
  return {
    diagnosis: {
      run_id: status.run_id,
      profile_id: status.profile_id,
      platform: status.platform,
      status: status.status,
      ...(status.scheduler_state ? { scheduler_state: status.scheduler_state } : {}),
      ...classification
    }
  };
}

function lineContaining(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index) + 1;
  const endIndex = text.indexOf("\n", index);
  const end = endIndex === -1 ? text.length : endIndex;
  return text.slice(start, end).trim().slice(0, 200);
}
