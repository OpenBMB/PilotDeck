from contextlib import redirect_stdout
from datetime import datetime, timedelta, timezone
import hashlib
import io
import json
import os
import subprocess
from pathlib import Path
import tempfile
import time
import unittest
from unittest.mock import patch

import release_to_obs as production
from obs_sync_debug import AWS, OperationFailure


class FakeAWS:
    def __init__(self, files, failure=None, corrupt=False):
        self.files = files
        self.failure, self.corrupt = failure, corrupt
        self.deadline = time.monotonic() + 60
        self.calls = []
        self.latest = json.dumps({"tag": "v2026.10.17", "assets": [{"name": "old.exe"}]}).encode()

    def run(self, stage, args, **kwargs):
        self.calls.append(stage)
        if stage == self.failure:
            raise OperationFailure(stage, "timeout")
        if stage == "backup-latest":
            Path(args[3]).write_bytes(self.latest)
        if stage == 'list-existing':
            return b'{}'
        if stage == "list":
            prefix = args[args.index("--prefix") + 1]
            return json.dumps({"Contents": [{"Key": prefix + name, "Size": len(data)}
                                            for name, data in self.files.items()]}).encode()
        if stage == "publish-latest":
            self.latest = kwargs["stdin"].read()
            if self.corrupt:
                self.latest = b"X" * len(self.latest)
        if stage == "readback":
            key = args[2].removeprefix(f"s3://{production.BUCKET}/")
            data = self.latest if key == production.LATEST else self.files[key.rsplit("/", 1)[-1]]
            Path(args[3]).write_bytes(data)
        return b""


class ProductionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.previous = Path.cwd()
        os.chdir(self.temp.name)
        self.files = {"installer.exe": b"installer"}
        self.hashes = {name: hashlib.sha256(data).hexdigest() for name, data in self.files.items()}
        self.release = {"tag_name": "v2026.10.20-r2", "published_at": "2026-10-20T00:00:00Z",
                        "assets": [{"name": name, "size": len(data)} for name, data in self.files.items()]}
        self.output = redirect_stdout(io.StringIO())
        self.output.__enter__()

    def tearDown(self):
        self.output.__exit__(None, None, None)
        os.chdir(self.previous)
        self.temp.cleanup()

    def test_website_schema_normal_and_revised_tags(self):
        for tag in ("v2026.10.20", "v2026.10.20-r2", "v2026.10.20-r10"):
            self.release["tag_name"] = tag
            result = production.website_manifest(self.release)
            self.assertEqual(set(result), {"tag", "published_at", "assets"})
            self.assertEqual(result["assets"][0], {"name": "installer.exe", "size": 9,
                "url": f"https://{production.BUCKET}.obs.cn-north-4.myhuaweicloud.com/PilotDeck/{tag}/installer.exe"})
        for tag in ("v2026.99.99-r2", "v2026.10.20/../", "v2026.10.20-r0"):
            self.release["tag_name"] = tag
            with self.assertRaises((RuntimeError, ValueError)):
                production.release_prefix(self.release)

    def test_publish_and_repeat_preserves_backup_and_overwrites_pointer(self):
        aws = FakeAWS(self.files)
        original = aws.latest
        production.publish(aws, self.release, Path("assets"), self.hashes)
        self.assertEqual(Path("previous-latest.json").read_bytes(), original)
        self.assertEqual(json.loads(aws.latest), production.website_manifest(self.release))
        production.publish(aws, self.release, Path("assets"), self.hashes)
        self.assertEqual(aws.calls.count("publish-latest"), 2)
        self.assertNotIn("delete", " ".join(aws.calls))

    def test_failure_before_publish_keeps_original_pointer(self):
        for stage in ("backup-latest", "upload", "list", "readback"):
            aws = FakeAWS(self.files, failure=stage)
            original = aws.latest
            with self.assertRaises(RuntimeError):
                production.publish(aws, self.release, Path("assets"), self.hashes)
            self.assertNotIn("publish-latest", aws.calls)
            self.assertEqual(aws.latest, original)

    def test_listing_or_content_mismatch_does_not_publish(self):
        for files in ({"other.exe": b"installer"}, {"installer.exe": b"corrupted"}):
            aws = FakeAWS(files)
            with self.assertRaises(RuntimeError):
                production.publish(aws, self.release, Path("assets"), self.hashes)
            self.assertNotIn("publish-latest", aws.calls)

    def test_publication_or_readback_corruption_fails_with_saved_backup(self):
        for failure, corrupt in (("publish-latest", False), (None, True)):
            aws = FakeAWS(self.files, failure=failure, corrupt=corrupt)
            original = aws.latest
            with self.assertRaises(RuntimeError):
                production.publish(aws, self.release, Path("assets"), self.hashes)
            self.assertEqual(Path("previous-latest.json").read_bytes(), original)
            self.assertIn("latest-publication-unconfirmed", self.output._new_target.getvalue())

    def test_latest_readback_timeout_is_not_success(self):
        aws = FakeAWS(self.files)
        call = aws.run
        def run(stage, args, **kwargs):
            if stage == "readback" and kwargs.get("file") == "latest.json":
                raise OperationFailure(stage, "timeout")
            return call(stage, args, **kwargs)
        with patch.object(aws, "run", side_effect=run), self.assertRaises(OperationFailure):
            production.publish(aws, self.release, Path("assets"), self.hashes)
        self.assertIn("publish-latest", aws.calls)
        self.assertTrue(Path("previous-latest.json").exists())

    def test_production_budget_expiration_and_missing_token(self):
        for remaining, expected in ((60, 3000), (6, 240)):
            auth = {"expiration": (datetime.now(timezone.utc) + timedelta(minutes=remaining)).isoformat(),
                    "access_key_id": "test", "secret_access_key": "test", "security_token": "test"}
            started = time.monotonic()
            aws = AWS(auth, minutes=50)
            self.assertAlmostEqual(aws.deadline - started, expected, delta=1)
            aws.deadline = started - 1
            with self.assertRaises(OperationFailure), patch("subprocess.Popen") as popen:
                aws.run("upload", [])
            popen.assert_not_called()
        with self.assertRaises(RuntimeError):
            production.credentials("", "n00069-minicpm-5-0-pilotdeck")

    def test_incomplete_release_is_rejected_before_requesting_credentials(self):
        Path('resolved-release.json').write_text(json.dumps(self.release))
        Path('release-assets').mkdir()
        Path('release-assets/installer.exe').write_bytes(b'installer')
        with patch.object(production, 'credentials') as broker, self.assertRaises(subprocess.CalledProcessError):
            production.main()
        broker.assert_not_called()

    def test_delayed_sync_cannot_roll_back_a_newer_pointer(self):
        for tag in ['v2026.10.21', 'v2026.10.20-r10']:
            aws = FakeAWS(self.files)
            aws.latest = json.dumps({'tag': tag, 'assets': [{'name': 'new.exe'}]}).encode()
            original = aws.latest
            production.publish(aws, self.release, Path('assets'), self.hashes)
            self.assertEqual(aws.latest, original)
            self.assertNotIn('upload', aws.calls)
            self.assertNotIn('publish-latest', aws.calls)

    def test_website_only_lists_installers_and_keeps_update_files_in_release(self):
        names = ['app-mac-arm64.dmg', 'app-mac-arm64.zip', 'latest-arm64-mac.yml', 'release.json', 'app-win-x64-setup.exe']
        release = {**self.release, 'assets': [{'name': name, 'size': 1} for name in names]}
        self.assertEqual([a['name'] for a in production.website_manifest(release)['assets']], [names[0], names[-1]])
        self.assertEqual(len(release['assets']), 5)

    def test_conflicting_existing_version_cannot_be_overwritten(self):
        aws = FakeAWS(self.files)
        call = aws.run
        def run(stage, args, **kwargs):
            if stage == 'list-existing':
                return json.dumps({'Contents': [{'Key': production.release_prefix(self.release) + 'installer.exe', 'Size': 999}]}).encode()
            return call(stage, args, **kwargs)
        with patch.object(aws, 'run', side_effect=run), self.assertRaises(RuntimeError):
            production.publish(aws, self.release, Path('assets'), self.hashes)
        self.assertNotIn('upload', aws.calls)
        self.assertNotIn('publish-latest', aws.calls)

    def test_partial_sync_resumes_only_when_existing_bytes_match(self):
        for contents in [b'installer', b'corrupted']:
            aws = FakeAWS({'installer.exe': contents})
            call = aws.run
            def run(stage, args, **kwargs):
                if stage == 'list-existing':
                    return json.dumps({'Contents': [{'Key': production.release_prefix(self.release) + 'installer.exe', 'Size': 9}]}).encode()
                return call(stage, args, **kwargs)
            with patch.object(aws, 'run', side_effect=run):
                if contents == b'installer':
                    production.publish(aws, self.release, Path('assets'), self.hashes)
                    self.assertIn('publish-latest', aws.calls)
                else:
                    with self.assertRaises(RuntimeError):
                        production.publish(aws, self.release, Path('assets'), self.hashes)
                    self.assertNotIn('upload', aws.calls)


if __name__ == "__main__":
    unittest.main()
