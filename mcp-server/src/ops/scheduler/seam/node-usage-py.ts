// seam/node-usage-py.ts — the NODE-side inline Python for the READ-ONLY one-shot per-GPU usage probe
// (ihpc.node.usage). Lives next to canary-py.ts / protocol-py.ts: all three are inline python3 programs
// the brain ships over the SAME two-hop SSH seam (sshSupervisorArgs) to a compute node. The scheduler
// subtree owns the node wire programs; the dependency flow stays strictly downward.
//
// NODE_USAGE_PY runs ONE FIXED command with ZERO interpolation of any caller input. It is fed an
// encodeSpec({kind:"node-usage"}) argv only to satisfy the shared sshSupervisorArgs contract (the inner
// `python3 - <encodedSpec>` form); the probe IGNORES the spec entirely and runs a single fixed
// nvidia-smi argv list. It is deliberately NARROWER than CANARY_PY: it imports NOTHING beyond the
// stdlib (no torch, no CUDA check), runs a SINGLE nvidia-smi query, and WRITES NOTHING on the node — it
// is a pure live read of per-GPU utilization + memory.
//
// It must NEVER raise to stderr on a missing tool — a missing/failed nvidia-smi is DATA captured in the
// `errors[]` of the single JSON line printed to stdout (with ok:false and an EMPTY gpus[]), and it
// always exits 0. The brain (probeNodeUsage) treats ok:false / empty gpus as node-unverifiable and
// NEVER fabricates a reading. Like CANARY_PY it carries its own tiny stdlib-only preamble (it does NOT
// use the pyImports/PY_FAIL_FIXED/PY_DECODE_SPEC fail-on-bad-spec guard — this probe reports, it never
// aborts on the ignored spec) and is intentionally NOT in the remote-python golden-snapshot set; its
// contract is its STDOUT JSON shape, pinned by a real-python3 fork test instead.

export const NODE_USAGE_PY = String.raw`import json
import subprocess
import sys

errors = []

# Run a FIXED argv list (no shell, no interpolation). Return (rc, stdout) or (None, "") when the tool is
# absent. A missing binary (FileNotFoundError) or a non-zero exit is DATA, never a crash.
def run_fixed(argv):
    try:
        proc = subprocess.run(argv, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
                              universal_newlines=True, timeout=20, check=False)
    except FileNotFoundError:
        errors.append(argv[0] + " not found on node")
        return (None, "")
    except Exception as exc:  # noqa: BLE001 - any launch failure is reported, never raised
        errors.append(argv[0] + " failed to run: " + str(exc))
        return (None, "")
    if proc.returncode != 0:
        detail = (proc.stderr or proc.stdout or "").strip().splitlines()
        first = detail[0] if detail else ("exit " + str(proc.returncode))
        errors.append(argv[0] + " exited non-zero: " + first)
        return (proc.returncode, proc.stdout or "")
    return (proc.returncode, proc.stdout or "")

# ONE fixed nvidia-smi CSV query: per-GPU index, name, utilization (%), memory used + total (MiB).
# Parsed defensively: a malformed row is skipped, not fatal.
query_rc, query_out = run_fixed([
    "nvidia-smi",
    "--query-gpu=index,name,utilization.gpu,memory.used,memory.total",
    "--format=csv,noheader,nounits",
])
gpus = []
for row in query_out.splitlines():
    row = row.strip()
    if not row:
        continue
    parts = [p.strip() for p in row.split(",")]
    if len(parts) < 5:
        continue
    try:
        index = int(parts[0])
        name = parts[1]
        util = int(parts[2])
        mem_used = int(parts[3])
        mem_total = int(parts[4])
    except ValueError:
        continue
    gpus.append({
        "index": index,
        "name": name,
        "utilization_gpu_percent": util,
        "memory_used_mb": mem_used,
        "memory_total_mb": mem_total,
    })

# A SECOND fixed query: per-process GPU MEMORY (pid, used GPU memory MiB). Per-process memory is the
# reliable per-PID signal; per-process utilization is NOT exposed by this query (it needs pmon and is
# flaky), so we report memory only. Best-effort: a failure here leaves processes empty and does NOT
# change ok (the per-GPU reading remains the sole node-verifiability signal). Lets the brain attribute a
# node's GPU to one run by its observed pid. Same defensive parse: a malformed row is skipped, not fatal.
apps_rc, apps_out = run_fixed([
    "nvidia-smi",
    "--query-compute-apps=pid,used_gpu_memory",
    "--format=csv,noheader,nounits",
])
processes = []
for row in apps_out.splitlines():
    row = row.strip()
    if not row:
        continue
    parts = [p.strip() for p in row.split(",")]
    if len(parts) < 2:
        continue
    try:
        pid = int(parts[0])
        used = int(parts[1])
    except ValueError:
        continue
    processes.append({"pid": pid, "used_memory_mb": used})

# ok is the node-side verdict: nvidia-smi succeeded AND reported at least one parseable GPU. The brain
# treats ok:false / empty gpus as node-unverifiable and refuses to fabricate a reading.
ok = query_rc == 0 and len(gpus) > 0

print(json.dumps({
    "ok": ok,
    "gpus": gpus,
    "processes": processes,
    "errors": errors,
}))
sys.exit(0)
`;
