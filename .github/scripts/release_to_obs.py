"""Sync release assets with broker credentials kept in process memory only."""

import json
import os
import subprocess
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path


def credentials(token):
    request = urllib.request.Request(
        "https://tempaksk.modelbest.cn/v1/credentials",
        data=json.dumps({
            "route": "n00069-minicpm-5-0-pilotdeck",
            "session_name": "pilotdeck-job",
        }).encode(),
        headers={"Authorization": f"Bearer {token}", "Content-Type": "application/json"},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=30) as response:
            result = json.load(response)
    except urllib.error.HTTPError as error:
        raise RuntimeError(f"Credential broker returned HTTP {error.code}") from None
    except (OSError, ValueError):
        raise RuntimeError("Credential broker request or JSON response failed") from None
    if not isinstance(result, dict) or any(
        not isinstance(result.get(key), str) or not result[key]
        for key in ("access_key_id", "secret_access_key", "security_token", "expiration")
    ):
        raise RuntimeError("Credential broker response is missing required fields")
    if result.get("bucket") != "n00069-minicpm-5-0" or result.get("object_prefix") != "PilotDeck/":
        raise RuntimeError("Credential broker returned an unexpected bucket or prefix")
    try:
        expires = datetime.fromisoformat(result["expiration"].replace("Z", "+00:00"))
        if expires <= datetime.now(timezone.utc):
            raise ValueError("expired")
    except (ValueError, TypeError):
        raise RuntimeError("Credential broker returned an invalid or expired expiration") from None
    return result


def main():
    token = os.environ.get("OBS_CREDENTIALS_BEARER_TOKEN")
    if not token:
        raise RuntimeError("OBS_CREDENTIALS_BEARER_TOKEN is missing")
    bucket = os.environ["OBS_BUCKET"]
    prefix = os.environ["OBS_PREFIX"]
    if bucket != "n00069-minicpm-5-0" or not prefix.startswith("PilotDeck/") or prefix == "PilotDeck/":
        raise RuntimeError("Destination must be a release prefix within PilotDeck/")
    assets = json.loads(Path("release.json").read_text())["assets"]
    expected = {prefix + asset["name"]: asset["size"] for asset in assets}
    if not expected:
        raise RuntimeError("Release has no assets")
    auth = credentials(token)
    env = dict(os.environ)
    env.pop("OBS_CREDENTIALS_BEARER_TOKEN", None)
    env.update(AWS_ACCESS_KEY_ID=auth["access_key_id"],
               AWS_SECRET_ACCESS_KEY=auth["secret_access_key"],
               AWS_SESSION_TOKEN=auth["security_token"])

    def aws(*args):
        # Capture output so credential-bearing service errors cannot enter Actions logs.
        result = subprocess.run(["aws", *args], env=env, capture_output=True, text=True)
        if result.returncode:
            raise RuntimeError(f"OBS operation failed: {' '.join(args[:2])} (exit {result.returncode})")
        return result.stdout

    aws("configure", "set", "default.s3.addressing_style", "path")
    endpoint = ["--endpoint-url", os.environ["OBS_ENDPOINT"]]
    aws("s3", "sync", "release-assets/", f"s3://{bucket}/{prefix}", "--only-show-errors", *endpoint)
    objects = json.loads(aws("s3api", "list-objects-v2", "--bucket", bucket,
                             "--prefix", prefix, "--output", "json", *endpoint))
    actual = {obj["Key"]: obj["Size"] for obj in objects.get("Contents", [])}
    if actual != expected:
        raise RuntimeError("OBS object names or sizes differ from the resolved release")
    print(f"Verified {len(expected)} OBS objects")


if __name__ == "__main__":
    try:
        main()
    except (RuntimeError, KeyError, ValueError, OSError) as error:
        # Only deliberate diagnostics are printable; arbitrary exception data may contain secrets.
        message = str(error) if isinstance(error, RuntimeError) else "OBS synchronization failed"
        raise SystemExit(message) from None
