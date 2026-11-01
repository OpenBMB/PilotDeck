"""Exercise real batch deletion on two disposable objects, never release assets."""

import json
import os
from pathlib import Path
import re
import tempfile
import time

from obs_release_retention import BUCKET, Client, delete_batch, issue_credentials


def listing(client, prefix):
    return client.call("s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", prefix,
                       "--output", "json").get("Contents", [])


def check(client, run_id, directory, report):
    if not re.fullmatch(r"[0-9]+", run_id):
        raise RuntimeError("A numeric GitHub run ID is required")
    prefix = f"PilotDeck/_debug/retention-delete/{run_id}/"
    keys = [prefix + name for name in ("first.txt", "second.txt")]
    report.update(prefix=prefix, keys=keys, result="failed")
    started = time.monotonic()
    try:
        if listing(client, prefix):
            raise RuntimeError("Test prefix already contains objects; refusing to overwrite")
        for index, key in enumerate(keys):
            body = Path(directory) / f"{index}.txt"
            body.write_text(f"OBS retention deletion acceptance {run_id} {index}\n")
            client.call("s3api", "put-object", "--bucket", BUCKET, "--key", key, "--body", str(body))
        uploaded = listing(client, prefix)
        expected_sizes = {key: (Path(directory) / f"{index}.txt").stat().st_size
                          for index, key in enumerate(keys)}
        if len(uploaded) != 2 or {item["Key"]: item["Size"] for item in uploaded} != expected_sizes:
            raise RuntimeError("Test objects were not confirmed before deletion")
        report["confirmed_objects"] = [{"key": item["Key"], "bytes": item["Size"]} for item in uploaded]
        report["delete_response"] = delete_batch(client, keys)
        report["remaining_keys"] = [item["Key"] for item in listing(client, prefix)]
        if report["remaining_keys"]:
            raise RuntimeError("Objects remain after confirmed deletion")
        report["result"] = "passed"
    finally:
        if "remaining_keys" not in report:
            try:
                report["remaining_keys"] = [item["Key"] for item in listing(client, prefix)]
            except RuntimeError as error:
                report["remaining_keys"] = None
                report["residual_check_error"] = str(error)
        report["elapsed_seconds"] = round(time.monotonic() - started, 3)


def main():
    report = {"result": "failed", "run_url": (
        f"{os.environ.get('GITHUB_SERVER_URL', 'https://github.com')}/"
        f"{os.environ.get('GITHUB_REPOSITORY', 'OpenBMB/PilotDeck')}/actions/runs/"
        f"{os.environ.get('GITHUB_RUN_ID', '')}")}
    try:
        auth = issue_credentials(os.environ.get("OBS_CREDENTIALS_BEARER_TOKEN", ""))
        with tempfile.TemporaryDirectory() as directory:
            config = Path(directory) / "config"
            config.write_text("[default]\ns3 =\n    addressing_style = virtual\n")
            check(Client(auth, config), os.environ.get("GITHUB_RUN_ID", ""), directory, report)
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        report["error"] = str(error) if isinstance(error, RuntimeError) else "Deletion check input or local I/O failure"
        raise SystemExit(report["error"]) from None
    finally:
        Path("retention-delete-check.json").write_text(json.dumps(report, indent=2, default=str) + "\n")
        print(json.dumps(report, default=str), flush=True)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(f"Test-object deletion: {report['result']}. See retention-delete-check artifact.\n"
                              "No production release assets or latest pointer were modified.\n")


if __name__ == "__main__":
    main()
