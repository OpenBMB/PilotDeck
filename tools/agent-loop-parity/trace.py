"""Canonical trace normalization and semantic comparison for parity runs."""
from __future__ import annotations

import json
import re
from dataclasses import dataclass
from pathlib import Path
from typing import Any

_VOLATILE_KEYS = {
    "timestamp", "startedAt", "completedAt", "createdAt", "updatedAt",
    "durationMs", "mtimeMs",
    "messageId", "requestId", "streamId", "runId", "operationId", "idempotencyKey",
    "connectionGeneration", "moduleInstanceId", "processId", "pid",
}
_NULL_OPTIONAL_KEYS = {"code", "structuredResult"}
_VOLATILE_ID = re.compile(r"^(?:[a-z_-]+-)?(?:[0-9a-f]{8,}|[0-9]{6,})$")
_UUID_LIKE_ID = re.compile(
    r"^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$",
    re.IGNORECASE,
)
_TIMELINE_BLOCK_REFERENCE = re.compile(
    r"^(?P<id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})(?P<suffix>:.+)$",
    re.IGNORECASE,
)
_SUBAGENT_SESSION_REFERENCE = re.compile(
    r"^.+::sub::(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})$",
    re.IGNORECASE,
)
_SUBAGENT_TRANSCRIPT_REFERENCE = re.compile(
    r"^(?:.+/)?subagents/(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\.jsonl$",
    re.IGNORECASE,
)
_GENERATED_REFERENCE_KINDS = {
    "subagentId": "subagent-id",
    "subagent_id": "subagent-id",
    "compactionId": "compaction-id",
    "itemId": "item-id",
    "turnId": "turn-id",
}
_ACCEPTED_SUBAGENT_NOTICE = re.compile(
    r"\baccepted message "
    r"(?P<message_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) "
    r"for subagent "
    r"(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\b",
    re.IGNORECASE,
)
_SETTLED_SUBAGENT_NOTICE = re.compile(
    r"\bContinuable subagent "
    r"(?P<subagent_id>[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}) "
    r"settled: (?P<status>[a-z_]+)\.",
    re.IGNORECASE,
)
_TOOL_LIFECYCLE_PHASE = {
    "tool.call": 0,
    "tool.start": 1,
    "tool.finish": 2,
    "tool.result": 3,
}
_HARNESS_PROOF_KINDS = {"harness.proof", "operation.terminal"}
_REQUIRED_DURABLE_STATUS_EVENTS = {"turn_timeout", "max_budget_reached", "context_budget"}


def _generated_id_placeholder(
    value: str,
    kind: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    key = (kind, value)
    placeholder = generated_ids.get(key)
    if placeholder is not None:
        return placeholder
    index = 1 + sum(existing_kind == kind for existing_kind, _ in generated_ids)
    placeholder = f"<{kind}-{index}>"
    generated_ids[key] = placeholder
    return placeholder


def _canonicalize_subagent_notice(
    value: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    def replace(match: re.Match[str]) -> str:
        message_id = _generated_id_placeholder(
            match.group("message_id"), "message-id", generated_ids,
        )
        subagent_id = _generated_id_placeholder(
            match.group("subagent_id"), "subagent-id", generated_ids,
        )
        return f"accepted message {message_id} for subagent {subagent_id}"

    value = _ACCEPTED_SUBAGENT_NOTICE.sub(replace, value)

    def replace_settled(match: re.Match[str]) -> str:
        subagent_id = _generated_id_placeholder(
            match.group("subagent_id"), "subagent-id", generated_ids,
        )
        return f"Continuable subagent {subagent_id} settled: {match.group('status')}."

    return _SETTLED_SUBAGENT_NOTICE.sub(replace_settled, value)


def _canonicalize_arguments(
    value: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    try:
        parsed = json.loads(value)
    except (TypeError, ValueError):
        return value
    normalized = canonicalize(parsed, generated_ids=generated_ids)
    if normalized == parsed:
        return value
    return json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))


def _canonicalize_subagent_reference(
    value: str,
    key: str | None,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    if key == "subagentSessionId":
        match = _SUBAGENT_SESSION_REFERENCE.match(value)
        if match:
            subagent_id = _generated_id_placeholder(
                match.group("subagent_id"), "subagent-id", generated_ids,
            )
            return f"<subagent-session:{subagent_id}>"
    if key == "transcriptRelativePath":
        match = _SUBAGENT_TRANSCRIPT_REFERENCE.match(value)
        if match:
            subagent_id = _generated_id_placeholder(
                match.group("subagent_id"), "subagent-id", generated_ids,
            )
            return f"<subagent-transcript:{subagent_id}>"
    return value


def _canonicalize_duration_json_text(
    value: str,
    generated_ids: dict[tuple[str, str], str],
) -> str:
    """Drop framework timing from a complete JSON value or final JSON line only.

    One-shot subagent reports are presented to the parent model as a human
    summary followed by JSON. The duration is process scheduling noise, but
    the rest of that JSON remains model-visible and semantic. Do not parse or
    rewrite arbitrary prose: only a complete JSON value or the final line is
    eligible.
    """
    if not any(marker in value for marker in ('"durationMs"', '"subagentSessionId"', '"transcriptRelativePath"')):
        return value
    candidates = [(0, value)]
    final_line_start = value.rfind("\n{")
    if final_line_start >= 0:
        candidates.append((final_line_start + 1, value[final_line_start + 1:]))
    for start, candidate in candidates:
        try:
            parsed = json.loads(candidate)
        except (TypeError, ValueError):
            continue
        if not isinstance(parsed, (dict, list)):
            continue
        normalized = canonicalize(parsed, generated_ids=generated_ids)
        if normalized == parsed:
            return value
        encoded = json.dumps(normalized, ensure_ascii=False, sort_keys=True, separators=(",", ":"))
        return value[:start] + encoded
    return value


def canonicalize(
    value: Any,
    *,
    key: str | None = None,
    generated_ids: dict[tuple[str, str], str] | None = None,
) -> Any:
    generated_ids = {} if generated_ids is None else generated_ids
    if isinstance(value, dict):
        derived_image_bytes = value.get("type") == "image" and value.get("source") == "base64"
        return {
            k: canonicalize(v, key=k, generated_ids=generated_ids)
            for k, v in sorted(value.items())
            if k not in _VOLATILE_KEYS
            and not (k in _NULL_OPTIONAL_KEYS and v is None)
            and not (derived_image_bytes and k == "bytes")
        }
    if isinstance(value, list):
        return [canonicalize(item, key=key, generated_ids=generated_ids) for item in value]
    if isinstance(value, str) and key in _GENERATED_REFERENCE_KINDS and _UUID_LIKE_ID.match(value):
        return _generated_id_placeholder(value, _GENERATED_REFERENCE_KINDS[key], generated_ids)
    if isinstance(value, str) and key in {"id", "blockId", "previousId"}:
        match = _TIMELINE_BLOCK_REFERENCE.match(value)
        if match:
            block_id = _generated_id_placeholder(match.group("id"), "timeline-block-id", generated_ids)
            return f"{block_id}{match.group('suffix')}"
    if isinstance(value, str) and key == "arguments":
        return _canonicalize_arguments(value, generated_ids)
    if isinstance(value, str):
        value = _canonicalize_subagent_reference(value, key, generated_ids)
        value = _canonicalize_subagent_notice(value, generated_ids)
        value = _canonicalize_duration_json_text(value, generated_ids)
    if isinstance(value, str) and key == "handoff_id" and value:
        return "<generated-id>"
    if isinstance(value, str) and key in {"id", "callId", "toolCallId"} and _VOLATILE_ID.match(value):
        return "<generated-id>"
    return value


def load_trace(path: Path) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    generated_ids: dict[tuple[str, str], str] = {}
    for line_no, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        if not raw.strip():
            continue
        value = json.loads(raw)
        if not isinstance(value, dict):
            raise TypeError(f"{path}:{line_no}: trace record must be an object")
        required = {"kind", "scenarioId", "q", "sequence"}
        missing = sorted(required - value.keys())
        if missing:
            raise ValueError(f"{path}:{line_no}: trace record missing {', '.join(missing)}")
        records.append(canonicalize(value, generated_ids=generated_ids))
    return records


def validate_production_sidecar_proof(
    records: list[dict[str, Any]],
    required_modules: set[str] | None = None,
    required_operations: set[str] | None = None,
) -> list[str]:
    proofs = [record for record in records if record.get("kind") == "harness.proof"]
    states = {str(record.get("state")) for record in proofs}
    errors: list[str] = []
    if not any(record.get("state") == "transport_selected" and record.get("transport") == "stdio" for record in proofs):
        errors.append("production stdio transport selection proof is missing")
    if "handshake_completed" not in states:
        errors.append("production sidecar handshake proof is missing")
    observed_modules = {
        str(record.get("module"))
        for record in proofs
        if record.get("state") == "module_call_received"
    }
    missing_modules = sorted((required_modules or set()) - observed_modules)
    if missing_modules:
        errors.append(f"production sidecar module proof is missing: {', '.join(missing_modules)}")
    observed_operations = {
        f"{record.get('module')}:{record.get('operation')}"
        for record in proofs
        if record.get("state") == "module_call_received" and isinstance(record.get("operation"), str)
    }
    missing_operations = sorted((required_operations or set()) - observed_operations)
    if missing_operations:
        errors.append(f"production sidecar operation proof is missing: {', '.join(missing_operations)}")
    return errors


@dataclass(frozen=True)
class Difference:
    path: str
    left: Any
    right: Any


# Fields which are observable by a downstream model, tool, user, or StaffDeck
# state machine.  Everything else belongs to a transport/persistence envelope.
_SEMANTIC_EVENT_FIELDS = {
    "model.request": {"modelView", "messages", "systemPrompt", "tools", "metadata", "attempt"},
    "model.response": {"modelView", "message", "content", "tool_calls", "stopReason", "usage", "errors", "structuredResult", "attempt"},
    "model.error": {"code", "message", "retryable", "attempt"},
    "model.stream": {"state"},
    "tool.call": {"name", "toolName", "arguments", "toolCallId", "context", "order", "sideEffectCount", "attempt", "concurrencySafe"},
    "tool.start": {"name", "toolName", "toolCallId", "order", "attempt", "concurrencySafe"},
    "tool.finish": {"name", "toolName", "toolCallId", "order", "success", "error", "sideEffectCount", "attempt", "concurrencySafe"},
    "tool.result": {"result", "data", "error", "toolName", "toolCallId", "success", "sideEffectCount", "attempt", "concurrencySafe"},
    "tool.progress": {"toolCallId", "toolName", "message", "metadata"},
    "policy.turn": {"permissionMode", "runMode"},
    "policy.context": {"toolName", "permissionMode", "runMode"},
    "permission.request": {"toolName", "toolCallId", "mode", "canPrompt"},
    "permission.answer": {"toolName", "toolCallId", "allowed", "code"},
    "permission.decision": {"toolName", "toolCallId", "allowed", "code", "retryable"},
    "steer.request": {"itemId", "accepted"},
    "steer.applied": {"itemId", "message"},
    "agent.status": {"event", "detail"},
    "durable.status": {"event", "statusKind", "text"},
    "durable.steer": {"itemId", "message"},
    "durable.compaction_completed": {"operationId", "status"},
    "context.budget": {
        "used", "displayUsed", "budgetUsed", "total", "effectiveTotal",
        "reservedOutputTokens", "ratio", "state", "source", "exact", "breakdown",
    },
    "durable.state": {
        "durableStatusCount", "durableSteerCount", "compactionBoundaryCount",
        "compactionCompletedCount", "replayedStatusCount",
    },
    "sidecar.lifecycle": {
        "state", "stage", "code", "attempt", "parentClosed", "parentAborted",
        "subagentModelRequests", "terminalCount",
    },
    "session.lifecycle": {"state", "reason"},
    "fault.injected": {"target", "action", "stage", "attempt"},
    "side_effect.state": {"counts", "sideEffectCount"},
    "compact.boundary": {"compactionId", "reason", "messages", "metadata"},
    "compaction.budget": {"phase", "tokens", "systemTokens", "toolTokens", "messageTokens"},
    "seed.state": {"applied", "fileContent"},
    "checkpoint": {"status", "seedState", "messages", "activeStepId", "taskFrameId", "slots", "knowledgeBudget", "recoveryPoint", "sideEffectCount"},
    "taskframe": {"taskFrame", "status", "stepId", "nextStepId", "slots", "requiredCapabilities", "knowledgeBudget", "priorTaskResults"},
    "session.state": {"activeSkillId", "activeStepId", "pendingTasks", "awaitingInput", "handoff", "slots", "priorTaskResults"},
    "terminal": {
        "outcome", "code", "stopReason", "resultType", "durableStopReason", "durableErrorCode",
        "structuredResult", "output", "usage", "frameStatus", "runStatus", "taskFrame", "session",
    },
    "user.output": {"text"},
}


def _semantic_record(
    record: dict[str, Any],
    generated_ids: dict[tuple[str, str], str],
) -> dict[str, Any]:
    kind = str(record.get("kind") or "")
    fields = _SEMANTIC_EVENT_FIELDS.get(kind)
    if fields is None:
        # Unknown event kinds are still meaningful if they carry explicit state
        # projection fields; otherwise they are envelope-only.
        fields = set().union(*_SEMANTIC_EVENT_FIELDS.values())
    projected: dict[str, Any] = {"kind": kind}
    if "agentScope" in record:
        projected["agentScope"] = record["agentScope"]
    for key in fields:
        if key in record:
            projected[key] = record[key]
    # The logical ordering of calls/results is semantic, while the JSONL
    # sequence and transport source are not.
    for key in ("logicalSequence", "phase"):
        if key in record:
            projected[key] = record[key]
    return canonicalize(projected, generated_ids=generated_ids)


def _tool_lifecycle_name(record: dict[str, Any]) -> str | None:
    for key in ("name", "toolName"):
        value = record.get(key)
        if isinstance(value, str):
            return value
    result = record.get("result")
    if isinstance(result, dict) and isinstance(result.get("toolName"), str):
        return result["toolName"]
    return None


def _tool_lifecycle_identity(record: dict[str, Any]) -> str | None:
    value = record.get("toolCallId")
    if isinstance(value, str) and value:
        return value
    result = record.get("result")
    if isinstance(result, dict):
        value = result.get("toolCallId")
        if isinstance(value, str) and value:
            return value
    return None


def _canonicalize_parallel_tool_lifecycle(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Canonicalize only explicitly concurrency-safe tool lifecycle interleavings.

    The scheduler promises stable result order, but concurrent tool start/finish
    observations have no total order. We preserve strict ordering for every
    other event, including non-concurrent and repeated tool calls.
    """
    result = list(records)
    index = 0
    while index < len(result):
        if result[index].get("kind") not in _TOOL_LIFECYCLE_PHASE:
            index += 1
            continue
        end = index
        while end < len(result) and result[end].get("kind") in _TOOL_LIFECYCLE_PHASE:
            end += 1
        group = result[index:end]
        call_ids = [
            _tool_lifecycle_identity(record)
            for record in group
            if record.get("kind") == "tool.call"
        ]
        identities = [_tool_lifecycle_identity(record) for record in group]
        if (
            len(call_ids) > 1
            and None not in call_ids
            and len(set(call_ids)) == len(call_ids)
            and all(record.get("concurrencySafe") is True for record in group)
            and all(record.get("sideEffectCount", 0) == 0 for record in group)
            and all(identity in call_ids for identity in identities)
        ):
            order = {identity: offset for offset, identity in enumerate(call_ids)}
            result[index:end] = [
                record
                for _, record in sorted(
                    enumerate(group),
                    key=lambda item: (
                        order[_tool_lifecycle_identity(item[1])],
                        _TOOL_LIFECYCLE_PHASE[item[1]["kind"]],
                        item[0],
                    ),
                )
            ]
        index = end
    return result


def project_semantic_trace(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    generated_ids: dict[tuple[str, str], str] = {}
    projected = [
        _semantic_record(record, generated_ids)
        for record in records
        if record.get("kind") not in _HARNESS_PROOF_KINDS
    ]
    projected = _canonicalize_parallel_tool_lifecycle(projected)
    # Parent and host-owned child loops are independently ordered actors. Their
    # internal event order remains strict, but process scheduling does not
    # define a semantic total order between the two streams.
    durable_kinds = {"durable.status", "durable.steer", "durable.compaction_completed", "compact.boundary", "durable.state"}
    lifecycle_kind = "sidecar.lifecycle"
    parent = [
        record for record in projected
        if record.get("agentScope") != "child"
        and record.get("kind") not in durable_kinds
        and record.get("kind") != lifecycle_kind
    ]
    parent_durable = [
        record for record in projected
        if record.get("agentScope") != "child" and record.get("kind") in durable_kinds
    ]
    child = [
        record for record in projected
        if record.get("agentScope") == "child" and record.get("kind") not in durable_kinds
    ]
    child_durable = [
        record for record in projected
        if record.get("agentScope") == "child" and record.get("kind") in durable_kinds
    ]
    lifecycle = [record for record in projected if record.get("kind") == lifecycle_kind]
    return parent + parent_durable + lifecycle + child + child_durable


def project_format_trace(records: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Return canonical envelopes for warning-only comparison."""
    return canonicalize([
        record for record in records
        if record.get("kind") not in _HARNESS_PROOF_KINDS
    ])


@dataclass(frozen=True)
class Comparison:
    semantic: list[Difference]
    format_warnings: list[Difference]


def compare_traces(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[Difference]:
    return compare_trace_details(left, right).semantic


def _diff_values(left: Any, right: Any) -> list[Difference]:
    differences: list[Difference] = []

    def visit(a: Any, b: Any, path: str) -> None:
        if type(a) is not type(b):
            differences.append(Difference(path, a, b))
            return
        if isinstance(a, dict):
            for key in sorted(set(a) | set(b)):
                if key not in a or key not in b:
                    differences.append(Difference(f"{path}.{key}", a.get(key), b.get(key)))
                else:
                    visit(a[key], b[key], f"{path}.{key}")
            return
        if isinstance(a, list):
            if len(a) != len(b):
                differences.append(Difference(f"{path}.length", len(a), len(b)))
            for index, (item_a, item_b) in enumerate(zip(a, b)):
                visit(item_a, item_b, f"{path}[{index}]")
            return
        if a != b:
            differences.append(Difference(path, a, b))

    visit(left, right, "trace")
    return differences


def _semantic_event_key(record: dict[str, Any]) -> tuple[str, str | None]:
    """Return a stable stream key without treating adjacent insertions as drift.

    A durable status can be inserted before a model request by a newer runtime.
    That remains a semantic difference, but it must not shift every later model,
    tool, and terminal record into a misleading positional mismatch.
    """
    scope = record.get("agentScope")
    return str(record.get("kind") or ""), scope if isinstance(scope, str) else None


def _diff_semantic_records(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> list[Difference]:
    left_keys = [_semantic_event_key(record) for record in left]
    right_keys = [_semantic_event_key(record) for record in right]
    rows, columns = len(left), len(right)
    lcs = [[0] * (columns + 1) for _ in range(rows + 1)]
    for left_index in range(rows - 1, -1, -1):
        for right_index in range(columns - 1, -1, -1):
            if left_keys[left_index] == right_keys[right_index]:
                lcs[left_index][right_index] = 1 + lcs[left_index + 1][right_index + 1]
            else:
                lcs[left_index][right_index] = max(lcs[left_index + 1][right_index], lcs[left_index][right_index + 1])

    differences: list[Difference] = []
    left_index = right_index = 0
    while left_index < rows and right_index < columns:
        if left_keys[left_index] == right_keys[right_index]:
            left_record = left[left_index]
            right_record = right[right_index]
            # A model-visible request is an atomic contract. Reporting every
            # nested prompt/tool-schema leaf obscures the first behavioral
            # divergence without preserving additional diagnostic value; the
            # full request remains attached to the single difference.
            if (
                left_record.get("kind") == "model.request"
                and left_record.get("modelView") != right_record.get("modelView")
            ):
                differences.append(Difference(
                    f"trace[{left_index}]~[{right_index}].modelView",
                    left_record.get("modelView"),
                    right_record.get("modelView"),
                ))
                left_record = {key: value for key, value in left_record.items() if key != "modelView"}
                right_record = {key: value for key, value in right_record.items() if key != "modelView"}
            for difference in _diff_values(left_record, right_record):
                differences.append(Difference(
                    difference.path.replace("trace", f"trace[{left_index}]~[{right_index}]", 1),
                    difference.left,
                    difference.right,
                ))
            left_index += 1
            right_index += 1
        elif lcs[left_index + 1][right_index] >= lcs[left_index][right_index + 1]:
            differences.append(Difference(f"trace[{left_index}]", left[left_index], None))
            left_index += 1
        else:
            differences.append(Difference(f"trace[{left_index}]", None, right[right_index]))
            right_index += 1
    while left_index < rows:
        differences.append(Difference(f"trace[{left_index}]", left[left_index], None))
        left_index += 1
    while right_index < columns:
        differences.append(Difference(f"trace[{left_index}]", None, right[right_index]))
        right_index += 1
    return differences


def compare_trace_details(left: list[dict[str, Any]], right: list[dict[str, Any]]) -> Comparison:
    semantic = (
        _partial_order_differences(left, "left")
        + _partial_order_differences(right, "right")
        + _diff_semantic_records(project_semantic_trace(left), project_semantic_trace(right))
    )
    format_differences = _diff_values(project_format_trace(left), project_format_trace(right))
    return Comparison(semantic=semantic, format_warnings=format_differences)


def compare_baseline_trace_details(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    scenario: dict[str, Any],
) -> Comparison:
    """Compare behavior shared with main while retaining the raw format diff.

    Main and the modular runtime intentionally compose different prompt and
    tool catalogs. The shared contract keeps the requested tools, user-authored
    messages, model identity, effects, policy, output, and terminal state.
    Extension-only prompt/catalog data remains visible in format warnings.
    """
    comparison = scenario.get("baselineComparison")
    extension_tools = (
        {str(name) for name in comparison.get("extensionTools") or []}
        if isinstance(comparison, dict)
        else set()
    )
    tool_description_contracts = (
        comparison.get("toolDescriptionContracts")
        if isinstance(comparison, dict)
        and isinstance(comparison.get("toolDescriptionContracts"), dict)
        else {}
    )

    def description_contract_differences(
        records: list[dict[str, Any]],
        side: str,
    ) -> list[Difference]:
        differences: list[Difference] = []
        for request_index, record in enumerate(records):
            if record.get("kind") != "model.request":
                continue
            view = record.get("modelView")
            if not isinstance(view, dict):
                continue
            for tool in view.get("tools") or []:
                if not isinstance(tool, dict) or not isinstance(tool.get("name"), str):
                    continue
                contract = tool_description_contracts.get(tool["name"])
                if not isinstance(contract, dict) or not isinstance(contract.get(side), str):
                    continue
                if tool.get("description") != contract[side]:
                    differences.append(Difference(
                        f"trace[{request_index}].modelView.tools.{tool['name']}.description.{side}",
                        contract[side],
                        tool.get("description"),
                    ))
        return differences

    def shared(
        records: list[dict[str, Any]],
        side: str,
    ) -> tuple[list[dict[str, Any]], list[dict[str, Any] | None]]:
        projected = project_semantic_trace(records)
        result: list[dict[str, Any]] = []
        raw_request_views: list[dict[str, Any] | None] = []
        pending_current_budgets: list[dict[str, Any]] = []
        last_baseline_request: dict[str, Any] | None = None
        for record in projected:
            if record.get("kind") in {"durable.status", "durable.steer", "durable.compaction_completed"}:
                continue
            if record.get("kind") == "context.budget":
                budget = _baseline_shared_context_budget(record)
                if side == "baseline" and last_baseline_request is not None and "contextBudget" not in last_baseline_request:
                    last_baseline_request["contextBudget"] = budget
                elif side == "current":
                    pending_current_budgets.append(budget)
                else:
                    result.append(record)
                continue
            candidate = dict(record)
            if candidate.get("kind") == "model.request":
                view = candidate.get("modelView")
                raw_request_views.append(dict(view) if isinstance(view, dict) else None)
                if isinstance(view, dict):
                    messages = [_baseline_shared_runtime_message(message) for message in view.get("messages") or []]
                    messages = [message for message in messages if message is not None]
                    # Preserve every provider-visible request control. Only
                    # explicitly declared composition additions are removed.
                    # Filtering to scenario.tools hid prompt/cache/tool-policy
                    # regressions and made a changed tool catalog look equal.
                    normalized_view = dict(view)
                    normalized_view["messages"] = messages
                    normalized_view["systemPrompt"] = _baseline_shared_system_prompt(
                        normalized_view.get("systemPrompt"),
                    )
                    composition = _runtime_composition(view)
                    if composition:
                        normalized_view["runtimeComposition"] = composition
                    if extension_tools:
                        normalized_view["tools"] = [
                            tool for tool in view.get("tools") or []
                            if not (isinstance(tool, dict) and tool.get("name") in extension_tools)
                        ]
                    normalized_tools: list[Any] = []
                    for tool in normalized_view.get("tools") or []:
                        if not isinstance(tool, dict):
                            normalized_tools.append(tool)
                            continue
                        contract = tool_description_contracts.get(tool.get("name"))
                        if isinstance(contract, dict) and tool.get("description") == contract.get(side):
                            normalized_tool = dict(tool)
                            normalized_tool["description"] = "<declared-sdk-tool-description>"
                            normalized_tools.append(normalized_tool)
                        else:
                            normalized_tools.append(tool)
                    normalized_view["tools"] = normalized_tools
                    candidate["modelView"] = normalized_view
                if side == "current" and pending_current_budgets:
                    candidate["contextBudget"] = pending_current_budgets.pop(0)
                if side == "baseline":
                    last_baseline_request = candidate
            elif candidate.get("kind") == "agent.status" and candidate.get("event") == "context_budget":
                detail = candidate.get("detail")
                candidate["detail"] = {
                    "type": detail.get("type") if isinstance(detail, dict) else None,
                    "state": detail.get("state") if isinstance(detail, dict) else None,
                }
            result.append(candidate)
        result.extend(pending_current_budgets)
        return result, raw_request_views

    left_shared, left_raw_requests = shared(left, "baseline")
    right_shared, right_raw_requests = shared(right, "current")
    budget_validation = (
        _baseline_budget_validation_differences(left_shared, "baseline")
        + _baseline_budget_validation_differences(right_shared, "current")
    )
    _normalize_baseline_budget_for_declared_request_drift(
        left_shared,
        right_shared,
        left_raw_requests,
        right_raw_requests,
    )

    semantic = (
        _partial_order_differences(left, "left")
        + _partial_order_differences(right, "right")
        + budget_validation
        + description_contract_differences(left, "baseline")
        + description_contract_differences(right, "current")
        + _diff_semantic_records(left_shared, right_shared)
    )
    format_differences = _diff_values(project_format_trace(left), project_format_trace(right))
    return Comparison(semantic=semantic, format_warnings=format_differences)


_BASELINE_CONTEXT_BUDGET_FIELDS = (
    "used",
    "displayUsed",
    "budgetUsed",
    "total",
    "effectiveTotal",
    "reservedOutputTokens",
    "ratio",
    "state",
)

_BASELINE_CONTEXT_BUDGET_DECISION_FIELDS = (
    "total",
    "effectiveTotal",
    "reservedOutputTokens",
    "state",
)


def _baseline_budget_validation_differences(
    records: list[dict[str, Any]],
    side: str,
) -> list[Difference]:
    differences: list[Difference] = []
    for index, request in enumerate(record for record in records if record.get("kind") == "model.request"):
        budget = request.get("contextBudget")
        if not isinstance(budget, dict):
            continue
        path = f"trace.contextBudget.{side}[{index}]"
        for field in ("used", "displayUsed", "total", "effectiveTotal", "reservedOutputTokens", "ratio"):
            value = budget.get(field)
            if not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0:
                differences.append(Difference(f"{path}.{field}", "non_negative_number", value))
        used = budget.get("used")
        effective_total = budget.get("effectiveTotal")
        ratio = budget.get("ratio")
        if isinstance(used, (int, float)) and isinstance(effective_total, (int, float)) \
                and isinstance(ratio, (int, float)) and effective_total > 0:
            expected_ratio = used / effective_total
            if abs(ratio - expected_ratio) > 1e-12:
                differences.append(Difference(f"{path}.ratio_consistency", expected_ratio, ratio))
        if budget.get("state") not in {"ok", "warning", "blocking"}:
            differences.append(Difference(f"{path}.state", "ok|warning|blocking", budget.get("state")))
        breakdown = budget.get("breakdown")
        if breakdown is not None:
            if not isinstance(breakdown, dict):
                differences.append(Difference(f"{path}.breakdown", "object", breakdown))
            else:
                component_fields = ("system", "tools", "messages", "mcp", "memory")
                components = [breakdown.get(field) for field in component_fields]
                if any(
                    not isinstance(value, (int, float)) or isinstance(value, bool) or value < 0
                    for value in components
                ):
                    differences.append(Difference(
                        f"{path}.breakdown.components",
                        "non_negative_numbers",
                        breakdown,
                    ))
                total = breakdown.get("total")
                if not isinstance(total, (int, float)) or isinstance(total, bool) or total < 0:
                    differences.append(Difference(f"{path}.breakdown.total", "non_negative_number", total))
                elif all(isinstance(value, (int, float)) and not isinstance(value, bool) for value in components):
                    component_total = sum(components)
                    if component_total != total:
                        differences.append(Difference(
                            f"{path}.breakdown.total_consistency",
                            component_total,
                            total,
                        ))
                if isinstance(used, (int, float)) and isinstance(total, (int, float)) and used != total:
                    differences.append(Difference(
                        f"{path}.breakdown.used_consistency",
                        total,
                        used,
                    ))
    return differences


def _baseline_shared_context_budget(record: dict[str, Any]) -> dict[str, Any]:
    return {
        "kind": "context.budget",
        **{
            key: record[key]
            for key in (*_BASELINE_CONTEXT_BUDGET_FIELDS, "breakdown")
            if key in record
        },
    }


def _normalize_baseline_budget_for_declared_request_drift(
    left: list[dict[str, Any]],
    right: list[dict[str, Any]],
    left_raw_requests: list[dict[str, Any] | None],
    right_raw_requests: list[dict[str, Any] | None],
) -> None:
    left_requests = [record for record in left if record.get("kind") == "model.request"]
    right_requests = [record for record in right if record.get("kind") == "model.request"]
    for index, (left_request, right_request) in enumerate(zip(left_requests, right_requests)):
        if left_request.get("modelView") != right_request.get("modelView"):
            continue
        left_raw = left_raw_requests[index] if index < len(left_raw_requests) else None
        right_raw = right_raw_requests[index] if index < len(right_raw_requests) else None
        if left_raw == right_raw:
            continue
        # A request-level budget may legitimately have a different measured
        # usage when the raw request differs only on an explicitly declared
        # composition surface (SDK extension tools, runtime projection, or a
        # contracted tool description). The current trace must prove that its
        # measured value comes from a complete internally consistent
        # breakdown; otherwise the usage difference remains semantic.
        current_budget = right_request.get("contextBudget")
        breakdown = current_budget.get("breakdown") if isinstance(current_budget, dict) else None
        if not isinstance(breakdown, dict):
            continue
        for request in (left_request, right_request):
            budget = request.get("contextBudget")
            if isinstance(budget, dict):
                request["contextBudget"] = {
                    key: budget[key]
                    for key in _BASELINE_CONTEXT_BUDGET_DECISION_FIELDS
                    if key in budget
                }


def _baseline_shared_message(message: Any) -> Any:
    if not isinstance(message, dict):
        return message
    result = dict(message)
    content = result.get("content")
    if isinstance(content, list):
        result["content"] = [
            block for block in content
            if not (
                isinstance(block, dict)
                and block.get("type") == "text"
                and str(block.get("text") or "").startswith("[Attachment diagnostics]\n")
            )
        ]
    return result


def _tagged_prompt_sections(value: Any, tag: str) -> list[str]:
    if not isinstance(value, str):
        return []
    sections: list[str] = []
    for match in re.finditer(rf"<{re.escape(tag)}>(.*?)</{re.escape(tag)}>", value, re.DOTALL):
        section = match.group(1).strip()
        if tag == "available-skills":
            section = re.sub(r"\(file: [^)]+\)", "(file: <skill-path>)", section)
        sections.append(section)
    return sections


def _runtime_composition(view: dict[str, Any]) -> dict[str, Any]:
    composition: dict[str, Any] = {}
    order_violations: list[str] = []
    observed: list[tuple[int, str, str, str]] = []
    sequence = 0

    def collect(value: Any, location: str) -> None:
        nonlocal sequence
        if isinstance(value, str):
            for match in re.finditer(
                r"<(user-context|available-skills)>(.*?)</\1>",
                value,
                re.DOTALL,
            ):
                tag = match.group(1)
                key = "userContext" if tag == "user-context" else "availableSkills"
                section = match.group(2).strip()
                if tag == "available-skills":
                    section = re.sub(r"\(file: [^)]+\)", "(file: <skill-path>)", section)
                observed.append((sequence, key, section, location))
                sequence += 1

    system_prompt = view.get("systemPrompt")
    collect(system_prompt, "systemPrompt")
    for message_index, message in enumerate(view.get("messages") or []):
        if not isinstance(message, dict) or not isinstance(message.get("metadata"), dict):
            continue
        if message["metadata"].get("purpose") != "runtime_context":
            continue
        for block_index, block in enumerate(message.get("content") or []):
            if not isinstance(block, dict) or block.get("type") != "text":
                continue
            collect(block.get("text"), f"messages[{message_index}].content[{block_index}]")
    for _sequence, key, section, _location in observed:
        composition.setdefault(key, []).append(section)
    ranks = [0 if key == "userContext" else 1 for _sequence, key, _section, _location in observed]
    order_error = any(
        ranks[left_index] > ranks[right_index]
        and not (
            (observed[left_index][3] == "systemPrompt")
            != (observed[right_index][3] == "systemPrompt")
        )
        for left_index in range(len(observed))
        for right_index in range(left_index + 1, len(observed))
    )
    if order_error:
        order_violations.append("request")
    if order_violations:
        composition["orderViolations"] = order_violations
    return composition


def _baseline_shared_runtime_message(message: Any) -> Any:
    normalized = _baseline_shared_message(message)
    if not isinstance(normalized, dict) or not isinstance(normalized.get("metadata"), dict):
        return normalized
    if normalized["metadata"].get("purpose") != "runtime_context":
        return normalized
    content = normalized.get("content")
    if not isinstance(content, list):
        return normalized
    residual: list[Any] = []
    for block in content:
        if not isinstance(block, dict) or block.get("type") != "text":
            residual.append(block)
            continue
        text = block.get("text")
        if not isinstance(text, str):
            residual.append(block)
            continue
        for tag in ("user-context", "available-skills"):
            text = re.sub(rf"<{re.escape(tag)}>.*?</{re.escape(tag)}>", "", text, flags=re.DOTALL)
        text = re.sub(
            r'<runtime-context(?: name="pilotdeck:(?:user-context|available-skills):\d+")?>\s*</runtime-context>',
            "",
            text,
            flags=re.DOTALL,
        )
        text = re.sub(r"\n{3,}", "\n\n", text).strip()
        if text:
            residual.append({**block, "text": text})
    if not residual:
        return None
    return {**normalized, "content": residual}


def _baseline_shared_system_prompt(value: Any) -> Any:
    """Remove only runtime-projected context that has its own canonical surface.

    Main keeps user context in the system prompt while the modular profile
    persists it as a synthetic runtime-context message. Skills are similarly
    discovered from the deployment environment rather than authored by the
    scenario. Static system instructions remain byte-for-byte comparable.
    """
    if not isinstance(value, str):
        return value
    result = value
    for tag in ("user-context", "available-skills"):
        start = f"<{tag}>"
        end = f"</{tag}>"
        while start in result:
            before, remainder = result.split(start, 1)
            if end not in remainder:
                break
            _discarded, after = remainder.split(end, 1)
            result = before + after
    return re.sub(r"\n{3,}", "\n\n", result).strip()


def _partial_order_differences(records: list[dict[str, Any]], side: str) -> list[Difference]:
    """Validate durable-before-visible relationships without requiring a total order.

    Host scheduling may insert unrelated durable records between model events.
    These three relationships are not scheduler noise: violating one means a
    reconnect can observe state the model/client was never durably committed.
    """
    differences: list[Difference] = []
    compact_indices = [index for index, record in enumerate(records) if record.get("kind") == "compact.boundary"]
    boundary_ids = [records[index].get("compactionId") for index in compact_indices]
    duplicate_ids = {
        compaction_id for compaction_id in boundary_ids
        if compaction_id is not None and boundary_ids.count(compaction_id) > 1
    }
    for compact_index in compact_indices:
        compaction_id = records[compact_index].get("compactionId")
        if compaction_id is None:
            differences.append(Difference(
                f"trace.partialOrder.{side}.compaction_identity_missing.{compact_index}",
                "non_empty_compaction_id",
                None,
            ))
        elif compaction_id in duplicate_ids:
            differences.append(Difference(
                f"trace.partialOrder.{side}.compaction_identity_duplicate.{compaction_id}",
                "unique_compaction_id",
                "duplicate",
            ))
        completed_index = next((
            index for index, record in enumerate(records)
            if record.get("kind") == "durable.compaction_completed"
            and compaction_id is not None
            and record.get("compactionId") == compaction_id
        ), None)
        following_request = next((
            index for index, record in enumerate(records)
            if record.get("kind") == "model.request"
            and compaction_id is not None
            and record.get("afterCompactionId") == compaction_id
        ), None)
        identity = str(compaction_id or compact_index)
        if completed_index is None:
            differences.append(Difference(
                f"trace.partialOrder.{side}.compaction_completion_missing.{identity}",
                "boundary_before_completion",
                "missing",
            ))
        elif completed_index < compact_index:
            differences.append(Difference(
                f"trace.partialOrder.{side}.compaction_boundary_before_completion.{identity}",
                "boundary_before_completion",
                "completion_before_boundary",
            ))
        if following_request is None:
            differences.append(Difference(
                f"trace.partialOrder.{side}.compaction_followup_request_missing.{identity}",
                "completion_before_request",
                "missing",
            ))
        elif completed_index is not None and completed_index > following_request:
            differences.append(Difference(
                f"trace.partialOrder.{side}.compaction_completion_before_request.{identity}",
                "completion_before_request",
                "request_before_completion",
            ))

    durable_status_indices: dict[str, list[int]] = {}
    durable_steer_indices: dict[str, list[int]] = {}
    for index, record in enumerate(records):
        if record.get("kind") == "durable.status" and isinstance(record.get("event"), str):
            durable_status_indices.setdefault(record["event"], []).append(index)
        if record.get("kind") == "durable.steer" and isinstance(record.get("itemId"), str):
            durable_steer_indices.setdefault(record["itemId"], []).append(index)
    consumed_status: dict[str, int] = {}
    consumed_steer: dict[str, int] = {}
    for index, record in enumerate(records):
        if record.get("kind") == "agent.status" and isinstance(record.get("event"), str):
            if record["event"] not in _REQUIRED_DURABLE_STATUS_EVENTS:
                continue
            durable = durable_status_indices.get(record["event"], [])
            occurrence = consumed_status.get(record["event"], 0)
            durable_index = durable[occurrence] if occurrence < len(durable) else None
            consumed_status[record["event"]] = occurrence + 1
            if durable_index is None:
                differences.append(Difference(
                    f"trace.partialOrder.{side}.durable_status_missing.{record['event']}[{occurrence}]",
                    "durable_before_visible",
                    "missing",
                ))
            elif durable_index > index:
                differences.append(Difference(
                    f"trace.partialOrder.{side}.durable_status_before_visible.{record['event']}[{occurrence}]",
                    "durable_before_visible",
                    "visible_before_durable",
                ))
        if record.get("kind") == "steer.applied" and isinstance(record.get("itemId"), str):
            durable = durable_steer_indices.get(record["itemId"], [])
            occurrence = consumed_steer.get(record["itemId"], 0)
            durable_index = durable[occurrence] if occurrence < len(durable) else None
            consumed_steer[record["itemId"]] = occurrence + 1
            if durable_index is None:
                differences.append(Difference(
                    f"trace.partialOrder.{side}.durable_steer_missing.{record['itemId']}[{occurrence}]",
                    "durable_before_applied",
                    "missing",
                ))
            elif durable_index > index:
                differences.append(Difference(
                    f"trace.partialOrder.{side}.durable_steer_before_applied.{record['itemId']}[{occurrence}]",
                    "durable_before_applied",
                    "applied_before_durable",
                ))

    # A close/abort acknowledgement is a lifecycle settlement boundary. A
    # model request after it would permit an old actor to create side effects
    # after the session was closed or the turn was aborted.
    settlement_states = {
        "parent_closed": "close",
        "parent_abort_acknowledged": "abort",
        "parent_abort_settled": "abort",
    }
    for index, record in enumerate(records):
        if record.get("kind") != "sidecar.lifecycle":
            continue
        settlement = settlement_states.get(record.get("state"))
        if settlement is None:
            continue
        late_request = next(
            (
                request_index
                for request_index, candidate in enumerate(records[index + 1:], start=index + 1)
                if candidate.get("kind") == "model.request"
            ),
            None,
        )
        if late_request is not None:
            differences.append(Difference(
                f"trace.partialOrder.{side}.{settlement}_after_settlement.{index}",
                f"no_model_request_after_{settlement}_settlement",
                {"modelRequestIndex": late_request, "state": record.get("state")},
            ))
    return differences


def _merged_expectation(scenario: dict[str, Any], pair: str) -> dict[str, Any]:
    expected = dict(scenario.get("expected") or {})
    pair_overrides = scenario.get("expectedByPair") or {}
    if isinstance(pair_overrides, dict) and isinstance(pair_overrides.get(pair), dict):
        expected.update(pair_overrides[pair])
    return expected


def _merged_adapter_expectation(scenario: dict[str, Any], pair: str, adapter: str | None) -> dict[str, Any]:
    expected = _merged_expectation(scenario, pair)
    overrides = scenario.get("expectedByAdapter") or {}
    if adapter and isinstance(overrides, dict) and isinstance(overrides.get(adapter), dict):
        expected.update(overrides[adapter])
    return expected


def _last(records: list[dict[str, Any]], kind: str) -> dict[str, Any] | None:
    return next((record for record in reversed(records) if record.get("kind") == kind), None)


def _record_value(records: list[dict[str, Any]], key: str) -> Any:
    terminal = _last(records, "terminal") or {}
    taskframe = _last(records, "taskframe") or {}
    session = _last(records, "session.state") or {}
    checkpoint = _last(records, "checkpoint") or {}
    mapping = {
        "terminalOutcome": terminal.get("outcome"),
        "errorCode": terminal.get("code"),
        "stopReason": terminal.get("stopReason"),
        "frameStatus": terminal.get("frameStatus") or taskframe.get("status") or (taskframe.get("taskFrame") or {}).get("status"),
        "runStatus": terminal.get("runStatus"),
        "taskFrameStatus": taskframe.get("status") or (taskframe.get("taskFrame") or {}).get("status"),
        "activeStepId": session.get("activeStepId") or checkpoint.get("activeStepId"),
        "nextStepId": taskframe.get("nextStepId"),
        "awaitingInput": session.get("awaitingInput"),
        "handoff": session.get("handoff"),
        "slots": session.get("slots") or taskframe.get("slots") or checkpoint.get("slots"),
        "knowledgeBudget": taskframe.get("knowledgeBudget") or checkpoint.get("knowledgeBudget"),
        "requiredCapabilities": taskframe.get("requiredCapabilities"),
        "priorTaskResults": taskframe.get("priorTaskResults") or session.get("priorTaskResults"),
        "executionTarget": taskframe.get("executionTarget") or session.get("executionTarget"),
        "forcedSopVersion": taskframe.get("forcedSopVersion") or session.get("forcedSopVersion"),
        "output": terminal.get("output"),
        "turnSpentUsd": next(
            (
                (record.get("detail") or {}).get("turnSpentBudgetUsd")
                for record in reversed(records)
                if record.get("kind") == "agent.status"
                and record.get("event") in {"max_budget_reached", "task_budget_reached"}
                and isinstance(record.get("detail"), dict)
            ),
            (terminal.get("usage") or {}).get("nativeCost") if isinstance(terminal.get("usage"), dict) else None,
        ),
        "modelAttempts": sum(record.get("kind") == "model.request" for record in records),
        "steerAppliedCount": sum(record.get("kind") == "steer.applied" for record in records),
        "parentClosed": any(
            record.get("kind") == "sidecar.lifecycle"
            and record.get("state") == "parent_closed"
            and record.get("parentClosed") is True
            for record in records
        ),
        "parentAborted": any(
            record.get("kind") == "sidecar.lifecycle"
            and record.get("state") == "parent_abort_acknowledged"
            and record.get("parentAborted") is True
            for record in records
        ),
        "terminalCount": next(
            (
                record.get("terminalCount")
                for record in reversed(records)
                if record.get("kind") == "sidecar.lifecycle"
                and isinstance(record.get("terminalCount"), int)
            ),
            None,
        ),
        "operationOutcome": (_last(records, "operation.terminal") or {}).get("outcome"),
        "pendingTasks": session.get("pendingTasks"),
        "toolStartedBeforeTerminal": any(
            record.get("kind") == "tool.start"
            for record in records[:next((
                index for index, record in enumerate(records)
                if record.get("kind") == "terminal"
            ), len(records))]
        ),
        "sessionRebuiltForResume": any(
            record.get("kind") == "session.lifecycle"
            and record.get("state") == "closed_for_resume"
            for record in records
        ),
    }
    durable = _last(records, "durable.state") or {}
    if key in {
        "durableStatusCount", "durableSteerCount", "compactionBoundaryCount",
        "compactionCompletedCount", "replayedStatusCount",
    }:
        return durable.get(key)
    if key == "compactionPersistedBeforeModel":
        compact_index = next((index for index, record in enumerate(records) if record.get("kind") == "compact.boundary"), None)
        model_index = next((index for index, record in enumerate(records) if record.get("kind") == "model.request"), None)
        return compact_index is not None and model_index is not None and compact_index < model_index
    if key == "fullRequestBudgetUsed":
        budget = next((record for record in records if record.get("kind") == "compaction.budget" and record.get("phase") == "replacement"), {})
        return (
            isinstance(budget.get("systemTokens"), (int, float))
            and budget.get("systemTokens", 0) > 0
            and isinstance(budget.get("toolTokens"), (int, float))
            and budget.get("toolTokens", 0) > 0
        )
    if key == "budgetEvaluationCount":
        return sum(record.get("kind") == "compaction.budget" for record in records)
    if key == "seedReadApplied":
        return (_last(records, "seed.state") or {}).get("applied")
    if key == "seededFileContent":
        return (_last(records, "seed.state") or {}).get("fileContent")
    if key == "firstDeltaBeforeProviderCompletion":
        first_delta = next((index for index, record in enumerate(records)
                            if record.get("kind") == "model.stream" and record.get("state") == "first_delta"), None)
        provider_completed = next((index for index, record in enumerate(records)
                                   if record.get("kind") == "model.stream" and record.get("state") == "provider_completed"), None)
        user_delta = next((index for index, record in enumerate(records)
                           if record.get("kind") == "user.output" and "STREAM_PREFIX" in str(record.get("text") or "")), None)
        return (
            first_delta is not None
            and provider_completed is not None
            and user_delta is not None
            and first_delta < user_delta < provider_completed
        )
    if key == "toolCalls":
        calls = [
            record.get("name") or record.get("toolName")
            for record in records
            if record.get("kind") == "tool.call"
        ]
        if calls:
            return calls
        # Gateway adapters may observe a built-in tool call only in the
        # canonical model response, before the tool lifecycle event arrives.
        # Preserve that semantic call list instead of treating it as no call.
        for record in records:
            if record.get("kind") != "model.response":
                continue
            message = record.get("modelView") or record.get("message") or {}
            tool_calls = message.get("tool_calls") if isinstance(message, dict) else None
            if isinstance(tool_calls, list):
                return [
                    (item.get("function") or {}).get("name")
                    for item in tool_calls
                    if isinstance(item, dict) and isinstance(item.get("function"), dict)
                ]
        return []
    if key == "policyModes":
        return [
            record.get("permissionMode")
            for record in records
            if record.get("kind") == "policy.turn" and isinstance(record.get("permissionMode"), str)
        ]
    if key == "toolCallCount":
        calls = [record for record in records if record.get("kind") == "tool.call"]
        if calls:
            return len(calls)
        return sum(
            len((record.get("modelView") or {}).get("tool_calls") or [])
            for record in records
            if record.get("kind") == "model.response" and isinstance(record.get("modelView") or {}, dict)
        )
    if key == "toolProgressCount":
        return sum(record.get("kind") == "tool.progress" for record in records)
    if key == "sideEffectCount":
        state = _last(records, "side_effect.state") or {}
        if isinstance(state.get("sideEffectCount"), int):
            return state["sideEffectCount"]
        counts = [
            value
            for record in records
            for value in [record.get("sideEffectCount"), (record.get("result") or {}).get("sideEffectCount") if isinstance(record.get("result"), dict) else None]
            if isinstance(value, int)
        ]
        return max(counts, default=0)
    if key == "permissionAllowed":
        decisions = [
            record.get("allowed")
            for record in records
            if record.get("kind") in {"permission.answer", "permission.decision"}
            and isinstance(record.get("allowed"), bool)
        ]
        if not decisions:
            for record in records:
                if record.get("kind") != "tool.finish" or record.get("success") is not False:
                    continue
                error = record.get("error")
                code = error.get("code") if isinstance(error, dict) else None
                if code in {"permission_denied", "permission_required", "PERMISSION_DENIED"}:
                    decisions.append(False)
        return all(decisions) if decisions else None
    if key in {"toolErrorCode", "toolRetryable"}:
        errors = []
        for record in records:
            if record.get("kind") not in {"tool.finish", "tool.result"}:
                continue
            result = record.get("result") if isinstance(record.get("result"), dict) else record
            error = result.get("error") if isinstance(result.get("error"), dict) else {}
            if error:
                errors.append(error)
        if not errors:
            return None
        return errors[-1].get("code" if key == "toolErrorCode" else "retryable")
    if key == "modelVisibleTools":
        request_record = next((record for record in records if record.get("kind") == "model.request"), {})
        model_view = request_record.get("modelView") if isinstance(request_record.get("modelView"), dict) else request_record
        tools = model_view.get("tools") if isinstance(model_view, dict) else None
        names = [tool.get("name") or (tool.get("function") or {}).get("name") for tool in tools or [] if isinstance(tool, dict)]
        return names
    return mapping.get(key)


def validate_trace_expectations(
    records: list[dict[str, Any]],
    scenario: dict[str, Any],
    pair: str,
    adapter: str | None = None,
) -> list[Difference]:
    """Validate a single adapter trace against its scenario oracle."""
    expected = _merged_adapter_expectation(scenario, pair, adapter)
    failures: list[Difference] = []
    for key, wanted in expected.items():
        if key in {"requiresImage", "noToolSideEffects", "modelVisibleToolsExclude", "modelVisibleToolsInclude"}:
            if key == "requiresImage":
                requests = [record for record in records if record.get("kind") == "model.request"]
                actual = any(
                    isinstance(node, dict)
                    and (
                        node.get("type") == "image_url"
                        or (node.get("type") == "image" and node.get("source") == "base64")
                    )
                for request in requests
                for node in _walk(request.get("modelView") or request.get("request") or request.get("messages"))
                )
            elif key == "noToolSideEffects":
                actual = _record_value(records, "sideEffectCount") == 0
            elif key == "modelVisibleToolsExclude":
                visible = _record_value(records, "modelVisibleTools") or []
                excluded = wanted if isinstance(wanted, list) else [wanted]
                actual = all(str(name) not in visible for name in excluded)
                wanted = True
            else:
                visible = _record_value(records, "modelVisibleTools") or []
                included = wanted if isinstance(wanted, list) else [wanted]
                actual = all(str(name) in visible for name in included)
                wanted = True
        elif key == "outputContains":
            output = _record_value(records, "output")
            actual = isinstance(output, str) and str(wanted) in output
            wanted = True
        elif key == "modelInputContains":
            requests = [record for record in records if record.get("kind") == "model.request"]
            actual = any(str(wanted) in str(node) for request in requests for node in _walk(request.get("modelView") or request.get("request")))
            wanted = True
        elif key == "modelInputExcludes":
            requests = [record for record in records if record.get("kind") == "model.request"]
            actual = all(str(wanted) not in str(node) for request in requests for node in _walk(request.get("modelView") or request.get("request")))
            wanted = True
        elif key in {"modelInputAfterCompactionContains", "modelInputAfterCompactionExcludes"}:
            boundary_index = next((index for index, record in enumerate(records) if record.get("kind") == "compact.boundary"), None)
            requests = [] if boundary_index is None else [record for record in records[boundary_index + 1:] if record.get("kind") == "model.request"]
            if key == "modelInputAfterCompactionContains":
                actual = bool(requests) and any(str(wanted) in str(node) for request in requests for node in _walk(request.get("modelView") or request.get("request")))
            else:
                actual = bool(requests) and all(str(wanted) not in str(node) for request in requests for node in _walk(request.get("modelView") or request.get("request")))
            wanted = True
        else:
            actual = _record_value(records, key)
        if canonicalize(actual) != canonicalize(wanted):
            failures.append(Difference(f"{_expectation_path(key)}", wanted, actual))
    return failures


def _expectation_path(key: str) -> str:
    return {
        "terminalOutcome": "terminal.outcome",
        "errorCode": "terminal.code",
        "stopReason": "terminal.stopReason",
    }.get(key, key)


def _walk(value: Any):
    if isinstance(value, dict):
        yield value
        for child in value.values():
            yield from _walk(child)
    elif isinstance(value, list):
        for child in value:
            yield from _walk(child)


def write_report(
    path: Path,
    pair_name: str,
    left_path: Path,
    right_path: Path,
    differences: list[Difference] | Comparison,
) -> None:
    comparison = differences if isinstance(differences, Comparison) else Comparison(differences, [])
    semantic = comparison.semantic
    warnings = comparison.format_warnings
    lines = [f"# {pair_name}", "", f"- left: `{left_path}`", f"- right: `{right_path}`", ""]
    if not semantic:
        lines.append("PASS: no semantic differences after projection.")
    else:
        lines.append(f"FAIL: {len(semantic)} semantic difference(s).")
        lines.append("\n## Semantic Differences\n")
        for diff in semantic[:50]:
            lines.extend(["", f"- `{diff.path}`", f"  - left: `{json.dumps(diff.left, ensure_ascii=False, sort_keys=True)}`", f"  - right: `{json.dumps(diff.right, ensure_ascii=False, sort_keys=True)}`"])
    if warnings:
        lines.append("\n## Format Warnings\n")
        lines.append(f"{len(warnings)} envelope/serialization difference(s); these do not affect exit status.")
        for diff in warnings[:50]:
            lines.extend(["", f"- `{diff.path}`", f"  - left: `{json.dumps(diff.left, ensure_ascii=False, sort_keys=True)}`", f"  - right: `{json.dumps(diff.right, ensure_ascii=False, sort_keys=True)}`"])
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")
