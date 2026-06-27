import { assertApprovalBoundTo } from "../../lib/auth.js";
import type { ApprovalRecord, PlannedJob, RetryLineage, RunRecord } from "../../core/types.js";

export type SubmitApprovalOperation = "jobs.submit" | "jobs.retry";

export function expectedApprovalOperationForPlan(plan: PlannedJob, runRecord: RunRecord): SubmitApprovalOperation {
  const operation = plan.approval_operation ?? (plan.retry_of ? "jobs.retry" : "jobs.submit");
  if (operation !== "jobs.submit" && operation !== "jobs.retry") {
    throw new Error(`Unsupported approval_operation on planned job: ${String(operation)}`);
  }

  if (operation === "jobs.retry" && !plan.retry_of) {
    throw new Error("Retry approval operation requires retry_of metadata on the planned job");
  }
  if (operation === "jobs.submit" && plan.retry_of) {
    throw new Error("Retry-derived planned jobs require jobs.retry approval, not jobs.submit");
  }
  if (Boolean(plan.retry_of) !== Boolean(runRecord.retry_of)) {
    throw new Error("Retry metadata mismatch between saved plan and run record");
  }
  if (plan.retry_of && runRecord.retry_of && !retryLineageMatches(plan.retry_of, runRecord.retry_of)) {
    throw new Error("Retry lineage mismatch between saved plan and run record");
  }

  return operation;
}

export function assertApprovalUsableForPlan(
  approval: ApprovalRecord,
  runId: string,
  profileId: string,
  platform: string,
  planHash: string,
  expectedOperation: SubmitApprovalOperation
): void {
  assertApprovalBoundTo(approval, {
    operation: expectedOperation,
    runId,
    profileId,
    platform,
    planHash,
    identityMessage: "Approval does not match the planned run identity",
    planHashMessage: "Approval plan_hash does not match the planned job"
  });
}

function retryLineageMatches(left: RetryLineage, right: RetryLineage): boolean {
  return (
    left.source_run_id === right.source_run_id &&
    left.source_status === right.source_status &&
    left.source_plan_hash === right.source_plan_hash &&
    left.planned_at === right.planned_at &&
    left.reason === right.reason
  );
}
