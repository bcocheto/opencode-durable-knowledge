#!/usr/bin/env python3
import json
import subprocess
import sys
import time


mode = sys.argv[1]
payload = json.load(sys.stdin)

if mode == "echo":
    print(json.dumps({"payload": payload, "args": sys.argv[2:]}))
elif mode == "list":
    print("[]")
elif mode == "malformed":
    print("not-json")
elif mode == "fail":
    print("RAW_STDERR_MARKER", file=sys.stderr)
    print("{}")
    raise SystemExit(7)
elif mode == "sleep":
    time.sleep(5)
    print("{}")
elif mode == "large":
    print(json.dumps({"data": "x" * (300 * 1024)}))
elif mode == "fork":
    subprocess.Popen([sys.executable, "-c", "import time; time.sleep(5)"])
    time.sleep(5)
    print("{}")
else:
    raise SystemExit(9)
