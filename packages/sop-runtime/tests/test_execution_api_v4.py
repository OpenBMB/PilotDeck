import tempfile
import unittest
from pathlib import Path

from fastapi.testclient import TestClient
from staffdeck_sop_runtime.execution_api_v4 import create_app


class ExecutionApiTests(unittest.TestCase):
    def test_authenticated_restart_approval_events_and_last_event_id(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "fresh.sqlite"
            headers = {"authorization": "Bearer host-test", "x-sop-scope": "/project"}
            with TestClient(create_app(path, "host-test")) as client:
                self.assertEqual(client.get("/healthz").json()["contract"], "sop.lifecycle/v4")
                self.assertEqual(client.get("/v4/ready").status_code, 401)
                self.assertEqual(client.get("/v4/ready", headers=headers).json()["status"], "ok")
                self.assertEqual(client.post("/v4/runs", json={}).status_code, 401)
                definition = {"schema": "sop.definition/v4", "skill_id": "approval", "version": "1", "start_node_id": "approve",
                              "nodes": [{"node_id": "approve", "type": "approval", "assigneeUserId": "owner"}], "edges": []}
                self.assertEqual(client.post("/v4/definitions", json=definition, headers=headers).status_code, 200)
                run = client.post("/v4/runs", json={"requestId": "create", "sopId": "approval", "version": "1"}, headers=headers).json()["runId"]
                status = client.get(f"/v4/runs/{run}", headers=headers).json()
                call = status["calls"][0]
                sequence = client.get(f"/v4/runs/{run}/events", headers=headers).json()["nextSequence"]
                self.assertEqual(client.post("/v4/worker/claim", json={"workerId": "host"}, headers=headers).json()["calls"], [])
            with TestClient(create_app(path, "host-test")) as client:
                data = {"requestId": "resume", "callId": call["id"], "waitId": call["waitId"], "message": "yes", "subjectUserId": "other"}
                self.assertEqual(client.post(f"/v4/runs/{run}/resume", json=data, headers=headers).status_code, 422)
                data["subjectUserId"] = "owner"
                response = client.post(f"/v4/runs/{run}/resume", json=data, headers=headers)
                self.assertEqual(response.status_code, 200)
                self.assertEqual(client.post(f"/v4/runs/{run}/resume", json=data, headers=headers).json(), response.json())
                lease = client.post("/v4/worker/claim", json={"workerId": "restarted-host"}, headers=headers).json()["calls"][0]
                self.assertEqual(lease["id"], call["id"])
                result = {"requestId": "finish", "leaseToken": lease["lease"]["token"], "status": "completed", "output": {"approved": True}}
                self.assertEqual(client.post(f"/v4/calls/{call['id']}/submit", json=result, headers=headers).status_code, 200)
                events = client.get(f"/v4/runs/{run}/events?stream=true", headers={**headers, "last-event-id": str(sequence)}).text
                self.assertIn("approval_resumed", events)
                self.assertIn("node_result", events)
                self.assertNotIn("run_created", events)
                self.assertEqual(client.get(f"/v4/runs/{run}", headers=headers).json()["status"], "completed")


if __name__ == "__main__":
    unittest.main()
