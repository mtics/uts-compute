import base64
import hashlib
import json
import os
import sys

def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) != 2:
    fail("expected exactly one transfer preflight spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid transfer preflight spec: {exc}")

root = spec.get("root")
files = spec.get("files")
max_total_bytes = spec.get("max_total_bytes")
checksum_max_bytes = spec.get("checksum_max_bytes")
if not isinstance(root, str) or not root.startswith("/") or not isinstance(files, list) or not isinstance(max_total_bytes, int) or not isinstance(checksum_max_bytes, int):
    fail("invalid transfer preflight spec fields")

root_expanded = os.path.expandvars(root)
root_real = os.path.realpath(root_expanded)
if not os.path.isdir(root_real):
    fail("transfer root is not a directory")

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

results = []
total = 0
for rel in files:
    if not isinstance(rel, str) or rel.startswith("/") or ".." in rel.split("/"):
        fail("invalid transfer file entry")
    full = os.path.join(root_expanded, rel)
    real = os.path.realpath(full)
    if not inside_realpath(real, root_real):
        fail("transfer file realpath escapes root")
    if not os.path.isfile(real):
        fail(f"transfer file is not regular: {rel}")
    size = os.path.getsize(real)
    total += size
    if total > max_total_bytes:
        fail("transfer files exceed max_total_bytes")
    entry = {
        "path": rel,
        "size_bytes": size,
        "checksum_status": "skipped-large" if size > checksum_max_bytes else "captured",
    }
    if size <= checksum_max_bytes:
        entry["sha256"] = sha256_file(real)
    results.append(entry)

print(json.dumps({"files": results, "total_size_bytes": total}, sort_keys=True))
