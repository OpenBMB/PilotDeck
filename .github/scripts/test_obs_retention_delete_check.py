import json
from pathlib import Path
import tempfile
import unittest
from unittest.mock import Mock

import obs_retention_delete_check as check
import obs_release_retention as retention


class FakeClient:
    def __init__(self, mode="success"):
        self.mode = mode
        self.objects = {}
        self.deleted = []

    def call(self, *args):
        operation = args[1]
        if operation == "list-objects-v2":
            return {"Contents": [{"Key": key, "Size": size} for key, size in self.objects.items()]}
        if operation == "put-object":
            self.objects[args[args.index("--key") + 1]] = Path(args[args.index("--body") + 1]).stat().st_size
            return {}
        if operation == "delete-objects":
            self.deleted = [item["Key"] for item in json.loads(args[args.index("--delete") + 1])["Objects"]]
            if self.mode == "denied":
                raise RuntimeError("OBS retention operation failed: AccessDenied")
            if self.mode == "partial":
                del self.objects[self.deleted[0]]
                return {"Deleted": [{"Key": self.deleted[0]}],
                        "Errors": [{"Key": self.deleted[1], "Code": "AccessDenied"}]}
            if self.mode != "residual":
                self.objects.clear()
            return {"Deleted": [{"Key": key} for key in self.deleted]}
        raise AssertionError(operation)


class DeleteCheckTests(unittest.TestCase):
    def run_check(self, client, report):
        with tempfile.TemporaryDirectory() as directory:
            check.check(client, "1234", directory, report)

    def test_success_confirms_and_removes_exact_two_test_objects(self):
        client, report = FakeClient(), {}
        self.run_check(client, report)
        self.assertEqual(report["result"], "passed")
        self.assertEqual(report["remaining_keys"], [])
        self.assertEqual(len(report["confirmed_objects"]), 2)
        self.assertEqual(client.deleted, report["keys"])
        self.assertTrue(all(key.startswith("PilotDeck/_debug/retention-delete/1234/") for key in client.deleted))

    def test_denied_partial_and_residual_fail_with_residual_inventory(self):
        for mode, message, remaining in (("denied", "AccessDenied", 2),
                                         ("partial", "confirm.*AccessDenied", 1),
                                         ("residual", "remain", 2)):
            with self.subTest(mode=mode):
                report = {}
                with self.assertRaisesRegex(RuntimeError, message):
                    self.run_check(FakeClient(mode), report)
                self.assertEqual(report["result"], "failed")
                self.assertEqual(len(report["remaining_keys"]), remaining)

    def test_existing_prefix_is_not_overwritten_or_deleted(self):
        client = FakeClient()
        client.objects["PilotDeck/_debug/retention-delete/1234/existing.txt"] = 1
        with self.assertRaisesRegex(RuntimeError, "already contains"):
            self.run_check(client, {})
        self.assertEqual(client.deleted, [])
        self.assertEqual(len(client.objects), 1)

    def test_invalid_run_id_makes_no_request(self):
        client = FakeClient()
        with self.assertRaisesRegex(RuntimeError, "numeric"):
            check.check(client, "../latest.json", "/tmp", {})
        self.assertEqual(client.objects, {})

    def test_shared_batch_requires_exact_response(self):
        for response in ({"Deleted": []}, {"Deleted": [{"Key": "a"}, {"Key": "a"}]},
                         {"Deleted": [{"Key": "a"}, {"Key": "other"}]}):
            client = Mock()
            client.call.return_value = response
            with self.assertRaisesRegex(RuntimeError, "confirm"):
                retention.delete_batch(client, ["a", "b"])

    def test_production_executor_still_rejects_debug_keys(self):
        client = Mock()
        client.latest.return_value = "v2026.10.20"
        report = {"latest_tag": "v2026.10.20", "remove": [{"objects": [
            {"key": "PilotDeck/_debug/retention-delete/1234/first.txt"}]}]}
        with self.assertRaisesRegex(RuntimeError, "Invalid cleanup target"):
            retention.execute(client, report)
        client.call.assert_not_called()


if __name__ == "__main__":
    unittest.main()
