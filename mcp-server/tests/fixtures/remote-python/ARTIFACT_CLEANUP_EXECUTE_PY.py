import base64
import hashlib
import json
import os
import sys

def fail(message, code=2):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(code)

if len(sys.argv) != 2:
    fail("expected exactly one artifact cleanup spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid artifact cleanup spec: {exc}")

workdir = spec.get("workdir")
targets = spec.get("targets")
max_entries = spec.get("max_entries")
max_total_bytes = spec.get("max_total_bytes")
if not isinstance(workdir, str) or not workdir.startswith("/") or not isinstance(targets, list) or not isinstance(max_entries, int) or not isinstance(max_total_bytes, int):
    fail("invalid artifact cleanup spec fields")
if len(targets) > max_entries:
    fail("artifact cleanup target count exceeds max_entries")

workdir_real = os.path.realpath(os.path.expandvars(workdir))

def inside_realpath(candidate, root):
    try:
        return os.path.commonpath([candidate, root]) == root
    except ValueError:
        return False

def sha256_file(path):
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()

prepared = []
total_deleted_bytes = 0
for target in targets:
    if not isinstance(target, dict):
        fail("invalid artifact cleanup target")
    raw_path = target.get("path")
    allowed_root = target.get("allowed_root")
    size_bytes = target.get("size_bytes")
    sha256 = target.get("sha256")
    if not isinstance(raw_path, str) or not raw_path.startswith("/") or not isinstance(allowed_root, str) or not allowed_root.startswith("/") or not isinstance(size_bytes, int) or not isinstance(sha256, str):
        fail("invalid artifact cleanup target fields")
    path = os.path.expandvars(raw_path)
    allowed_root_real = os.path.realpath(os.path.expandvars(allowed_root))
    if not inside_realpath(allowed_root_real, workdir_real):
        fail("allowed cleanup root realpath escapes planned workdir")
    if not os.path.exists(path):
        fail("artifact cleanup target is missing")
    if os.path.islink(path):
        fail("artifact cleanup target must not be a symbolic link")
    path_real = os.path.realpath(path)
    if not inside_realpath(path_real, allowed_root_real) or not inside_realpath(path_real, workdir_real):
        fail("artifact cleanup target realpath escapes declared output")
    if not os.path.isfile(path_real):
        fail("artifact cleanup target is not a regular file")
    observed_size = os.path.getsize(path_real)
    if observed_size != size_bytes:
        fail("artifact cleanup target size does not match manifest")
    observed_sha256 = sha256_file(path_real)
    if observed_sha256 != sha256:
        fail("artifact cleanup target checksum does not match manifest")
    total_deleted_bytes += observed_size
    if total_deleted_bytes > max_total_bytes:
        fail("artifact cleanup target bytes exceed max_total_bytes")
    prepared.append((raw_path, path_real))

deleted_files = []
for raw_path, path_real in prepared:
    os.unlink(path_real)
    deleted_files.append(raw_path)

print(json.dumps({
    "deleted_files": deleted_files,
    "missing": [],
    "total_deleted_bytes": total_deleted_bytes,
}, sort_keys=True))
