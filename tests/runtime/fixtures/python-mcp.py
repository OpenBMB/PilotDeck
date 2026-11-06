"""Synthetic stdio server that exposes its actual interpreter; no network or user data."""
import json
import sys

for line in sys.stdin:
    message = json.loads(line)
    if "id" not in message:
        continue
    method = message["method"]
    if method == "initialize":
        result = {"protocolVersion": message["params"]["protocolVersion"],
                  "capabilities": {"tools": {}}, "serverInfo": {"name": "python-fixture", "version": "1"}}
    elif method == "tools/list":
        result = {"tools": [{"name": "identity", "description": "Return the test interpreter",
                            "inputSchema": {"type": "object"}, "annotations": {"readOnlyHint": True}}]}
    elif method == "tools/call":
        result = {"content": [{"type": "text", "text": json.dumps({"executable": sys.executable, "prefix": sys.prefix})}]}
    else:
        result = {}
    print(json.dumps({"jsonrpc": "2.0", "id": message["id"], "result": result}), flush=True)
