// Pure classifier for "why did this remote (SSH) command fail?" — the root-cause fix for the field
// report that operators kept their manual `ssh -o ConnectTimeout=…` path alive because the plugin gave
// cryptic failures when the UTS VPN dropped. When the VPN is down, ssh fails with a timeout / exitCode
// 255 / a "Network is unreachable" | "Operation timed out" | "No route to host" | "Could not resolve
// hostname" banner, and no tool told the user "your VPN is probably down — connect it and retry (or run
// access.doctor --export-ssh)". This module turns a raw CommandResult into a classified kind plus, when
// the failure is a network-drop symptom, a single actionable hint.
//
// Leaf module: imports only the CommandResult TYPE from lib/process (a type-only import erases at
// compile time, so this remains a pure value-free-import leaf — no domain imports, no cycles). It owns
// NO policy about WHICH host/argv may run; it only reads an already-produced result and classifies it.
//
// CRITICAL non-goal (the misclassification guard the field report called out): a remote command that
// actually RAN but exited non-zero for application reasons (a real tool's own error with substantive
// stdout/stderr) must NOT be mistaken for a network drop. We POSITIVELY match the network-symptom
// banners; everything else with output defaults to "remote", the safe direction (a wrong VPN hint on a
// genuine remote error would mislead the operator into chasing connectivity instead of the real bug).

import type { CommandResult } from "./process.js";

// The kinds, narrowest-useful set:
//   - "ok":          exit 0; the command succeeded (callers may still find an app-level empty result).
//   - "timeout":     the local SIGTERM fired (runProcess timedOut) — the probe never returned.
//   - "unreachable": ssh could not reach the host (network is unreachable / no route / connect timed
//                    out / operation timed out), or a bare exit-255 transport failure with no banner.
//   - "dns":         the host name did not resolve (could not resolve hostname / name or service not
//                    known) — the VPN typically provides the resolver route, so still a VPN-drop symptom.
//   - "auth":        the network reached sshd but authentication/host-key failed (permission denied /
//                    host key verification failed) — NOT a VPN drop.
//   - "remote":      the remote command ran and exited non-zero for its own reasons, or any other
//                    non-network failure. NOT a VPN drop.
export type RemoteFailureKind = "ok" | "timeout" | "unreachable" | "dns" | "auth" | "remote";

export interface RemoteFailureClassification {
  // True only for the VPN-drop symptom kinds (timeout / unreachable / dns). When true, `hint` is set.
  network_unreachable: boolean;
  kind: RemoteFailureKind;
  // The single actionable next-step message — present iff network_unreachable.
  hint?: string;
}

// The one VPN-down next-step message, pinned as a const so its wording lives in exactly one place and
// every wired tool surfaces the SAME guidance. Mentions the UTS VPN (the inferred cause) and the manual
// fallback (access.doctor --export-ssh emits a secret-free ssh-config snippet for a human handoff).
export const NETWORK_DROP_HINT =
  "The UTS VPN is probably disconnected (the host was unreachable). Connect the UTS VPN and retry, " +
  "or run access.doctor --export-ssh to get a connection snippet for a manual SSH fallback.";

// DNS-resolution failure (host name didn't resolve). Checked BEFORE the generic unreachable patterns so
// "could not resolve hostname" lands as "dns", not "unreachable".
const DNS_FAILURE = /could not resolve hostname|name or service not known|nodename nor servname/i;

// Reached-but-rejected: the packets got to sshd (or a listening port), so routing worked — these are
// NOT a VPN drop. Checked BEFORE the unreachable patterns so e.g. "Connection refused" (a TCP RST from a
// reachable host) is not swept up by the broad "connection …" wording.
const AUTH_FAILURE = /permission denied|host key verification failed|too many authentication failures/i;
const CONNECTION_REFUSED = /connection refused/i;

// Network-unreachable banners (the VPN-down symptom set). `operation timed out` and `connection timed
// out` are the macOS/Linux ssh connect-timeout wordings; `network is unreachable` / `no route to host`
// are the routing-gone wordings; the `ssh: connect to host … port …:` prefix is ssh's own connect-
// failure banner head. Matched case-insensitively (real ssh emits mixed case).
const NETWORK_UNREACHABLE =
  /operation timed out|connection timed out|network is unreachable|no route to host|ssh: connect to host/i;

// Classify a finished CommandResult. Pure: same input → same output, no side effects, no I/O.
export function classifyRemoteFailure(result: CommandResult): RemoteFailureClassification {
  if (result.exitCode === 0) {
    return { network_unreachable: false, kind: "ok" };
  }

  // A local timeout (runProcess SIGTERM'd the child) is the clearest VPN-drop symptom: the probe never
  // came back. This takes precedence over any partial stderr.
  if (result.timedOut) {
    return unreachable("timeout");
  }

  const stderr = result.stderr ?? "";

  // Resolver failure first (a "could not resolve" message also contains no routing banner).
  if (DNS_FAILURE.test(stderr)) {
    return unreachable("dns");
  }

  // Reached-but-rejected: authentication / host-key (the network worked) — not a VPN drop.
  if (AUTH_FAILURE.test(stderr)) {
    return { network_unreachable: false, kind: "auth" };
  }

  // A refused connection means a reachable host actively rejected the port (TCP RST) — routing worked,
  // so this is NOT a VPN-down symptom. Classified as "remote" (reachable, just not connectable here);
  // checked before the broad unreachable patterns so it isn't mis-swept as unreachable.
  if (CONNECTION_REFUSED.test(stderr)) {
    return { network_unreachable: false, kind: "remote" };
  }

  // Routing-gone / connect-timeout banners.
  if (NETWORK_UNREACHABLE.test(stderr)) {
    return unreachable("unreachable");
  }

  // A bare exit-255 with NO stderr/stdout is the transport failure where ssh emitted nothing we
  // captured. ssh reserves 255 for its OWN failures (a remote tool returns its own small exit code and
  // leaves output), so an empty 255 is a transport drop, not an app error. Treat as unreachable.
  if (result.exitCode === 255 && !stderr.trim() && !(result.stdout ?? "").trim()) {
    return unreachable("unreachable");
  }

  // Everything else: the command ran and failed for its own reasons (substantive output, a non-255 exit,
  // or a spawn error whose message is not a network symptom). NOT a VPN drop — the safe default.
  return { network_unreachable: false, kind: "remote" };
}

function unreachable(kind: "timeout" | "unreachable" | "dns"): RemoteFailureClassification {
  return { network_unreachable: true, kind, hint: NETWORK_DROP_HINT };
}
