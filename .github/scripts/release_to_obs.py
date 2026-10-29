"""Publish a fully verified release using process-local broker credentials."""

from datetime import datetime
import hashlib
import json
import os
from pathlib import Path
import re
import tempfile
import time
from urllib.parse import quote

from obs_sync_debug import AWS, BUCKET, configure, credentials, local_hashes, log, s3, verify_one

LATEST = "PilotDeck/latest.json"


def release_prefix(release):
    tag = release.get("tag_name", "")
    match = re.fullmatch(r"v(\d{4}\.\d{2}\.\d{2})(?:-r[1-9]\d*)?", tag)
    if not match or release.get("draft") or release.get("prerelease") or not release.get("assets"):
        raise RuntimeError("A dated formal release with assets is required")
    datetime.strptime(match[1], "%Y.%m.%d")
    return f"PilotDeck/{tag}/"


def website_manifest(release):
    prefix = release_prefix(release)
    base = f"https://{BUCKET}.obs.cn-north-4.myhuaweicloud.com/"
    return {"tag": release["tag_name"], "published_at": release.get("published_at"), "assets": [
        {"name": asset["name"], "size": asset["size"],
         "url": base + quote(prefix + asset["name"], safe="/")} for asset in release["assets"]]}


def publish(aws, release, directory, hashes):
    prefix = release_prefix(release)
    sizes = {asset["name"]: asset["size"] for asset in release["assets"]}
    # Save the old public pointer before any writes, so acceptance can restore it.
    with tempfile.TemporaryDirectory() as temporary:
        previous = Path(temporary) / "latest.json"
        aws.run("backup-latest", s3("s3", "cp", f"s3://{BUCKET}/{LATEST}", str(previous), "--only-show-errors"))
        old_manifest = json.loads(previous.read_bytes())
        release_prefix({"tag_name": old_manifest["tag"], "assets": old_manifest["assets"]})
        Path("previous-latest.json").write_bytes(previous.read_bytes())
    aws.run("upload", s3("s3", "sync", str(directory) + "/", f"s3://{BUCKET}/{prefix}", "--only-show-errors"),
            size=sum(sizes.values()), limit=max(.001, aws.deadline - time.monotonic()))
    objects = json.loads(aws.run("list", s3("s3api", "list-objects-v2", "--bucket", BUCKET,
                                          "--prefix", prefix, "--output", "json"))).get("Contents", [])
    if len(objects) != len(sizes) or {item["Key"]: item["Size"] for item in objects} != {
            prefix + name: size for name, size in sizes.items()}:
        raise RuntimeError("OBS release names or sizes differ")
    for name, expected in hashes.items():
        verify_one(aws, prefix + name, expected, sizes[name])
    manifest = json.dumps(website_manifest(release)).encode()
    Path("published-latest.json").write_bytes(manifest)
    try:
        with tempfile.TemporaryFile() as stream:
            stream.write(manifest)
            stream.seek(0)
            aws.run("publish-latest", s3("s3", "cp", "-", f"s3://{BUCKET}/{LATEST}",
                    "--content-type", "application/json", "--cache-control", "no-store", "--only-show-errors"), stdin=stream)
        verify_one(aws, LATEST, hashlib.sha256(manifest).hexdigest(), len(manifest))
    except RuntimeError:
        log("latest-publication-unconfirmed", backup="previous-latest.json",
            action="Keep scheduling disabled; inspect and restore the saved pointer if necessary")
        raise
    log("production-published", tag=release["tag_name"], objects=len(sizes))


def main():
    release = json.loads(Path("resolved-release.json").read_text())
    release_prefix(release)
    directory = Path("release-assets")
    hashes = local_hashes(release, directory)
    auth = credentials(os.environ.get("OBS_CREDENTIALS_BEARER_TOKEN", ""), "n00069-minicpm-5-0-pilotdeck",
                       session_name="pilotdeck-production-sync")
    aws = AWS(auth, minutes=50, workers=1)
    started = time.monotonic()
    try:
        with tempfile.TemporaryDirectory() as temporary:
            configure(aws, Path(temporary) / "config")
            publish(aws, release, directory, hashes)
        log("production-sync-success", tag=release["tag_name"], elapsed_seconds=round(time.monotonic() - started, 2))
    finally:
        aws.stop()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, ValueError, KeyError, TypeError) as error:
        raise SystemExit(str(error) if isinstance(error, RuntimeError) else "Production sync input or local I/O failure") from None
