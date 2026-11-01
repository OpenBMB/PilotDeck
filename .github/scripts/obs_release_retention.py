"""Plan or remove obsolete version directories; never remove the latest release."""

import argparse
from datetime import datetime, timedelta, timezone
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import urllib.error
import urllib.request

BUCKET = "n00069-minicpm-5-0"
PREFIX = "PilotDeck/"
LATEST = PREFIX + "latest.json"
VERSION = re.compile(r"PilotDeck/(v(?P<date>\d{4}\.\d{2}\.\d{2})(?:-r(?P<revision>[1-9]\d*))?)/[^/]+$")


def timestamp(value):
    result = datetime.fromisoformat(value.replace("Z", "+00:00"))
    if result.tzinfo is None:
        raise RuntimeError("Object timestamp has no timezone")
    return result


def plan(objects, latest_tag, now):
    groups = {}
    version_order = {}
    seen = set()
    for item in objects:
        key = item["Key"]
        if key in seen:
            raise RuntimeError("Duplicate object in listing")
        seen.add(key)
        match = VERSION.fullmatch(key)
        if not match:
            continue
        tag = match[1]
        day = datetime.strptime(match["date"], "%Y.%m.%d").replace(tzinfo=timezone.utc)
        version_order[tag] = (day, int(match["revision"] or 0))
        group = groups.setdefault(tag, {"tag": tag, "modified": day, "objects": []})
        group["modified"] = max(group["modified"], timestamp(item["LastModified"]))
        group["objects"].append({"key": key, "bytes": item["Size"]})
    if latest_tag not in groups:
        raise RuntimeError("Latest manifest does not identify a listed release; refusing cleanup")
    ordered = sorted(groups, key=version_order.__getitem__, reverse=True)
    protected = set(ordered[:3]) | {latest_tag}
    cutoff = now - timedelta(days=30)
    keep, remove = [], []
    for tag in ordered:
        group = groups[tag]
        recent = group.pop("modified") >= cutoff
        group["objects"].sort(key=lambda item: item["key"])
        group["bytes"] = sum(item["bytes"] for item in group["objects"])
        if tag in protected or recent:
            group["reason"] = "latest" if tag == latest_tag else "newest-three" if tag in protected else "within-30-days"
            keep.append(group)
        else:
            remove.append(group)
    return {"generated_at": now.isoformat(), "latest_tag": latest_tag, "retention_days": 30,
            "minimum_versions": 3, "keep": keep, "remove": remove,
            "remove_bytes": sum(group["bytes"] for group in remove)}


def issue_credentials(token):
    if not token:
        raise RuntimeError("OBS_CREDENTIALS_BEARER_TOKEN is missing")
    request = urllib.request.Request(
        "https://tempaksk.modelbest.cn/v1/credentials",
        data=json.dumps({"route": "n00069-minicpm-5-0-pilotdeck", "session_name": "pilotdeck-retention"}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            auth = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Credential broker HTTP {error.code}") from None
    except (OSError, ValueError):
        raise RuntimeError("Credential broker network or JSON failure") from None
    if auth.get("bucket") != BUCKET or auth.get("object_prefix") != PREFIX:
        raise RuntimeError("Unexpected credential scope")
    if any(not isinstance(auth.get(k), str) or not auth[k] for k in
           ("access_key_id", "secret_access_key", "security_token", "expiration")):
        raise RuntimeError("Incomplete credentials")
    if timestamp(auth["expiration"]) - datetime.now(timezone.utc) < timedelta(minutes=5):
        raise RuntimeError("Insufficient credential lifetime")
    return auth


class Client:
    def __init__(self, auth, config):
        self.env = {k: v for k, v in os.environ.items() if not k.startswith(("OBS_", "AWS_"))
                    and k not in ("GH_TOKEN", "GITHUB_TOKEN")}
        self.env.update(AWS_ACCESS_KEY_ID=auth["access_key_id"], AWS_SECRET_ACCESS_KEY=auth["secret_access_key"],
                        AWS_SESSION_TOKEN=auth["security_token"], AWS_DEFAULT_REGION="cn-north-4",
                        AWS_CONFIG_FILE=str(config), AWS_EC2_METADATA_DISABLED="true", AWS_MAX_ATTEMPTS="2",
                        AWS_REQUEST_CHECKSUM_CALCULATION="when_required", AWS_RESPONSE_CHECKSUM_VALIDATION="when_required")

    def call(self, *args):
        try:
            result = subprocess.run(["aws", *args, "--endpoint-url", "https://obs.cn-north-4.myhuaweicloud.com"],
                                    env=self.env, capture_output=True, timeout=120)
        except subprocess.TimeoutExpired:
            raise RuntimeError("OBS retention operation timed out") from None
        if result.returncode:
            match = re.search(rb"An error occurred \(([A-Za-z0-9_.-]{1,80})\)", result.stderr)
            raise RuntimeError("OBS retention operation failed: " + (match[1].decode() if match else "client-or-network"))
        return json.loads(result.stdout) if result.stdout.strip() else {}

    def latest(self):
        return self.call("s3", "cp", f"s3://{BUCKET}/{LATEST}", "-", "--only-show-errors")["tag"]


def delete_batch(client, keys):
    if not keys or len(keys) > 1000 or len(set(keys)) != len(keys):
        raise RuntimeError("Invalid deletion batch")
    result = client.call("s3api", "delete-objects", "--bucket", BUCKET, "--delete",
                         json.dumps({"Objects": [{"Key": key} for key in keys], "Quiet": False}))
    deleted = [item["Key"] for item in result.get("Deleted", [])]
    if result.get("Errors") or len(deleted) != len(keys) or set(deleted) != set(keys):
        codes = sorted({item.get("Code", "unknown") for item in result.get("Errors", [])})
        safe_codes = [code for code in codes if re.fullmatch(r"[A-Za-z0-9_.-]{1,80}", code)]
        raise RuntimeError("OBS did not confirm all requested deletions" +
                           (": " + ",".join(safe_codes) if safe_codes else ""))
    return {"deleted": deleted, "errors": []}


def execute(client, report):
    keys = [item["key"] for group in report["remove"] for item in group["objects"]]
    for offset in range(0, len(keys), 1000):
        if client.latest() != report["latest_tag"]:
            raise RuntimeError("Latest changed since planning; stopping cleanup")
        batch = keys[offset:offset + 1000]
        for key in batch:
            match = VERSION.fullmatch(key)
            if not match or match[1] == report["latest_tag"]:
                raise RuntimeError("Invalid cleanup target")
        delete_batch(client, batch)
        print(f"Deleted {len(batch)} obsolete release objects", flush=True)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--apply", action="store_true")
    args = parser.parse_args()
    auth = issue_credentials(os.environ.get("OBS_CREDENTIALS_BEARER_TOKEN", ""))
    with tempfile.TemporaryDirectory() as directory:
        config = Path(directory) / "config"
        config.write_text("[default]\ns3 =\n    addressing_style = virtual\n")
        client = Client(auth, config)
        objects = client.call("s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", PREFIX,
                              "--output", "json").get("Contents", [])
        report = plan(objects, client.latest(), datetime.now(timezone.utc))
        Path("retention-plan.json").write_text(json.dumps(report, indent=2) + "\n")
        print(json.dumps({"mode": "apply" if args.apply else "dry-run", "latest_tag": report["latest_tag"],
                          "keep_versions": [g["tag"] for g in report["keep"]],
                          "remove_versions": [g["tag"] for g in report["remove"]],
                          "remove_bytes": report["remove_bytes"]}), flush=True)
        if args.apply:
            execute(client, report)
        if os.environ.get("GITHUB_STEP_SUMMARY"):
            with open(os.environ["GITHUB_STEP_SUMMARY"], "a") as summary:
                summary.write(f"OBS retention {'applied' if args.apply else 'dry run'}: "
                              f"{len(report['remove'])} obsolete versions, {report['remove_bytes']} bytes. "
                              f"Protected latest: {report['latest_tag']}. See retention-plan artifact.\n")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit(str(error) if isinstance(error, RuntimeError) else "Retention input or local I/O failure") from None
