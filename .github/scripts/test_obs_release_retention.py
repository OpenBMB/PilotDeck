from datetime import datetime, timezone
import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location("retention", Path(__file__).with_name("obs_release_retention.py"))
retention = importlib.util.module_from_spec(spec)
spec.loader.exec_module(retention)


def objects(*dates):
    return [{"Key": f"PilotDeck/v{day.replace('-', '.')}/installer.exe", "Size": 42,
             "LastModified": day + "T00:00:00Z"} for day in dates]


class RetentionTests(unittest.TestCase):
    now = datetime(2026, 10, 20, tzinfo=timezone.utc)

    def test_retains_recent_three_and_latest(self):
        data = objects("2026-10-20", "2026-10-19", "2026-10-18", "2026-09-20", "2026-09-19", "2026-08-01")
        report = retention.plan(data, "v2026.08.01", self.now)
        self.assertEqual([g["tag"] for g in report["remove"]], ["v2026.09.19"])
        self.assertEqual(report["remove_bytes"], 42)

    def test_keeps_three_even_when_all_old(self):
        report = retention.plan(objects("2026-07-01", "2026-06-01", "2026-05-01", "2026-04-01"),
                                "v2026.07.01", self.now)
        self.assertEqual(len(report["keep"]), 3)
        self.assertEqual(report["remove"][0]["tag"], "v2026.04.01")

    def test_recent_object_protects_entire_old_release(self):
        data = objects("2026-10-20", "2026-10-19", "2026-10-18", "2026-01-01")
        data.append({"Key": "PilotDeck/v2026.01.01/release.json", "Size": 8,
                     "LastModified": "2026-10-19T00:00:00Z"})
        report = retention.plan(data, "v2026.10.20", self.now)
        self.assertEqual(report["remove"], [])

    def test_unrelated_keys_never_targeted(self):
        data = objects("2026-10-20", "2026-10-19", "2026-10-18", "2026-01-01")
        for key in ("PilotDeck/latest.json", "PilotDeck/_debug/v2026.01.01/1/app.exe",
                    "PilotDeck/legacy/app.exe", "log/access.log", "PilotDeck/v2026.01.01/nested/file"):
            data.append({"Key": key, "Size": 1, "LastModified": "2026-01-01T00:00:00Z"})
        report = retention.plan(data, "v2026.10.20", self.now)
        self.assertEqual(report["remove"][0]["objects"], [{"key": "PilotDeck/v2026.01.01/installer.exe", "bytes": 42}])

    def test_missing_latest_duplicate_or_invalid_date_fails(self):
        data = objects("2026-10-20")
        for listing, latest in ((data, "v2026.01.01"), (data * 2, "v2026.10.20"),
                                (objects("2026-99-99"), "v2026.99.99")):
            with self.assertRaises((RuntimeError, ValueError)):
                retention.plan(listing, latest, self.now)

    def test_apply_checks_latest_and_deletion_response(self):
        report = retention.plan(objects("2026-10-20", "2026-10-19", "2026-10-18", "2026-01-01"),
                                "v2026.10.20", self.now)
        class Client:
            changed, failed, calls = False, False, 0
            def latest(self):
                return "v2026.10.21" if self.changed else "v2026.10.20"
            def call(self, *args):
                self.calls += 1
                return {"Errors": [{"Code": "AccessDenied"}]} if self.failed else {
                    "Deleted": [{"Key": "PilotDeck/v2026.01.01/installer.exe"}]}
        client = Client()
        retention.execute(client, report)
        self.assertEqual(client.calls, 1)
        client.changed = True
        with self.assertRaisesRegex(RuntimeError, "Latest changed"):
            retention.execute(client, report)
        self.assertEqual(client.calls, 1)
        client.changed, client.failed = False, True
        with self.assertRaisesRegex(RuntimeError, "confirm"):
            retention.execute(client, report)


if __name__ == "__main__":
    unittest.main()
