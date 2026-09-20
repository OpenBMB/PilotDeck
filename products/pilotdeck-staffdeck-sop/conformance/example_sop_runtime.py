#!/usr/bin/env python3
"""Small independent sop.lifecycle/v2 implementation used by conformance tests.

This service intentionally has no StaffDeck imports. It exercises the published
wire contract, one valid domain operation, and one business rejection path.
"""

from __future__ import annotations

import argparse
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import Any


IMPLEMENTATION_ID = "example.approval"
CONTRACT = "sop.lifecycle/v2"
PROTOCOL_VERSION = "2.0"
TRANSPORT = "sop-http-v2"


def error(request_id: str, code: str, message: str, status: int) -> tuple[int, dict[str, Any]]:
    return status, {
        "protocolVersion": PROTOCOL_VERSION,
        "requestId": request_id,
        "ok": False,
        "outcome": "failed",
        "error": {
            "code": code,
            "message": message,
            "retryability": "unsafe",
            "details": {},
        },
    }


def step_for(bundle: dict[str, Any], state: dict[str, Any]) -> tuple[dict[str, Any], dict[str, Any]]:
    definitions = bundle.get("sops")
    selected_id = state.get("selected_skill_id")
    if not isinstance(definitions, list) or not definitions:
        raise ValueError("bundle.sops must contain at least one SOP")
    definition = next((item for item in definitions if isinstance(item, dict) and item.get("id") == selected_id), None)
    if definition is None:
        definition = definitions[0]
        selected_id = definition.get("id")
    content = definition.get("content") if isinstance(definition, dict) else None
    nodes = content.get("nodes") if isinstance(content, dict) else None
    if not isinstance(nodes, list) or not nodes or not isinstance(nodes[0], dict):
        raise ValueError("selected SOP must define a node")
    node = nodes[0]
    node_id = node.get("node_id")
    if not isinstance(selected_id, str) or not isinstance(node_id, str):
        raise ValueError("selected SOP id and node_id must be strings")
    next_state = {
        **state,
        "selected_skill_id": selected_id,
        "active_skill_id": selected_id,
        "active_step_id": node_id,
        "status": "awaiting_user",
    }
    step = {
        "skillId": selected_id,
        "skillName": str(definition.get("name", selected_id)),
        "version": str(definition.get("version", "1")),
        "nodeId": node_id,
        "node": node,
        "instruction": str(node.get("instruction", "")),
        "expectedUserInfo": list(node.get("expected_user_info", [])),
        "knownSlots": {},
        "allowedNextStepIds": [],
        "requiredToolNames": [],
        "allowedActions": list(node.get("allowed_actions", [])),
        "isTerminal": bool(node.get("type") == "terminal" or node.get("is_terminal", False)),
        "declaresHandoff": bool(node.get("type") == "handoff"),
        "subSopId": None,
    }
    return next_state, step


class Handler(BaseHTTPRequestHandler):
    server_version = "example-sop/0.1"

    def log_message(self, _format: str, *_args: Any) -> None:
        return

    def do_GET(self) -> None:  # noqa: N802
        if self.path not in {"/module-manifest", "/healthz"}:
            self._send(404, {"error": "not found"})
            return
        self._send(200, {
            "status": "ok",
            "protocolVersion": PROTOCOL_VERSION,
            "moduleId": "sop.runtime",
            "contract": CONTRACT,
            "operations": ["prepare", "submit"],
            "descriptorVersion": "1.0",
            "implementationId": IMPLEMENTATION_ID,
            "implementationVersion": "0.1.0",
            "transport": TRANSPORT,
            "capabilities": ["handoff"],
            "state": {"ownership": "host", "schema": CONTRACT, "scope": "session"},
            "requires": {"hostCapabilities": ["sop.host-resume/v1"]},
        })

    def do_POST(self) -> None:  # noqa: N802
        if self.path not in {"/v1/sop/prepare", "/v1/sop/submit"}:
            self._send(404, {"error": "not found"})
            return
        try:
            body = json.loads(self.rfile.read(int(self.headers.get("content-length", "0"))))
        except (ValueError, json.JSONDecodeError):
            self._send(*error("unknown", "SOP_RUNTIME_PROTOCOL", "invalid JSON", 400))
            return
        request_id = body.get("requestId") if isinstance(body, dict) else "unknown"
        if not isinstance(request_id, str) or body.get("protocolVersion") != PROTOCOL_VERSION:
            self._send(*error(str(request_id), "SOP_RUNTIME_PROTOCOL", "invalid protocol envelope", 400))
            return
        payload = body.get("payload")
        if not isinstance(payload, dict):
            self._send(*error(request_id, "SOP_RUNTIME_PROTOCOL", "payload must be an object", 400))
            return
        try:
            if self.path.endswith("/prepare"):
                state, step = step_for(payload["bundle"], payload["state"])
                self._send(200, {"protocolVersion": PROTOCOL_VERSION, "requestId": request_id, "ok": True,
                                 "outcome": "completed", "payload": {"state": state, "step": step}})
                return
            proposal = payload.get("proposal")
            if not isinstance(proposal, dict) or proposal.get("status") != "completed":
                self._send(*error(request_id, "EXAMPLE_SOP_REJECTED", "only completed proposals are accepted", 422))
                return
            state = payload["state"]
            if not isinstance(state, dict):
                raise ValueError("state must be an object")
            next_state = {**state, "status": "completed"}
            result = {
                "status": "completed",
                "replyFragment": str(proposal.get("replyFragment", "Completed.")),
                "slotUpdates": proposal.get("slotUpdates", {}),
                "taskSummary": proposal.get("taskSummary"),
                "structuredResult": proposal.get("structuredResult"),
                "nextStepId": None,
                "events": [],
            }
            self._send(200, {"protocolVersion": PROTOCOL_VERSION, "requestId": request_id, "ok": True,
                             "outcome": "completed", "payload": {"state": next_state, "result": result}})
        except (KeyError, TypeError, ValueError) as exc:
            self._send(*error(request_id, "SOP_RUNTIME_PROTOCOL", str(exc), 400))

    def _send(self, status: int, body: dict[str, Any]) -> None:
        raw = json.dumps(body).encode("utf-8")
        self.send_response(status)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(raw)))
        self.end_headers()
        self.wfile.write(raw)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--port", type=int, required=True)
    args = parser.parse_args()
    ThreadingHTTPServer(("127.0.0.1", args.port), Handler).serve_forever()


if __name__ == "__main__":
    main()
