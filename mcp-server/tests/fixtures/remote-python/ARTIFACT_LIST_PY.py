import base64
import hashlib
import json
import os
import sys

def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) != 2:
    fail("expected exactly one artifact list spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid artifact list spec: {exc}")

outputs = spec.get("outputs")
workdir = spec.get("workdir")
max_entries = spec.get("max_entries")
checksum_max_bytes = spec.get("checksum_max_bytes")
if not isinstance(outputs, list) or not isinstance(workdir, str) or not isinstance(max_entries, int) or not isinstance(checksum_max_bytes, int):
    fail("invalid artifact list spec fields")

artifacts = []
truncated = False
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

def append_entry(entry):
    global truncated
    if len(artifacts) >= max_entries:
        truncated = True
        return False
    artifacts.append(entry)
    return True

for output in outputs:
    if not isinstance(output, dict):
        fail("invalid output entry")
    raw_path = output.get("path")
    if not isinstance(raw_path, str) or not raw_path.startswith("/"):
        fail("invalid output path")
    root = os.path.expandvars(raw_path)
    root_real = os.path.realpath(root)
    if os.path.exists(root) and not inside_realpath(root_real, workdir_real):
        fail("output realpath escapes planned workdir")
    source_output = raw_path
    if not os.path.exists(root):
        append_entry({
            "path": raw_path,
            "relative_path": "",
            "kind": "missing",
            "checksum_status": "missing",
            "source_output": source_output,
        })
        continue
    if os.path.isfile(root):
        if not inside_realpath(root_real, workdir_real):
            fail("file output realpath escapes planned workdir")
        size = os.path.getsize(root)
        entry = {
            "path": raw_path,
            "relative_path": os.path.basename(root),
            "kind": "file",
            "size_bytes": size,
            "checksum_status": "skipped-large" if size > checksum_max_bytes else "captured",
            "source_output": source_output,
        }
        if size <= checksum_max_bytes:
            entry["sha256"] = sha256_file(root)
        append_entry(entry)
        continue
    if not os.path.isdir(root):
        append_entry({
            "path": raw_path,
            "relative_path": "",
            "kind": "other",
            "checksum_status": "not-file",
            "source_output": source_output,
        })
        continue
    append_entry({
        "path": raw_path,
        "relative_path": "",
        "kind": "directory",
        "checksum_status": "not-file",
        "source_output": source_output,
    })
    for current, dirnames, filenames in os.walk(root):
        dirnames.sort()
        filenames.sort()
        for filename in filenames:
            full = os.path.join(current, filename)
            full_real = os.path.realpath(full)
            if not inside_realpath(full_real, root_real) or not inside_realpath(full_real, workdir_real):
                fail("artifact realpath escapes declared output")
            rel = os.path.relpath(full, root)
            size = os.path.getsize(full)
            entry = {
                "path": raw_path.rstrip("/") + "/" + rel,
                "relative_path": rel,
                "kind": "file",
                "size_bytes": size,
                "checksum_status": "skipped-large" if size > checksum_max_bytes else "captured",
                "source_output": source_output,
            }
            if size <= checksum_max_bytes:
                entry["sha256"] = sha256_file(full)
            if not append_entry(entry):
                break
        if truncated:
            break
    if truncated:
        break

print(json.dumps({"artifacts": artifacts, "truncated": truncated}, sort_keys=True))
