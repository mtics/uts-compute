import base64
import json
import os
import sys

def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) != 2:
    fail("expected exactly one logs spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid logs spec: {exc}")

max_bytes = spec.get("max_bytes")
streams = spec.get("streams")
if not isinstance(max_bytes, int) or max_bytes < 1:
    fail("invalid max_bytes")
if not isinstance(streams, list):
    fail("invalid streams")

results = []
for entry in streams:
    if not isinstance(entry, dict):
        fail("invalid stream entry")
    name = entry.get("stream")
    raw_path = entry.get("path")
    if name not in ("stdout", "stderr") or not isinstance(raw_path, str) or not raw_path.startswith("/"):
        fail("invalid stream path")
    path = os.path.expandvars(raw_path)
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as handle:
            if size > max_bytes:
                handle.seek(-max_bytes, os.SEEK_END)
            data = handle.read(max_bytes + 1)
        truncated = size > max_bytes or len(data) > max_bytes
        if len(data) > max_bytes:
            data = data[-max_bytes:]
        content = data.decode("utf-8", errors="replace")
        results.append({
            "stream": name,
            "status": "passed",
            "content": content,
            "truncated": truncated,
            "summary": f"{name} log tail completed",
        })
    except FileNotFoundError:
        results.append({
            "stream": name,
            "status": "failed",
            "content": "",
            "truncated": False,
            "summary": f"{name} log path was not found",
        })
    except Exception as exc:
        results.append({
            "stream": name,
            "status": "failed",
            "content": "",
            "truncated": False,
            "summary": f"{name} log tail failed: {exc}",
        })

print(json.dumps({"streams": results}, sort_keys=True))
