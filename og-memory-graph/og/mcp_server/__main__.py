from __future__ import annotations

import json
import sys
from typing import Any, Optional

from .tools import TOOL_DEFS
from .watcher import manager as watcher_manager

SERVER_NAME = "og-research"
SERVER_VERSION = "0.1.0"
PROTOCOL_VERSION = "2024-11-05"




_tools_by_name: dict[str, dict] = {td["name"]: td for td in TOOL_DEFS}

_tool_schemas = [
    {
        "name": td["name"],
        "description": td["description"],
        "inputSchema": td["inputSchema"],
    }
    for td in TOOL_DEFS
]




def _ok(req_id: Any, result: Any) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "result": result}


def _err(req_id: Any, code: int, msg: str) -> dict:
    return {"jsonrpc": "2.0", "id": req_id, "error": {"code": code, "message": msg}}


def _handle(request: dict) -> Optional[dict]:
    req_id = request.get("id")
    method = request.get("method", "")
    params = request.get("params") or {}

    if method == "initialize":
        return _ok(req_id, {
            "protocolVersion": PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": SERVER_NAME, "version": SERVER_VERSION},
        })

    if method == "notifications/initialized":
        return None

    if method == "ping":
        return _ok(req_id, {})

    if method == "tools/list":
        return _ok(req_id, {"tools": _tool_schemas})

    if method == "tools/call":
        tool_name = params.get("name", "")
        args = params.get("arguments") or {}
        td = _tools_by_name.get(tool_name)
        if td is None:
            return _err(req_id, -32601, f"Unknown tool: {tool_name!r}")
        try:
            result = td["handler"](**args)
        except TypeError as e:
            return _err(req_id, -32602, f"Invalid arguments for {tool_name!r}: {e}")
        except Exception as e:
            return _err(req_id, -32603, f"Tool execution error: {e}")

        text = result if isinstance(result, str) else json.dumps(result, ensure_ascii=False, indent=2)
        return _ok(req_id, {"content": [{"type": "text", "text": text}]})


    if req_id is not None:
        return _err(req_id, -32601, f"Method not found: {method!r}")
    return None




def serve() -> None:

    watcher_manager.start()

    _log("[og-mcp] server ready, waiting for messages...")

    for raw_line in sys.stdin:
        raw_line = raw_line.strip()
        if not raw_line:
            continue
        try:
            request = json.loads(raw_line)
        except json.JSONDecodeError as e:
            _write(_err(None, -32700, f"Parse error: {e}"))
            continue

        try:
            response = _handle(request)
        except Exception as e:
            _write(_err(request.get("id"), -32603, f"Internal error: {e}"))
            continue

        if response is not None:
            _write(response)

    watcher_manager.stop()


def _write(msg: dict) -> None:
    sys.stdout.write(json.dumps(msg, ensure_ascii=False) + "\n")
    sys.stdout.flush()


def _log(msg: str) -> None:
    print(msg, file=sys.stderr, flush=True)


if __name__ == "__main__":
    serve()
