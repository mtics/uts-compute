// campaign/select.ts — campaign-submit STEP 1 (pure): which saved run records are the launch
// candidates for one campaign? A run is a candidate iff it is (a) tagged with THIS campaign_id
// (DISCLOSURE attribution, set by jobs.plan/sweep.plan), (b) still in the "planned" pending state
// (never started — terminal/running runs are excluded), and (c) a uts-ihpc run (the internalized
// scheduler is iHPC-only; a uts-hpc PBS array under the same campaign goes through qsub, not here).
//
// PURE: zero IO. The caller (campaign/submit.ts orchestration, then the tool handler) reads the run
// records from the store and passes them in; this is the structure-carrying "what do we launch"
// decision, kept separate from the lease/conformance/placement/launch steps it feeds.

import { PLATFORM } from "../../../core/types.js";
import type { RunRecord } from "../../../core/types.js";

// The only launch-eligible status. Mirrors control/queue.ts LAUNCHABLE: "planned" is the pending,
// never-started state jobs.plan writes; every other status either occupies a slot or is terminal.
const LAUNCHABLE_STATUS: RunRecord["status"] = "planned";

export function selectPlannedRuns(campaignId: string, runRecords: RunRecord[]): RunRecord[] {
  return runRecords.filter(
    (record) =>
      record.campaign_id === campaignId &&
      record.status === LAUNCHABLE_STATUS &&
      record.platform === PLATFORM.IHPC
  );
}
