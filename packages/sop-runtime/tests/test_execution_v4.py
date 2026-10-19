import tempfile
import unittest
from pathlib import Path

from staffdeck_sop_core import SopCoreError, SopDefinition
from staffdeck_sop_runtime.execution_v4 import ExecutionService, validate_definition
from staffdeck_sop_runtime.storage import SqliteStore


def definition(name, nodes=None, edges=None):
    nodes = nodes or [{"node_id": "work"}]
    return {"schema": "sop.definition/v4", "skill_id": name, "version": "1", "start_node_id": nodes[0]["node_id"],
            "terminal_node_ids": [nodes[-1]["node_id"]], "nodes": nodes, "edges": edges or []}


class ExecutionTests(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.TemporaryDirectory()
        self.path = Path(self.tmp.name) / "runtime.sqlite"
        self.store = SqliteStore(self.path)
        self.clock = [1000.0]
        self.service = ExecutionService(self.store, 32, lambda: self.clock[0])
        self.publish(definition("leaf"))
        self.seq = 0

    def tearDown(self):
        self.store.close()
        self.tmp.cleanup()

    def publish(self, value):
        validate_definition(value)
        self.store.put(SopDefinition.from_value(value))

    def start(self, **values):
        return self.service.start("project", {"requestId": "start", "sopId": "leaf", "version": "1", **values})["runId"]

    def finish(self, call, **values):
        self.seq += 1
        data = {"requestId": str(self.seq), "leaseToken": call["lease"]["token"], "status": "completed", "reply": "done", **values}
        return self.service.submit(call["id"], data)

    def test_1000_items_restart_pagination_events_and_global_limit(self):
        items = [{"itemKey": str(i), "input": {"originalQuery": "query", "files": [str(i)]}} for i in range(1000)]
        run = self.start(items=items, concurrency=16)
        self.assertEqual(run, self.start(items=items, concurrency=16))
        peak, complete, failed = 0, 0, None
        while complete < 1000:
            calls = self.service.claim("host", 32)
            peak = max(peak, len(calls))
            self.assertEqual(self.service.claim("host", 32), [])
            for call in calls:
                if complete == 499:
                    failed = call
                    self.finish(call, status="failed", error={"code": "INJECTED_500TH_FAILURE"})
                else:
                    self.finish(call, output={"file": call["input"]["files"][0]})
                complete += 1
            if complete == 16:
                self.store.close()
                self.store = SqliteStore(self.path)
                self.service = ExecutionService(self.store, 32, lambda: self.clock[0])
        self.assertEqual(peak, 16)
        self.assertEqual(self.service.status("project", run)["status"], "failed")
        self.service.retry("project", run, {"requestId": "retry-500", "callIds": [failed["id"]]})
        retry = self.service.claim("host")[0]
        self.assertEqual(retry["attempt"], 2)
        self.finish(retry, output={"file": retry["input"]["files"][0]})
        self.assertEqual(self.service.status("project", run)["status"], "completed")
        self.assertEqual(len(self.service.results("project", run)["items"]), 100)
        self.assertEqual(self.service.results("project", run, 999)["items"][0]["itemKey"], "999")
        events = self.service.events("project", run)
        later = self.service.events("project", run, events[-1]["sequence"])
        self.assertTrue(later[0]["sequence"] > events[-1]["sequence"])

    def test_nested_foreach_isolated_inputs_join_and_retry(self):
        self.publish(definition("parent", [{"node_id": "each", "type": "foreach", "subSop": {"sopId": "leaf", "version": "1"},
                                                   "output": {"results": {"source": "output"}}}]))
        run = self.start(sopId="parent", input={"originalQuery": "research", "attachments": ["SECRET"], "history": ["SECRET"]})
        parent = self.service.claim("host")[0]
        self.assertNotIn("attachments", parent["input"])
        self.assertEqual(parent["history"], [])
        self.finish(parent, foreach={"items": [{"itemKey": k, "input": {"name": k}} for k in ("a", "b", "c")], "concurrency": 2})
        calls = self.service.claim("host", 32)
        self.assertEqual(len(calls), 2)
        self.assertNotEqual(calls[0]["executionId"], calls[1]["executionId"])
        self.finish(calls[0], status="failed", error={"code": "FIXTURE"})
        self.finish(calls[1], output="b")
        self.finish(self.service.claim("host")[0], output="c")
        self.assertEqual(self.service.status("project", run)["status"], "failed")
        self.service.retry("project", run, {"requestId": "retry", "callIds": [calls[0]["id"]]})
        retry = self.service.claim("host")[0]
        self.assertEqual(retry["attempt"], 2)
        self.finish(retry, output="a")
        self.assertEqual(self.service.status("project", run)["status"], "completed")
        self.assertEqual([x["output"] for x in self.service.results("project", run)["items"][0]["output"]], ["a", "b", "c"])

    def test_unknown_lease_no_replay_cancel_and_scope(self):
        run = self.start(items=[{"itemKey": str(i), "input": {}} for i in range(2)], concurrency=1)
        call = self.service.claim("host")[0]
        self.clock[0] += 61
        next_call = self.service.claim("new-host")[0]
        self.assertNotEqual(call["id"], next_call["id"])
        with self.assertRaises(SopCoreError):
            self.finish(call)
        with self.assertRaises(SopCoreError):
            self.service.retry("project", run, {"requestId": "bad-retry", "callIds": [call["id"]]})
        with self.assertRaises(SopCoreError):
            self.service.status("other-project", run)
        self.service.cancel("project", run, {"requestId": "cancel"})
        self.assertEqual(self.service.claim("host"), [])
        self.assertEqual(self.service.status("project", run)["status"], "cancelled")

    def test_subflow_mapping_handoff_node_identity_and_model(self):
        self.publish(definition("parent", [{"node_id": "sub", "type": "subflow", "subSop": {"sopId": "leaf", "version": "1"},
           "input": {"fields": {"originalQuery": {"value": "child only"}}}, "output": {"child": {"source": "output", "path": "output"}}},
           {"node_id": "done", "model": {"provider": "small", "model": "fast"}}], [{"source_node_id": "sub", "next_node_id": "done"}]))
        run = self.start(sopId="parent", input={"originalQuery": "parent secret"})
        child = self.service.claim("host")[0]
        self.assertEqual(child["input"]["originalQuery"], "child only")
        self.finish(child, output={"amount": 3}, handoffText="child summary")
        done = self.service.claim("host")[0]
        self.assertEqual(done["model"], {"provider": "small", "model": "fast"})
        self.assertIn("child summary", done["input"]["handoffText"])
        self.finish(done, output="ok")
        self.assertEqual(self.service.results("project", run)["items"][0]["slots"], {"child": {"amount": 3}})

    def test_approval_empty_foreach_and_strict_config(self):
        self.publish(definition("approval", [{"node_id": "approve", "type": "approval", "assigneeUserId": "owner"}]))
        run = self.start(sopId="approval")
        self.assertEqual(self.service.claim("host"), [])
        call = self.service.rows("calls", run)[0]
        value = {"requestId": "resume", "callId": call["id"], "waitId": call["waitId"], "message": "approved", "subjectUserId": "other"}
        with self.assertRaises(SopCoreError):
            self.service.resume("project", run, value)
        self.service.resume("project", run, {**value, "subjectUserId": "owner"})
        self.finish(self.service.claim("host")[0])
        self.assertEqual(self.service.status("project", run)["status"], "completed")
        with self.assertRaises(SopCoreError):
            validate_definition(definition("old", [{"node_id": "work", "contextMode": "inherit"}]))
        with self.assertRaises(SopCoreError):
            self.start(requestId="invalid", concurrency=33)

    def test_global_quota_empty_lists_recursion_and_duplicate_submit(self):
        first = self.start(items=[{"itemKey": str(i), "input": {}} for i in range(40)], concurrency=32)
        self.start(requestId="second", concurrency=32)
        calls = self.service.claim("host", 100)
        self.assertEqual(len(calls), 32)
        call = calls[0]
        data = {"requestId": "commit", "leaseToken": call["lease"]["token"], "status": "completed"}
        self.assertEqual(self.service.submit(call["id"], data), self.service.submit(call["id"], data))
        self.assertEqual(len(self.service.claim("host", 100)), 1)
        self.service.cancel("project", first, {"requestId": "cancel-first"})
        empty = self.start(requestId="empty", items=[])
        self.assertEqual(self.service.status("project", empty)["status"], "completed")
        self.publish(definition("recursive", [{"node_id": "sub", "type": "subflow", "subSop": {"sopId": "recursive", "version": "1"}}]))
        with self.assertRaises(SopCoreError):
            self.start(requestId="recursive", sopId="recursive")

    def test_explicit_inputs_original_history_slots_and_loop_identity(self):
        self.publish(definition("inputs", [{"node_id": "first"}, {"node_id": "second", "input": {
            "fields": {"query": {"source": "originalQuery"}, "latest": {"source": "latestUserMessage"},
                       "summary": {"source": "handoffText"}, "selected": {"source": "slots", "path": "answer"},
                       "inline": {"source": "attachments"}}, "history": True, "template": "{{query}} {{summary}}"}}],
            [{"source_node_id": "first", "next_node_id": "second"}, {"source_node_id": "second", "next_node_id": "first"}]))
        run = self.start(sopId="inputs", input={"originalQuery": "original", "latestUserMessage": "latest",
            "history": [{"role": "user", "content": []}], "files": ["ref"], "attachments": ["secret"]})
        first = self.service.claim("host")[0]
        self.assertEqual(set(first["input"]), {"originalQuery", "handoffText", "files"})
        self.assertEqual(first["history"], [])
        self.finish(first, handoffText="summary", slotUpdates={"answer": 42}, history=["node-only-history"])
        second = self.service.claim("host")[0]
        self.assertEqual(second["input"], {"query": "original", "latest": "latest", "summary": "summary", "selected": 42,
                                         "inline": {"sopInlineAttachments": ["secret"]}})
        self.assertEqual(second["history"], [{"role": "user", "content": []}])
        self.finish(second)
        revisit = self.service.claim("host")[0]
        self.assertNotEqual(revisit["id"], first["id"])
        self.assertEqual(revisit["invocation"], 3)
        self.service.cancel("project", run, {"requestId": "cancel-loop"})

    def test_nested_empty_foreach_and_transaction_rollback(self):
        self.publish(definition("empty-parent", [{"node_id": "each", "type": "foreach", "subSop": {"sopId": "leaf", "version": "1"}}]))
        run = self.start(sopId="empty-parent")
        call = self.service.claim("host")[0]
        before = self.service.events("project", run)
        with self.assertRaises(SopCoreError):
            self.finish(call, foreach={"items": [], "concurrency": 33})
        self.assertEqual(self.service.events("project", run), before)
        self.assertEqual(self.service.get("calls", call["id"])["status"], "running")
        self.finish(call, foreach={"items": [], "concurrency": 1})
        self.assertEqual(self.service.status("project", run)["status"], "completed")

    def test_depth_limit_cancel_nested_and_retry_request_idempotency(self):
        for i in range(8):
            child = "leaf" if i == 0 else f"depth-{i - 1}"
            self.publish(definition(f"depth-{i}", [{"node_id": "sub", "type": "subflow", "subSop": {"sopId": child, "version": "1"}}]))
        run = self.start(sopId="depth-6")
        self.assertEqual(len(self.service.rows("executions", run)), 8)
        with self.assertRaises(SopCoreError):
            self.start(requestId="too-deep", sopId="depth-7")
        call = self.service.claim("host")[0]
        self.service.cancel("project", run, {"requestId": "cancel"})
        self.service.cancel("project", run, {"requestId": "cancel"})
        self.assertTrue(all(c["status"] == "cancelled" for c in self.service.rows("calls", run)))
        with self.assertRaises(SopCoreError):
            self.finish(call)
        failed_run = self.start(requestId="failed")
        failed = self.service.claim("host")[0]
        self.finish(failed, status="failed")
        data = {"requestId": "retry", "callIds": [failed["id"]]}
        self.assertEqual(self.service.retry("project", failed_run, data), self.service.retry("project", failed_run, data))
        self.assertEqual(self.service.get("calls", failed["id"])["attempt"], 2)

    def test_subflow_does_not_serialize_nested_foreach(self):
        self.publish(definition("each", [{"node_id": "each", "type": "foreach", "subSop": {"sopId": "leaf", "version": "1"}}]))
        self.publish(definition("wrapper", [{"node_id": "sub", "type": "subflow", "subSop": {"sopId": "each", "version": "1"}}]))
        run = self.start(sopId="wrapper")
        planning = self.service.claim("host")[0]
        self.finish(planning, foreach={"items": [{"itemKey": str(i), "input": {}} for i in range(3)], "concurrency": 3})
        self.assertEqual(len(self.service.claim("host", 32)), 3)
        self.service.cancel("project", run, {"requestId": "cancel"})


if __name__ == "__main__":
    unittest.main()
