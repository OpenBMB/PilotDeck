"""Durable single-host SOP scheduling. Model/tool effects remain host-owned."""
from __future__ import annotations

import json
import time
from copy import deepcopy
from uuid import uuid4

from staffdeck_sop_core import SopCoreError
from staffdeck_sop_core.graph import default_next, is_terminal, outgoing, validate_graph


TERMINAL = {"completed", "failed", "cancelled", "result_unknown"}
SOURCES = {"originalQuery", "latestUserMessage", "handoffText", "slots", "item", "files", "attachments", "history", "output"}


def fail(code, message):
    raise SopCoreError(code, message)


def strict(value, allowed, required=()):
    if not isinstance(value, dict) or set(value) - set(allowed) or set(required) - set(value):
        fail("SOP_V4_INVALID", f"Expected fields {sorted(allowed)}; required {sorted(required)}")
    return value


def positive(value, maximum):
    if type(value) is not int or not 1 <= value <= maximum:
        fail("SOP_CONCURRENCY_INVALID", f"Expected integer in 1..{maximum}")
    return value


def text(value):
    if not isinstance(value, str) or not value.strip():
        fail("SOP_V4_INVALID", "Expected a nonempty string")
    return value


def model(value):
    strict(value, {"provider", "model"}, {"provider", "model"})
    text(value["provider"])
    text(value["model"])


def binding(value):
    strict(value, {"source", "path", "value"})
    if "value" in value:
        if len(value) != 1:
            fail("SOP_V4_INVALID", "Literal binding must contain only value")
    elif value.get("source") not in SOURCES or not isinstance(value.get("path", ""), str):
        fail("SOP_V4_INVALID", "Invalid mapping source or path")


def select(value, path):
    for part in path.split(".") if path else []:
        if isinstance(value, dict) and part in value:
            value = value[part]
        elif isinstance(value, list) and part.isdigit() and int(part) < len(value):
            value = value[int(part)]
        else:
            fail("SOP_INPUT_MISSING", f"Input path does not exist: {path}")
    return deepcopy(value)


def mapping(fields, sources):
    result = {}
    for key, binding in fields.items():
        strict(binding, {"source", "path", "value"})
        if "value" in binding:
            if len(binding) != 1:
                fail("SOP_V4_INVALID", "Literal binding must contain only value")
            result[key] = deepcopy(binding["value"])
        else:
            if binding.get("source") not in SOURCES:
                fail("SOP_V4_INVALID", "Unknown input source")
            result[key] = select(sources[binding["source"]], binding.get("path", ""))
            if binding["source"] == "attachments":
                result[key] = {"sopInlineAttachments": result[key]}
    return result


def validate_definition(content):
    strict(content, {"schema", "skill_id", "version", "name", "start_node_id", "terminal_node_ids", "nodes", "edges"},
           {"schema", "skill_id", "version", "start_node_id", "nodes", "edges"})
    if content["schema"] != "sop.definition/v4":
        fail("SOP_V4_INVALID", "Only sop.definition/v4 is accepted")
    text(content["skill_id"])
    text(content["version"])
    if not isinstance(content["nodes"], list) or not isinstance(content["edges"], list):
        fail("SOP_V4_INVALID", "nodes and edges must be arrays")
    validate_graph(content)
    for edge in content["edges"]:
        strict(edge, {"source_node_id", "next_node_id", "condition", "priority", "label"}, {"source_node_id", "next_node_id"})
    for node in content["nodes"]:
        strict(node, {"node_id", "type", "instruction", "model", "input", "subSop", "output", "items", "assigneeUserId", "tools"}, {"node_id"})
        text(node["node_id"])
        if not isinstance(node.get("instruction", ""), str) or not isinstance(node.get("items", ""), str):
            fail("SOP_V4_INVALID", "instruction and items must be strings")
        if not isinstance(node.get("tools", []), list) or any(not isinstance(t, str) or not t for t in node.get("tools", [])):
            fail("SOP_V4_INVALID", "tools must be a string array")
        if node.get("type", "task") not in {"task", "subflow", "foreach", "approval"}:
            fail("SOP_V4_INVALID", "Unknown v4 node type")
        config = node.get("input", {})
        strict(config, {"fields", "template", "history"})
        if not isinstance(config.get("fields", {}), dict) or not isinstance(config.get("template", ""), str) or type(config.get("history", False)) is not bool:
            fail("SOP_V4_INVALID", "Invalid node input")
        if not isinstance(node.get("output", {}), dict):
            fail("SOP_V4_INVALID", "output must be a mapping")
        for value in [*config.get("fields", {}).values(), *node.get("output", {}).values()]:
            binding(value)
        if node.get("type") in {"subflow", "foreach"}:
            strict(node.get("subSop"), {"sopId", "version"}, {"sopId", "version"})
            text(node["subSop"]["sopId"])
            text(node["subSop"]["version"])
        elif "subSop" in node or "items" in node:
            fail("SOP_V4_INVALID", "Only subflow/foreach nodes may reference subSop")
        if node.get("model") is not None:
            model(node["model"])
        if node.get("type") == "approval" and not node.get("assigneeUserId"):
            fail("SOP_V4_INVALID", "Approval requires assigneeUserId")


class ExecutionService:
    def __init__(self, store, max_concurrency=32, now=time.time):
        self.store, self.db, self.now = store, store._connection, now
        self.maximum = positive(max_concurrency, 10000)
        self.db.executescript("""
          CREATE TABLE IF NOT EXISTS sop_v4_runs(id TEXT PRIMARY KEY, scope TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sop_v4_executions(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS sop_v4_execution_run ON sop_v4_executions(run_id);
          CREATE TABLE IF NOT EXISTS sop_v4_calls(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS sop_v4_call_run ON sop_v4_calls(run_id);
          CREATE TABLE IF NOT EXISTS sop_v4_attempts(id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE INDEX IF NOT EXISTS sop_v4_attempt_run ON sop_v4_attempts(run_id);
          CREATE TABLE IF NOT EXISTS sop_v4_events(sequence INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL, payload TEXT NOT NULL);
          CREATE TABLE IF NOT EXISTS sop_v4_requests(scope TEXT NOT NULL, request_id TEXT NOT NULL, input TEXT NOT NULL, response TEXT NOT NULL, PRIMARY KEY(scope,request_id));
        """)

    def rows(self, table, run_id=None):
        query = f"SELECT payload FROM sop_v4_{table}"
        args = ()
        if run_id:
            query += " WHERE run_id=?"
            args = (run_id,)
        return [json.loads(r[0]) for r in self.db.execute(query, args)]

    def get(self, table, key):
        row = self.db.execute(f"SELECT payload FROM sop_v4_{table} WHERE id=?", (key,)).fetchone()
        if not row:
            fail("SOP_RUN_NOT_FOUND", f"Unknown {table} id")
        return json.loads(row[0])

    def save(self, table, value):
        key = "scope" if table == "runs" else "run_id"
        self.db.execute(f"INSERT INTO sop_v4_{table}(id,{key},payload) VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET payload=excluded.payload",
                        (value["id"], value["scope"] if table == "runs" else value["runId"], json.dumps(value)))

    def event(self, run_id, kind, data):
        self.db.execute("INSERT INTO sop_v4_events(run_id,payload) VALUES (?,?)", (run_id, json.dumps({"type": kind, "at": self.now(), **data})))

    def scoped(self, run_id, scope):
        run = self.get("runs", run_id)
        if run["scope"] != scope:
            fail("SOP_RUN_FORBIDDEN", "Run belongs to a different project")
        return run

    def mutate(self, scope, request_id, payload, operation):
        if not isinstance(request_id, str) or not request_id:
            fail("SOP_V4_INVALID", "requestId is required")
        encoded = json.dumps(payload, sort_keys=True, allow_nan=False)
        with self.store.transaction():
            old = self.db.execute("SELECT input,response FROM sop_v4_requests WHERE scope=? AND request_id=?", (scope, request_id)).fetchone()
            if old:
                if old[0] != encoded:
                    fail("SOP_REQUEST_CONFLICT", "requestId was used with different input")
                return json.loads(old[1])
            response = operation()
            self.db.execute("INSERT INTO sop_v4_requests VALUES (?,?,?,?)", (scope, request_id, encoded, json.dumps(response)))
            return response

    def definitions(self, sop_id, version, path=(), result=None):
        result = {} if result is None else result
        if sop_id in path or len(path) >= 8:
            fail("INVALID_SOP_NESTING", "Recursive SOP or nesting exceeds 8 levels")
        definition = self.store.get(sop_id, version).content
        validate_definition(definition)
        result[f"{sop_id}@{version}"] = definition
        for node in definition["nodes"]:
            if node.get("subSop"):
                self.definitions(node["subSop"]["sopId"], node["subSop"]["version"], (*path, sop_id), result)
        return result

    def preflight(self, data):
        strict(data, {"sopId", "version"}, {"sopId", "version"})
        with self.store._lock:
            return {"definitions": list(self.definitions(text(data["sopId"]), text(data["version"])).values())}

    def start(self, scope, data):
        strict(data, {"requestId", "sopId", "version", "input", "items", "concurrency", "model"}, {"requestId", "sopId", "version"})
        if "input" in data and "items" in data:
            fail("SOP_V4_INVALID", "Choose input or items")
        text(scope)
        text(data["sopId"])
        text(data["version"])
        if "model" in data:
            model(data["model"])
        concurrency = positive(data.get("concurrency", min(8, self.maximum)), self.maximum)
        items = data.get("items", [{"itemKey": "single", "input": data.get("input", {})}])
        if not isinstance(items, list) or len(items) > 10000:
            fail("SOP_V4_INVALID", "items must be a list of at most 10000 items")
        keys = set()
        for item in items:
            strict(item, {"itemKey", "input"}, {"itemKey", "input"})
            if not isinstance(item["itemKey"], str) or not item["itemKey"] or item["itemKey"] in keys or not isinstance(item["input"], dict):
                fail("SOP_V4_INVALID", "Unique nonempty itemKey and object input required")
            keys.add(item["itemKey"])
        def create():
            definitions = self.definitions(data["sopId"], data["version"])
            run = {"id": uuid4().hex, "scope": scope, "status": "running", "concurrency": concurrency,
                   "definitions": definitions, "model": data.get("model"), "createdAt": self.now()}
            self.save("runs", run)
            for index, item in enumerate(items):
                self.execution(run, data["sopId"], data["version"], item["input"], item["itemKey"], index)
            self.refresh(run)
            self.event(run["id"], "run_created", {"total": len(items)})
            return {"runId": run["id"], "status": run["status"]}
        return self.mutate(scope, data["requestId"], data, create)

    def execution(self, run, sop_id, version, value, key, index, parent=None):
        definition = run["definitions"][f"{sop_id}@{version}"]
        execution = {"id": uuid4().hex, "runId": run["id"], "sopId": sop_id, "version": version, "input": deepcopy(value),
                     "itemKey": key, "index": index, "parentCallId": parent, "slots": {}, "handoffText": value.get("handoffText", ""),
                     "status": "running", "nodeId": definition["start_node_id"], "output": None, "nextInvocation": 0}
        self.save("executions", execution)
        self.enqueue(run, execution)
        return execution

    def node(self, run, execution):
        return next(n for n in run["definitions"][f"{execution['sopId']}@{execution['version']}"]["nodes"] if n["node_id"] == execution["nodeId"])

    def sources(self, execution, output=None):
        value = execution["input"]
        return {"originalQuery": value.get("originalQuery", ""), "latestUserMessage": value.get("latestUserMessage", value.get("originalQuery", "")),
                "handoffText": execution["handoffText"], "slots": execution["slots"], "item": value.get("item", value),
                "files": value.get("files", []), "attachments": value.get("attachments", value.get("files", [])), "history": value.get("history", []), "output": execution.get("output") if output is None else output}

    def enqueue(self, run, execution):
        if execution["nextInvocation"] >= 10000:
            fail("SOP_INVOCATION_LIMIT", "Execution exceeds 10000 node invocations")
        node = self.node(run, execution)
        config = node.get("input", {})
        sources = self.sources(execution)
        fields = mapping(config["fields"], sources) if "fields" in config else {k: sources[k] for k in ("originalQuery", "handoffText", "files")}
        if "fields" not in config and "item" in execution["input"]:
            fields.setdefault("item", sources["item"])
        execution["nextInvocation"] += 1
        call = {"id": uuid4().hex, "runId": run["id"], "executionId": execution["id"], "nodeId": node["node_id"],
                "invocation": execution["nextInvocation"], "attempt": 1, "status": "queued", "node": node, "input": fields,
                "history": sources["history"] if config.get("history", False) else [], "model": node.get("model") or run["model"],
                "template": config.get("template"), "parentCallId": execution["parentCallId"], "lease": None}
        call["allowedNextNodeIds"] = [e["next_node_id"] for e in outgoing(run["definitions"][f"{execution['sopId']}@{execution['version']}"], node["node_id"])]
        execution["callId"] = call["id"]
        self.save("executions", execution)
        self.save("calls", call)
        self.event(run["id"], "node_queued", {"callId": call["id"], "executionId": execution["id"], "nodeId": call["nodeId"]})
        if node.get("type") == "subflow":
            self.expand(run, execution, call, [{"itemKey": "subflow", "input": fields}], self.maximum)
        elif node.get("type") == "approval":
            call.update(status="waiting", waitId=uuid4().hex)
            self.save("calls", call)
            self.event(run["id"], "approval_wait", {"callId": call["id"], "waitId": call["waitId"], "assigneeUserId": node["assigneeUserId"]})

    def expand(self, run, execution, call, items, concurrency):
        call.update(status="waiting_children", childConcurrency=concurrency, childTotal=len(items))
        self.save("calls", call)
        for index, item in enumerate(items):
            value = deepcopy(item["input"]) if call["node"].get("type") == "subflow" else {**call["input"], **item["input"], "item": item["input"]}
            self.execution(run, call["node"]["subSop"]["sopId"], call["node"]["subSop"]["version"], value, item["itemKey"], index, call["id"])
        if not items:
            self.join(run, call)

    def ancestors(self, execution):
        result = []
        while execution["parentCallId"]:
            call = self.get("calls", execution["parentCallId"])
            result.append(call)
            execution = self.get("executions", call["executionId"])
        return result

    def claim(self, worker, limit=1):
        with self.store.transaction():
            running = []
            for call in self.rows("calls"):
                if call["status"] == "running":
                    if call["lease"]["until"] <= self.now():
                        call.update(status="result_unknown", error={"code": "SOP_LEASE_EXPIRED", "message": "Host result unknown; automatic replay forbidden"})
                        self.save("calls", call)
                        self.archive_attempt(call)
                        execution = self.get("executions", call["executionId"])
                        execution["status"] = "result_unknown"
                        self.save("executions", execution)
                        self.event(call["runId"], "result_unknown", {"callId": call["id"]})
                        self.bubble(self.get("runs", call["runId"]), execution)
                    else:
                        running.append(call)
            claimed = []
            for call in self.rows("calls"):
                if len(running) >= self.maximum or len(claimed) >= limit:
                    break
                if call["status"] != "queued":
                    continue
                run = self.get("runs", call["runId"])
                if run["status"] in TERMINAL:
                    continue
                same = [c for c in running if c["runId"] == run["id"]]
                if len(same) >= run["concurrency"]:
                    continue
                execution = self.get("executions", call["executionId"])
                ancestors = self.ancestors(execution)
                if any(sum(a["id"] in [p["id"] for p in self.ancestors(self.get("executions", c["executionId"]))] for c in same) >= a["childConcurrency"] for a in ancestors):
                    continue
                call.update(status="running", lease={"token": uuid4().hex, "worker": worker, "until": self.now() + 60})
                self.save("calls", call)
                self.event(run["id"], "node_started", {"callId": call["id"], "attempt": call["attempt"]})
                running.append(call)
                claimed.append({**call, "scope": run["scope"]})
            return claimed

    def leased(self, call_id, token):
        call = self.get("calls", call_id)
        if call["status"] != "running" or call["lease"]["token"] != token or call["lease"]["until"] <= self.now():
            fail("SOP_LEASE_STALE", "Call lease is no longer valid")
        return call

    def heartbeat(self, call_id, token):
        with self.store.transaction():
            call = self.leased(call_id, token)
            call["lease"]["until"] = self.now() + 60
            self.save("calls", call)
            return {"accepted": True}

    def submit(self, call_id, data):
        strict(data, {"requestId", "leaseToken", "status", "reply", "handoffText", "slotUpdates", "output", "nextNodeId", "foreach", "model", "usage", "error", "history"}, {"requestId", "leaseToken", "status"})
        def apply():
            call = self.leased(call_id, data["leaseToken"])
            run = self.get("runs", call["runId"])
            execution = self.get("executions", call["executionId"])
            if data["status"] not in {"completed", "failed", "result_unknown"}:
                fail("SOP_V4_INVALID", "Invalid node result status")
            if not isinstance(data.get("slotUpdates", {}), dict) or not isinstance(data.get("reply", ""), str) or not isinstance(data.get("handoffText", ""), str):
                fail("SOP_V4_INVALID", "Invalid slotUpdates or reply/handoffText")
            if "model" in data:
                model(data["model"])
            call.update(status=data["status"], result=data, model=data.get("model", call["model"]))
            call["error"] = data.get("error")
            self.save("calls", call)
            self.archive_attempt(call)
            execution["slots"].update(data.get("slotUpdates", {}))
            execution["handoffText"] = data.get("handoffText", data.get("reply", ""))
            execution["output"] = data.get("output")
            self.save("executions", execution)
            self.event(run["id"], "node_result", {"callId": call_id, "status": call["status"], "model": call["model"], "usage": data.get("usage")})
            if data["status"] != "completed":
                execution["status"] = data["status"]
                self.save("executions", execution)
                self.bubble(run, execution)
            elif call["node"].get("type") == "foreach":
                spec = strict(data.get("foreach"), {"items", "concurrency"}, {"concurrency"})
                items = spec.get("items")
                if items is None:
                    items = select(self.sources(execution), call["node"].get("items", "slots.items"))
                if not isinstance(items, list) or len(items) > 10000:
                    fail("SOP_V4_INVALID", "foreach items must be a list of at most 10000")
                keys = set()
                for item in items:
                    strict(item, {"itemKey", "input"}, {"itemKey", "input"})
                    if not isinstance(item["itemKey"], str) or not item["itemKey"] or item["itemKey"] in keys or not isinstance(item["input"], dict):
                        fail("SOP_V4_INVALID", "foreach requires unique itemKey and object input")
                    keys.add(item["itemKey"])
                call["nextNodeId"] = data.get("nextNodeId")
                self.expand(run, execution, call, items, positive(spec["concurrency"], self.maximum))
            else:
                self.advance(run, execution, data.get("nextNodeId"))
            return {"accepted": True}
        return self.mutate("call:" + call_id, data["requestId"], data, apply)

    def advance(self, run, execution, target=None):
        definition = run["definitions"][f"{execution['sopId']}@{execution['version']}"]
        allowed = [e["next_node_id"] for e in outgoing(definition, execution["nodeId"])]
        if target and target not in allowed:
            fail("INVALID_TRANSITION", "Target is not an allowed edge")
        target = target or default_next(definition, execution["nodeId"])
        if target:
            execution["nodeId"] = target
            self.save("executions", execution)
            self.enqueue(run, execution)
        elif is_terminal(definition, execution["nodeId"]):
            execution["status"] = "completed"
            self.save("executions", execution)
            self.bubble(run, execution)
        else:
            fail("NEXT_NODE_REQUIRED", "Conditional branches require nextNodeId")

    def archive_attempt(self, call):
        self.save("attempts", {**call, "id": f"{call['id']}:{call['attempt']}", "callId": call["id"]})

    def bubble(self, run, execution):
        if execution["parentCallId"]:
            self.join(run, self.get("calls", execution["parentCallId"]))
        self.refresh(run)

    def join(self, run, call):
        children = sorted([e for e in self.rows("executions", run["id"]) if e["parentCallId"] == call["id"]], key=lambda e: e["index"])
        if any(e["status"] not in TERMINAL for e in children):
            return
        execution = self.get("executions", call["executionId"])
        results = [{"itemKey": e["itemKey"], "status": e["status"], "output": e["output"], "slots": e["slots"], "handoffText": e["handoffText"]} for e in children]
        status = "result_unknown" if any(e["status"] == "result_unknown" for e in children) else "failed" if any(e["status"] != "completed" for e in children) else "completed"
        output = results[0] if call["node"].get("type") == "subflow" and results else results
        execution["slots"].update(mapping(call["node"].get("output", {}), self.sources(execution, output)))
        execution.update(output=output, handoffText=json.dumps(output, ensure_ascii=False))
        call.update(status=status, output=output)
        call["error"] = None if status == "completed" else {"code": "SOP_CHILD_FAILED", "message": "One or more child executions did not complete successfully"}
        self.save("calls", call)
        self.save("executions", execution)
        self.event(run["id"], "children_joined", {"callId": call["id"], "status": status})
        if status == "completed":
            self.advance(run, execution, call.get("nextNodeId"))
        else:
            execution["status"] = status
            self.save("executions", execution)
            self.bubble(run, execution)

    def refresh(self, run):
        roots = [e for e in self.rows("executions", run["id"]) if not e["parentCallId"]]
        if run["status"] == "cancelled":
            return
        status = "running"
        if all(e["status"] in TERMINAL for e in roots):
            status = "result_unknown" if any(e["status"] == "result_unknown" for e in roots) else "failed" if any(e["status"] != "completed" for e in roots) else "completed"
        if status != run["status"]:
            self.event(run["id"], "run_status", {"status": status})
        run["status"] = status
        self.save("runs", run)

    def status(self, scope, run_id, offset=0, limit=100):
        with self.store._lock:
            run = self.scoped(run_id, scope)
            executions = self.rows("executions", run_id)
            calls = self.rows("calls", run_id)
            attempts = self.rows("attempts", run_id)
            roots = [e for e in executions if not e["parentCallId"]]
            return {"runId": run_id, "status": run["status"], "concurrency": run["concurrency"], "total": len(roots),
                    "counts": {s: sum(e["status"] == s for e in roots) for s in ["running", *sorted(TERMINAL)]},
                    "resultRef": f"/v4/runs/{run_id}/results",
                    "attempts": [{k: a.get(k) for k in ("id", "callId", "attempt", "status", "model", "error")} for a in attempts[offset:offset + limit]],
                    "calls": [{**{k: c.get(k) for k in ("id", "executionId", "parentCallId", "nodeId", "invocation", "attempt", "status", "model", "error", "waitId")},
                               "itemKey": next(e["itemKey"] for e in executions if e["id"] == c["executionId"]),
                               "usage": c.get("result", {}).get("usage")} for c in calls[offset:offset + limit]],
                    "nextOffset": offset + limit if max(len(calls), len(attempts)) > offset + limit else None}

    def results(self, scope, run_id, offset=0, limit=100):
        with self.store._lock:
            self.scoped(run_id, scope)
            roots = sorted([e for e in self.rows("executions", run_id) if not e["parentCallId"]], key=lambda e: e["index"])
            return {"runId": run_id, "items": [{k: e.get(k) for k in ("id", "itemKey", "status", "output", "slots", "handoffText")} for e in roots[offset:offset + limit]],
                    "nextOffset": offset + limit if len(roots) > offset + limit else None}

    def events(self, scope, run_id, after=0, limit=100):
        with self.store._lock:
            self.scoped(run_id, scope)
            rows = self.db.execute("SELECT sequence,payload FROM sop_v4_events WHERE run_id=? AND sequence>? ORDER BY sequence LIMIT ?", (run_id, after, limit)).fetchall()
            return [{"sequence": r[0], **json.loads(r[1])} for r in rows]

    def cancel(self, scope, run_id, data):
        strict(data, {"requestId"}, {"requestId"})
        def apply():
            run = self.scoped(run_id, scope)
            if run["status"] not in TERMINAL:
                run["status"] = "cancelled"
                self.save("runs", run)
                for table in ("calls", "executions"):
                    for row in self.rows(table, run_id):
                        if row["status"] not in TERMINAL:
                            row["status"] = "cancelled"
                            self.save(table, row)
                            if table == "calls" and row.get("lease"):
                                self.archive_attempt(row)
                self.event(run_id, "run_cancelled", {})
            return {"runId": run_id, "status": run["status"]}
        return self.mutate(scope, data["requestId"], {"runId": run_id, "operation": "cancel", **data}, apply)

    def retry(self, scope, run_id, data):
        strict(data, {"requestId", "callIds"}, {"requestId", "callIds"})
        if not isinstance(data["callIds"], list) or not data["callIds"] or any(not isinstance(c, str) for c in data["callIds"]) or len(set(data["callIds"])) != len(data["callIds"]):
            fail("SOP_V4_INVALID", "callIds must be a nonempty unique string array")
        def apply():
            run = self.scoped(run_id, scope)
            if run["status"] == "cancelled":
                fail("SOP_RETRY_INVALID", "Cancelled runs cannot be retried")
            for call_id in data["callIds"]:
                call = self.get("calls", call_id)
                if call["runId"] != run_id or call["status"] != "failed" or call.get("node", {}).get("type") in {"subflow", "foreach"}:
                    fail("SOP_RETRY_INVALID", "Select failed leaf calls only; unknown outcomes cannot be retried")
                self.event(run_id, "attempt_archived", {"callId": call_id, "attempt": call["attempt"], "result": call.get("result")})
                call.update(attempt=call["attempt"] + 1, status="queued", lease=None)
                call.pop("result", None)
                call.pop("error", None)
                self.save("calls", call)
                execution = self.get("executions", call["executionId"])
                execution["status"] = "running"
                self.save("executions", execution)
                for parent in self.ancestors(execution):
                    parent["status"] = "waiting_children"
                    self.save("calls", parent)
                    ancestor = self.get("executions", parent["executionId"])
                    ancestor["status"] = "running"
                    self.save("executions", ancestor)
            self.refresh(run)
            return {"runId": run_id, "retried": data["callIds"]}
        return self.mutate(scope, data["requestId"], {"runId": run_id, "operation": "retry", **data}, apply)

    def resume(self, scope, run_id, data):
        strict(data, {"requestId", "callId", "waitId", "message", "subjectUserId"}, {"requestId", "callId", "waitId", "message", "subjectUserId"})
        def apply():
            run = self.scoped(run_id, scope)
            call = self.get("calls", data["callId"])
            if call["runId"] != run_id or call["status"] != "waiting" or call["waitId"] != data["waitId"]:
                fail("SOP_WAIT_CONFLICT", "Approval is no longer waiting")
            if call["node"]["assigneeUserId"] != data["subjectUserId"]:
                fail("SOP_APPROVAL_FORBIDDEN", "Approval subject differs from pinned assignee")
            call.update(status="queued", approvalResponse=data["message"])
            self.save("calls", call)
            self.event(run_id, "approval_resumed", {"callId": call["id"]})
            return {"accepted": True}
        return self.mutate(scope, data["requestId"], {"runId": run_id, "operation": "resume", **data}, apply)
