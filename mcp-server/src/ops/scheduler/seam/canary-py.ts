// seam/canary-py.ts — the NODE-side inline Python for the OPT-IN on-node GPU/CUDA canary. Lives next
// to protocol-py.ts (the campaign STATE protocol's node-side half) because both are inline python3
// programs the brain ships over the SAME two-hop SSH seam (sshSupervisorArgs) to a compute node. The
// scheduler subtree owns the node wire programs; the dependency flow stays strictly downward.
//
// CANARY_PY runs a FIXED set of commands with ZERO interpolation of any caller input. It is fed an
// encodeSpec({kind:"canary"}) argv only to satisfy the shared sshSupervisorArgs contract (the inner
// `python3 - <encodedSpec>` form); the probe IGNORES the spec entirely and runs fixed nvidia-smi argv
// lists plus an optional `import torch`. It must NEVER raise to stderr on a missing tool — every
// failure is captured in the `errors[]` of the single JSON line printed to stdout, and it always
// exits 0 (a missing nvidia-smi/torch on a degraded node is DATA the brain maps to a finding, not a
// crash). The brain (probeNodeCanary) parses the JSON last line and maps it to QueueFinding[].
//
// Unlike protocol-py.ts this program does NOT use the pyImports/PY_FAIL_FIXED/PY_DECODE_SPEC shared
// fragments: those embed a fail()/SystemExit(2) decode-guard that ABORTS on a malformed/absent spec,
// which is exactly the wrong posture here — the canary never aborts, it reports. So it carries its own
// tiny stdlib-only preamble. It is intentionally NOT registered in the remote-python golden-snapshot
// set (tests/lib/remote-python-snapshot.test.mjs) — that set pins the eight fail()/decode helpers; the
// canary's contract is its STDOUT JSON shape, pinned by a real-python3 fork test instead.

// BUSY thresholds (advisory, warning-level only): a GPU counts as "busy" when its utilization is at or
// above GPU_BUSY_UTIL_PERCENT, OR its used/total memory fraction is at or above GPU_BUSY_MEM_FRACTION.
// These live on the NODE side (the probe decides per-GPU busy) so the JSON the brain sees already
// carries the raw numbers AND the verdict is reproducible; the brain re-derives "all GPUs busy" from
// the raw numbers too (single source of truth for the numbers, defense-in-depth on the verdict).
export const GPU_BUSY_UTIL_PERCENT = 50;
export const GPU_BUSY_MEM_FRACTION = 0.5;

export const CANARY_PY = String.raw`import json
import subprocess
import sys

errors = []

def run_fixed(argv):
    # Run a FIXED argv list (no shell, no interpolation). Return (rc, stdout) or (None, "") when the
    # tool is absent. A missing binary (FileNotFoundError) or a non-zero exit is DATA, never a crash.
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

# (1) nvidia-smi -L => GPU presence + count (one line per GPU). FIXED argv.
list_rc, list_out = run_fixed(["nvidia-smi", "-L"])
listed_gpus = [line for line in list_out.splitlines() if line.strip().startswith("GPU ")]

# (2) per-GPU busy via the CSV query. FIXED argv. Parsed defensively: a malformed row is skipped, not
#     fatal. Fields: index, memory.used (MiB), memory.total (MiB), utilization.gpu (%).
GPU_BUSY_UTIL_PERCENT = ` + String(GPU_BUSY_UTIL_PERCENT) + String.raw`
GPU_BUSY_MEM_FRACTION = ` + String(GPU_BUSY_MEM_FRACTION) + String.raw`
query_rc, query_out = run_fixed([
    "nvidia-smi",
    "--query-gpu=index,memory.used,memory.total,utilization.gpu",
    "--format=csv,noheader,nounits",
])
gpus = []
for row in query_out.splitlines():
    row = row.strip()
    if not row:
        continue
    parts = [p.strip() for p in row.split(",")]
    if len(parts) < 4:
        continue
    try:
        index = int(parts[0])
        mem_used = int(parts[1])
        mem_total = int(parts[2])
        util = int(parts[3])
    except ValueError:
        continue
    gpus.append({"index": index, "mem_used": mem_used, "mem_total": mem_total, "util": util})

# gpu_count prefers the CSV rows; falls back to the -L count when only the list query succeeded.
gpu_count = len(gpus) if gpus else len(listed_gpus)

# (3) torch import + CUDA availability. An ImportError means torch is simply not on the node (a common,
#     non-fatal state) => torch_present:false, cuda_available:null. Any OTHER torch error degrades to
#     the same "could not verify" posture rather than crashing the probe.
torch_present = False
cuda_available = None
try:
    import torch  # noqa: PLC0415 - optional dependency, imported only inside the probe
    torch_present = True
    try:
        cuda_available = bool(torch.cuda.is_available())
    except Exception as exc:  # noqa: BLE001
        cuda_available = False
        errors.append("torch.cuda.is_available() raised: " + str(exc))
except ImportError:
    torch_present = False
    cuda_available = None
except Exception as exc:  # noqa: BLE001
    torch_present = False
    cuda_available = None
    errors.append("importing torch raised: " + str(exc))

# ok is the node-side OPTIMISTIC verdict: nvidia-smi listed at least one GPU AND CUDA is not provably
# unavailable. The brain re-derives its own findings from the raw fields (it does not trust ok alone).
ok = gpu_count > 0 and cuda_available is not False

print(json.dumps({
    "ok": ok,
    "gpu_count": gpu_count,
    "gpus": gpus,
    "torch_present": torch_present,
    "cuda_available": cuda_available,
    "errors": errors,
}))
sys.exit(0)
`;
