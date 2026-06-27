import base64
import hashlib
import json
import os
import sys

def fail(message, code=2):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)

if len(sys.argv) != 2:
    fail("expected exactly one artifact fetch spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid artifact fetch spec: {exc}")

raw_path = spec.get("path")
allowed_root = spec.get("allowed_root")
workdir = spec.get("workdir")
max_bytes = spec.get("max_bytes")
if not isinstance(raw_path, str) or not raw_path.startswith("/") or not isinstance(allowed_root, str) or not allowed_root.startswith("/") or not isinstance(workdir, str) or not workdir.startswith("/") or not isinstance(max_bytes, int):
    fail("invalid artifact fetch spec fields")

path = os.path.expandvars(raw_path)
allowed_root_real = os.path.realpath(os.path.expandvars(allowed_root))
workdir_real = os.path.realpath(os.path.expandvars(workdir))
path_real = os.path.realpath(path)

def inside_realpath(candidate, root):
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:
        return False

if not inside_realpath(allowed_root_real, workdir_real):
    fail("allowed root realpath escapes planned workdir")
if not inside_realpath(path_real, allowed_root_real) or not inside_realpath(path_real, workdir_real):
    fail("artifact realpath escapes declared output")
if not os.path.isfile(path_real):
    fail("artifact path is not a regular file", 3)
size = os.path.getsize(path_real)
if size > max_bytes:
    fail(f"artifact exceeds max_bytes: {size}", 4)

with open(path_real, "rb") as handle:
    content = handle.read()

print(json.dumps({
    "content_b64": base64.b64encode(content).decode("ascii"),
    "size_bytes": size,
    "sha256": hashlib.sha256(content).hexdigest(),
}, sort_keys=True))
