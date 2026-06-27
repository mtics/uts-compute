import base64
import json
import os
import signal
import sys

def fail(message):
    print(json.dumps({"error": message}), file=sys.stderr)
    raise SystemExit(2)

if len(sys.argv) != 2:
    fail("expected exactly one cancel spec argument")

try:
    encoded = sys.argv[1]
    padded = encoded + ("=" * ((4 - len(encoded) % 4) % 4))
    spec = json.loads(base64.urlsafe_b64decode(padded.encode("ascii")).decode("utf-8"))
except Exception as exc:
    fail(f"invalid cancel spec: {exc}")

pid = spec.get("pid")
if not isinstance(pid, int) or pid <= 1:
    fail("invalid pid")

try:
    os.killpg(pid, signal.SIGTERM)
    result = "cancelled"
except ProcessLookupError:
    result = "already_stopped"
except PermissionError as exc:
    fail(f"permission denied: {exc}")

print(json.dumps({"result": result}, sort_keys=True))
