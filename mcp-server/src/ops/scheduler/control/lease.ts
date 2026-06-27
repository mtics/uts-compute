// control/lease.ts — brain-side single-writer LEASE decision per (profile, node) (spec §3.2). Two
// clients (Claude Code + Codex) across possibly multiple devices would otherwise both pre-account, both
// write a PLAN (atomic rename = last-writer-wins => silent queue clobber), and both start progressors =>
// double placement. This re-instantiates the vendored SchedulerLock (O_CREAT|O_EXCL + stale-pid
// detection, lock.py:50) as a lease whose holder is a LeaseOwner. This module is PURE DECISION: the
// node-side write (sshWriteAtomicJson) and the node-side enforcement (progressor refuses a PLAN whose
// lease_owner != current holder) are Phase C. Staleness uses NODE-clock age only — never a laptop-now
// minus node-timestamp subtraction (spec §2.3 clock rule).
//
// NOTE: the takeover decision here is necessarily NON-EXCLUSIVE until Phase C. Two brains can each read a
// stale lease and each decide "takeover" before either writes; this module makes the DECISION but cannot
// break the tie. The tie is resolved node-side in Phase C by the atomic O_CREAT|O_EXCL write (the
// vendored SchedulerLock semantics) — exactly one writer wins the create; the loser observes the new
// holder and steps down. Treat a "takeover" here as provisional until that exclusive write succeeds.

import type { LeaseOwner } from "../../../core/types.js";

export interface LeaseStalenessInput {
  nodeNowEpoch: number;          // node clock "now" (e.g. a fresh node-side epoch read)
  heartbeatEpoch: number | null; // the holder's last heartbeat, node clock; null when never seen
  staleSeconds: number;          // age beyond which the holder is presumed dead
}

export interface LeaseDecisionInput extends LeaseStalenessInput {
  held: LeaseOwner | null; // current on-node lease holder, or null when unheld
  me: LeaseOwner;          // this brain's identity
}

export type LeaseDecision =
  | { action: "acquire" }                    // no holder — take it
  | { action: "refresh" }                    // we already hold it — renew
  | { action: "takeover"; from: LeaseOwner } // a STALE other holder — adopt in-flight work (§3.2/§5c)
  | { action: "blocked"; holder: LeaseOwner }; // a LIVE other holder — refuse, do not clobber

// A lease with no heartbeat, or whose node-clock heartbeat age exceeds staleSeconds, is stale.
export function isLeaseStale(input: LeaseStalenessInput): boolean {
  if (input.heartbeatEpoch === null) return true;
  return input.nodeNowEpoch - input.heartbeatEpoch > input.staleSeconds;
}

function sameOwner(a: LeaseOwner, b: LeaseOwner): boolean {
  return a.client === b.client && a.device_id === b.device_id;
}

export function decideLease(input: LeaseDecisionInput): LeaseDecision {
  if (!input.held) return { action: "acquire" };
  if (sameOwner(input.held, input.me)) return { action: "refresh" };
  if (isLeaseStale(input)) return { action: "takeover", from: input.held };
  return { action: "blocked", holder: input.held };
}
