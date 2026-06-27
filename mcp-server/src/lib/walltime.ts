// Pure PBS-walltime codec. The single home for the HH:MM:SS / [DD:]HH:MM:SS parse + format
// mechanism that was hand-rolled in four business modules (approval-policy, accounting, retry,
// quota-limits). A leaf module: it owns NO policy — callers keep every threshold, clamp, factor and
// reason string. See docs/archive/layering-audit-2026-06.md finding 11.
//
// The strict/lenient split is LOAD-BEARING and must stay as two named functions, never flattened
// (the audit forbids merging strict and lenient parsers):
//
//   parseWalltimeSeconds — STRICT. Exactly three colon-groups with two-digit MM/SS
//     (^(\d+):(\d{2}):(\d{2})$), returns number | undefined. For USER-SUPPLIED Resource_List
//     requests where a malformed value must be rejected (undefined), not silently zeroed.
//
//   parseHmsSeconds — LENIENT. Splits on ":" and folds base-60, so it accepts a [DD:]HH:MM:SS
//     day-prefix and hours that exceed 24, returning 0 on any non-finite part. For the
//     scheduler-emitted resources_used.* fields where the format is trusted and we want a number.
//
// formatWalltime is the inverse of the strict form: seconds -> zero-padded HH:MM:SS.

export function parseWalltimeSeconds(value: string): number | undefined {
  const match = /^(\d+):(\d{2}):(\d{2})$/.exec(value.trim());
  if (!match) {
    return undefined;
  }
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
}

// PBS walltime/cput are "[DD:]HH:MM:SS" with hours that may exceed 24. Folds every colon-group in
// base-60 (so a 4-group day prefix is naturally accepted) and returns 0 if any part is non-finite.
export function parseHmsSeconds(value: string): number {
  const parts = value.split(":").map((part) => Number.parseInt(part, 10));
  if (parts.some((part) => !Number.isFinite(part))) {
    return 0;
  }
  return parts.reduce((total, part) => total * 60 + part, 0);
}

export function formatWalltime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${pad2(hours)}:${pad2(minutes)}:${pad2(secs)}`;
}

function pad2(value: number): string {
  return String(value).padStart(2, "0");
}
