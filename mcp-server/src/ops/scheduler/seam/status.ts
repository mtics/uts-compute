// CP-4: the ONE node-STATE-status -> RunRecord.status mapper. Phase B shipped the canonical
// implementation in seam/protocol.ts (nodeStatusToRunStatus); this module is a THIN RE-EXPORT only, so
// Phase C (seam/reconcile.ts) and Phase D (ops/jobs/adopt.ts) can import from a stable `./status.js`
// path without ever forking a second copy of the mapping table (which would silently drift). Do NOT add
// a duplicate implementation here.
export { nodeStatusToRunStatus } from "./protocol.js";
export type { IhpcJobStatus } from "../../../core/types.js";
