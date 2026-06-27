// seam/protocol-py.ts — the NODE-side wire Python for the campaign STATE protocol. The seam owns the
// PLAN/STATE boundary contract (protocol.ts is the brain-side schema/hardening half); this is its
// node-side half: the inline python3 program the brain ships over SSH to READ a campaign's state.json.
//
// It lives here (not in ops/jobs) so the scheduler subtree is the SINGLE owner of the node wire
// protocol and the dependency flow stays strictly downward. BOTH the single-run reconcile in
// ops/jobs/jobs.ts AND the campaign brain in ops/scheduler/campaign/start.ts import IHPC_STATE_READ_PY
// from here — neither keeps a private copy that could drift from the protocol. (The per-pid status /
// logs / cancel and the PBS/qstat heredocs are NOT campaign-STATE protocol and stay in ops/jobs.)

import { pyImports, PY_FAIL_FIXED, PY_DECODE_SPEC } from "../../../lib/remote-python.js";

// IHPC_STATE_READ_PY: cat the WHOLE campaign state.json once (never tail, spec 2.3). Mirrors the
// IHPC_STATUS_PY inline-python discipline (pyImports + PY_FAIL_FIXED + PY_DECODE_SPEC). The campaign_id
// is sanity-checked against path-traversal before it is expanded under the scheduler state dir.
export const IHPC_STATE_READ_PY = String.raw`${pyImports(["base64", "json", "os", "sys"])}
${PY_FAIL_FIXED}
${PY_DECODE_SPEC("state")}
campaign_id = spec.get("campaign_id")
if not isinstance(campaign_id, str) or not campaign_id or "/" in campaign_id or ".." in campaign_id:
    fail("unsafe campaign_id")
path = os.path.expanduser(f"~/.uts-computing/scheduler/state/{campaign_id}/state.json")
if not os.path.isfile(path):
    fail("no state.json for campaign")
with open(path, "r", encoding="utf-8") as handle:
    sys.stdout.write(handle.read())   # whole file, never tail (spec 2.3)
`;
