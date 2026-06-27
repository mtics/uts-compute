import base64
import json
import os
import subprocess
import sys
import time

def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) != 2:
    fail("expected exactly one supervisor spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid supervisor spec: {exc}")

def expand_path(value):
    if not isinstance(value, str) or not value.startswith("/"):
        fail("all paths must be absolute strings")
    return os.path.expandvars(value)

allowed_roots = [os.path.realpath(expand_path(root)) for root in spec.get("allowed_roots", [])]
if not allowed_roots:
    fail("no allowed roots provided")

def checked_path(key):
    real = os.path.realpath(expand_path(spec[key]))
    if not any(real == root or real.startswith(root + os.sep) for root in allowed_roots):
        fail(f"{key} is outside allowed roots")
    return expand_path(spec[key])

run_id = spec.get("run_id")
command_argv = spec.get("command_argv")
if not isinstance(run_id, str) or not run_id:
    fail("missing run_id")
if not isinstance(command_argv, list) or not command_argv or not all(isinstance(item, str) and item for item in command_argv):
    fail("command_argv must be a non-empty string list")

workdir = checked_path("workdir")
log_dir = checked_path("log_dir")
stdout_path = checked_path("stdout_path")
stderr_path = checked_path("stderr_path")
pid_path = checked_path("pid_path")
metadata_path = checked_path("metadata_path")

os.makedirs(workdir, exist_ok=True)
os.makedirs(log_dir, exist_ok=True)

stdout_file = open(stdout_path, "ab", buffering=0)
stderr_file = open(stderr_path, "ab", buffering=0)
try:
    process = subprocess.Popen(
        command_argv,
        cwd=workdir,
        stdin=subprocess.DEVNULL,
        stdout=stdout_file,
        stderr=stderr_file,
        close_fds=True,
        start_new_session=True,
    )
except Exception as exc:
    fail(f"failed to start command: {exc}")

started_at = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
metadata = {
    "run_id": run_id,
    "pid": process.pid,
    "started_at": started_at,
    "metadata_path": metadata_path,
    "stdout_path": stdout_path,
    "stderr_path": stderr_path,
}

with open(pid_path, "w", encoding="utf-8") as handle:
    handle.write(str(process.pid) + "\n")
with open(metadata_path, "w", encoding="utf-8") as handle:
    json.dump(metadata, handle, sort_keys=True)
    handle.write("\n")

print(json.dumps(metadata, sort_keys=True))
