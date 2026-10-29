"""Isolated OBS diagnostics. Never publishes the production latest pointer."""

import concurrent.futures
import hashlib
import json
import os
from pathlib import Path
import re
import subprocess
import tempfile
import threading
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

BUCKET = "n00069-minicpm-5-0"
ROOT = "PilotDeck/_debug/"
ENDPOINT = "https://obs.cn-north-4.myhuaweicloud.com"


def log(stage, **fields):
    print(json.dumps({"stage": stage, **fields}, ensure_ascii=True), flush=True)


def digest(stream, deadline=float("inf")):
    result = hashlib.sha256()
    for chunk in iter(lambda: stream.read(1024 * 1024), b""):
        if time.monotonic() >= deadline:
            raise RuntimeError("Content hashing deadline reached")
        result.update(chunk)
    return result.hexdigest()


def local_hashes(release, directory):
    expected = {}
    for asset in release["assets"]:
        name = asset["name"]
        if not re.fullmatch(r"[A-Za-z0-9._-]+", name) or name in (".", "..", "latest.json") or name in expected:
            raise RuntimeError("Invalid or duplicate release asset")
        path = directory / name
        if path.is_symlink() or path.stat().st_size != asset["size"]:
            raise RuntimeError("Local release asset size differs")
        with path.open("rb") as stream:
            expected[name] = digest(stream)
        if asset.get("digest") and asset["digest"] != "sha256:" + expected[name]:
            raise RuntimeError("Local release asset differs from GitHub digest")
        log("local-verified", file=name, bytes=asset["size"])
    if not expected:
        raise RuntimeError("Release has no assets")
    if {path.name for path in directory.iterdir()} != set(expected):
        raise RuntimeError("Local release asset names differ")
    manifest = json.loads((directory / "release.json").read_text())
    records = manifest["assets"]
    if manifest["tag"] != release["tag_name"] or len({a["name"] for a in records}) != len(records):
        raise RuntimeError("Release manifest identity differs")
    if {a["name"] for a in records} != set(expected) - {"release.json", "SHA256SUMS.txt"}:
        raise RuntimeError("Release manifest coverage differs")
    sizes = {a["name"]: a["size"] for a in release["assets"]}
    for asset in records:
        if asset["sha256"] != expected[asset["name"]] or asset["size"] != sizes[asset["name"]]:
            raise RuntimeError("Local release asset differs from manifest")
    return expected


def credential_lifetime(auth):
    try:
        expiration = datetime.fromisoformat(auth["expiration"].replace("Z", "+00:00"))
        remaining = (expiration - datetime.now(timezone.utc)).total_seconds()
    except (ValueError, TypeError, KeyError):
        raise RuntimeError("Invalid credential expiration") from None
    if remaining <= 300:
        raise RuntimeError("Credential lifetime is less than five minutes")
    return remaining


def credentials(token, route, session_name="pilotdeck-debug"):
    if not token or route != "n00069-minicpm-5-0-pilotdeck":
        raise RuntimeError("Configured desktop token and PilotDeck route required")
    request = urllib.request.Request(
        "https://tempaksk.modelbest.cn/v1/credentials",
        data=json.dumps({"route": route, "session_name": session_name}).encode(),
        headers={"Authorization": "Bearer " + token, "Content-Type": "application/json"},
        method="POST",
    )
    log("broker-start")
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            auth = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Broker HTTP {error.code}") from None
    except (OSError, ValueError):
        raise RuntimeError("Broker network or JSON failure") from None
    if not isinstance(auth, dict) or any(not isinstance(auth.get(key), str) or not auth[key]
                                           for key in ("access_key_id", "secret_access_key", "security_token")):
        raise RuntimeError("Broker omitted credentials")
    if auth.get("bucket") != BUCKET or auth.get("object_prefix") != "PilotDeck/":
        raise RuntimeError("Broker scope must be exactly PilotDeck/")
    log("broker-complete", remaining_seconds=round(credential_lifetime(auth)))
    return auth


class OperationFailure(RuntimeError):
    def __init__(self, stage, category, code="Unknown"):
        self.stage, self.category, self.code = stage, category, code
        super().__init__(f"{stage}: {category} ({code})")


class AWS:
    def __init__(self, auth, minutes=15, workers=1, heartbeat=30, object_seconds=300):
        if minutes not in (15, 45, 50) or not 1 <= workers <= 4:
            raise RuntimeError("Unsupported diagnostic budget or concurrency")
        self.deadline = time.monotonic() + min(minutes * 60, 50 * 60, credential_lifetime(auth) - 120)
        self.heartbeat, self.object_seconds, self.workers = heartbeat, object_seconds, workers
        self.stopped = threading.Event()
        self.lock = threading.Lock()
        self.processes = set()
        self.env = {k: v for k, v in os.environ.items()
                    if not k.startswith(("OBS_", "AWS_")) and k not in ("GH_TOKEN", "GITHUB_TOKEN")}
        self.env.update(AWS_ACCESS_KEY_ID=auth["access_key_id"], AWS_SECRET_ACCESS_KEY=auth["secret_access_key"],
                        AWS_SESSION_TOKEN=auth["security_token"], AWS_DEFAULT_REGION="cn-north-4",
                        AWS_EC2_METADATA_DISABLED="true", AWS_REQUEST_CHECKSUM_CALCULATION="when_required",
                        AWS_RESPONSE_CHECKSUM_VALIDATION="when_required", AWS_MAX_ATTEMPTS="2")

    def stop(self):
        self.stopped.set()
        with self.lock:
            for process in list(self.processes):
                if process.poll() is None:
                    process.kill()

    def run(self, stage, args, *, output=None, stdin=None, file="", size=0, limit=None):
        started = time.monotonic()
        end = min(self.deadline, started + (limit or self.object_seconds))
        if self.stopped.is_set() or started >= end:
            raise OperationFailure(stage, "deadline")
        log(stage + "-start", file=file, bytes=size, remaining_seconds=round(end - started))
        with tempfile.TemporaryFile() as errors, tempfile.TemporaryFile() as captured:
            with self.lock:
                if self.stopped.is_set():
                    raise OperationFailure(stage, "cancelled")
                process = subprocess.Popen(["aws", *args], env=self.env, stdout=output or captured,
                                           stderr=errors, stdin=stdin or subprocess.DEVNULL)
                self.processes.add(process)
            try:
                while True:
                    if self.stopped.is_set() or time.monotonic() >= end:
                        process.kill()
                        process.wait()
                        raise OperationFailure(stage, "cancelled" if self.stopped.is_set() else "timeout")
                    try:
                        status = process.wait(timeout=min(self.heartbeat, max(.001, end - time.monotonic())))
                        break
                    except subprocess.TimeoutExpired:
                        log(stage + "-heartbeat", file=file, elapsed_seconds=round(time.monotonic() - started),
                            remaining_seconds=max(0, round(end - time.monotonic())))
                if status:
                    errors.seek(0)
                    # Never print raw stderr: it may contain signed request details.
                    error = errors.read(65536).decode("utf-8", errors="replace")
                    match = re.search(r"An error occurred \(([A-Za-z0-9_.-]{1,80})\)", error)
                    code = match[1] if match else "Unknown"
                    category = "service" if match else "client-or-network"
                    log(stage + "-failed", file=file, category=category, code=code, exit=status)
                    raise OperationFailure(stage, category, code)
                if time.monotonic() >= end:
                    raise OperationFailure(stage, "timeout")
                log(stage + "-complete", file=file, bytes=size, elapsed_seconds=round(time.monotonic() - started, 2))
                captured.seek(0)
                return captured.read()
            finally:
                if process.poll() is None:
                    process.kill()
                process.wait()
                with self.lock:
                    self.processes.discard(process)


def s3(*args):
    return [*args, "--endpoint-url", ENDPOINT]


def require_debug_prefix(prefix):
    if not re.fullmatch(r"PilotDeck/_debug/v[A-Za-z0-9._-]{1,100}/[0-9]+/", prefix):
        raise RuntimeError("Only a run-isolated debug prefix is allowed")


def configure(aws, config):
    config.write_text("[default]\ns3 =\n    addressing_style = virtual\n")
    aws.env["AWS_CONFIG_FILE"] = str(config)


def verify_one(aws, key, expected, size):
    # AWS CLI 1.46.1 can deadlock streamed multipart downloads at 48 MiB.
    # A seekable file avoids that queue and still permits full content checks.
    with tempfile.TemporaryDirectory() as temporary:
        path = Path(temporary) / "object"
        aws.run("readback", s3("s3", "cp", f"s3://{BUCKET}/{key}", str(path), "--only-show-errors"),
                file=key.rsplit("/", 1)[-1], size=size)
        if path.stat().st_size != size:
            raise RuntimeError("OBS readback size mismatch: " + key.rsplit("/", 1)[-1])
        with path.open("rb") as stream:
            if digest(stream, aws.deadline) != expected:
                raise RuntimeError("OBS content mismatch: " + key.rsplit("/", 1)[-1])
    log("content-verified", file=key.rsplit("/", 1)[-1], bytes=size)


def verify_all(aws, prefix, hashes, sizes):
    # Keep at most workers jobs in flight; failure cancels remaining child processes.
    items = iter(hashes.items())
    with concurrent.futures.ThreadPoolExecutor(max_workers=aws.workers) as pool:
        active = set()
        try:
            for _ in range(aws.workers):
                item = next(items, None)
                if item:
                    active.add(pool.submit(verify_one, aws, prefix + item[0], item[1], sizes[item[0]]))
            while active:
                done, active = concurrent.futures.wait(active, return_when=concurrent.futures.FIRST_COMPLETED)
                for future in done:
                    future.result()
                for _ in done:
                    item = next(items, None)
                    if item:
                        active.add(pool.submit(verify_one, aws, prefix + item[0], item[1], sizes[item[0]]))
        except BaseException:
            aws.stop()
            for future in active:
                future.cancel()
            raise


def permission_smoke(aws, prefix, directory):
    require_debug_prefix(prefix)
    smoke = directory / "permission-probe.txt"
    smoke.write_bytes(b"pilotdeck isolated debug permission probe\n")
    key = prefix + "_smoke/permission-probe.txt"
    aws.run("smoke-upload", s3("s3", "cp", str(smoke), f"s3://{BUCKET}/{key}", "--only-show-errors"))
    with smoke.open("rb") as stream:
        expected = digest(stream)
    verify_one(aws, key, expected, smoke.stat().st_size)


def sync_release(aws, prefix, directory, release, hashes):
    require_debug_prefix(prefix)
    sizes = {a["name"]: a["size"] for a in release["assets"]}
    aws.run("upload", s3("s3", "sync", str(directory) + "/", f"s3://{BUCKET}/{prefix}", "--only-show-errors"),
            size=sum(sizes.values()), limit=max(.001, aws.deadline - time.monotonic()))
    raw = aws.run("list", s3("s3api", "list-objects-v2", "--bucket", BUCKET, "--prefix", prefix, "--output", "json"))
    objects = json.loads(raw).get("Contents", [])
    actual = {o["Key"][len(prefix):]: o["Size"] for o in objects
              if o["Key"] != prefix + "latest.json" and not o["Key"].startswith(prefix + "_smoke/")}
    if actual != sizes:
        raise RuntimeError("OBS names or sizes differ")
    verify_all(aws, prefix, hashes, sizes)
    manifest = json.dumps({"tag": release["tag_name"], "assets": [
        {"name": name, "size": sizes[name], "sha256": value} for name, value in hashes.items()
    ]}).encode()
    with tempfile.TemporaryFile() as stream:
        stream.write(manifest)
        stream.seek(0)
        aws.run("publish-debug-latest", s3("s3", "cp", "-", f"s3://{BUCKET}/{prefix}latest.json",
                "--only-show-errors", "--content-type", "application/json", "--cache-control", "no-store"), stdin=stream)
    verify_one(aws, prefix + "latest.json", hashlib.sha256(manifest).hexdigest(), len(manifest))


def main():
    release = json.loads(Path("resolved-release.json").read_text())
    tag, run_id = release["tag_name"], os.environ["GITHUB_RUN_ID"]
    if not re.fullmatch(r"v[A-Za-z0-9._-]{1,100}", tag) or not run_id.isdigit():
        raise RuntimeError("Invalid release tag or run id")
    prefix = f"{ROOT}{tag}/{run_id}/"
    directory = Path("release-assets")
    hashes = local_hashes(release, directory)
    auth = credentials(os.environ.get("OBS_DEBUG_BEARER_TOKEN", ""), os.environ.get("OBS_DEBUG_ROUTE", ""))
    aws = AWS(auth)  # First diagnosis stays serial and limited to fifteen minutes.
    started = time.monotonic()
    with tempfile.TemporaryDirectory() as temporary:
        temporary = Path(temporary)
        configure(aws, temporary / "aws-config")
        try:
            permission_smoke(aws, prefix, temporary)
            for attempt in (1, 2):
                log("sync-attempt", attempt=attempt, prefix=prefix)
                sync_release(aws, prefix, directory, release, hashes)
            log("diagnostic-success", elapsed_seconds=round(time.monotonic() - started, 2), objects=len(hashes))
        finally:
            aws.stop()


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, OSError, KeyError, ValueError) as error:
        message = str(error) if isinstance(error, RuntimeError) else "Diagnostic input or local I/O failure"
        log("diagnostic-failed", message=message)
        raise SystemExit(1) from None
