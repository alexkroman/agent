# Copyright 2026 the AAI authors. MIT license.
"""Assert that a `modal deploy` actually ROLLED OUT, not merely uploaded.

``modal deploy`` exits 0 once the image is built and the app definition is
registered. Whether a container can then START is a separate question, and
nothing in the deploy's own output answers it — Modal's rolling strategy keeps
the previous deploy's containers serving throughout, so the app reads
``deployed``, the health endpoint answers 200, and the request log stays clean
while every new container dies on startup. The service is left unable to scale
out or replace a container, and goes down whenever the last old one does.

That is not hypothetical. On 2026-08-09 a module-scope filesystem read in
``scripts/modal_image.py`` made the container's re-import of the deploy script
throw ``FileNotFoundError: '/pnpm-lock.yaml'``: 13 failed container starts over
four minutes, behind a Deploy workflow that reported success, with production
served for hours afterwards by a container that predated the deploy.

So this checks the two things the deploy itself cannot:

1. **A container started AFTER the deploy began.** The precise signal — it is
   what was false that day. Valid because ``MIN_CONTAINERS`` is 1, so Modal
   always brings one up; it never waits on traffic.
2. **The service answers.** Cheap, and covers the case where a container starts
   and the process inside it does not.

Both must hold at once, and (1) is the load-bearing half: (2) alone would have
passed happily against the stale container.

Usage (see .github/workflows/deploy.yml):

    python scripts/verify_modal_deploy.py \
        --app aai-server-web --since <ISO-8601> --health-url https://…/health
"""

import argparse
import json
import subprocess
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone

POLL_INTERVAL_SECONDS = 5
# Generous: a cold container pulls image layers before it runs anything, and
# this gate should only ever fire on a rollout that is really broken.
DEFAULT_TIMEOUT_SECONDS = 420
# Enough of the app log to carry the traceback a failed import prints.
FAILURE_LOG_LINES = 120


def _modal(*args: str, timeout: int = 120) -> str:
    """Run a `modal` subcommand, returning stdout ('' on any failure).

    Never raises: this runs on the failure path too, where the diagnosis is
    worth more than the exit code of the command fetching it.
    """
    try:
        done = subprocess.run(
            ["modal", *args], capture_output=True, text=True, timeout=timeout, check=False
        )
    except (OSError, subprocess.TimeoutExpired):
        return ""
    return done.stdout


def container_started_since(app: str, since: datetime) -> str | None:
    """The id of a running container for `app` that started at/after `since`."""
    raw = _modal("container", "list", "--json")
    if not raw.strip():
        return None
    try:
        containers = json.loads(raw)
    except json.JSONDecodeError:
        return None
    for container in containers:
        if container.get("app_name") != app:
            continue
        start = container.get("start_time")
        if not start:
            continue
        try:
            started_at = datetime.fromisoformat(start)
        except ValueError:
            continue
        # Modal reports a tz-aware local time; compare in UTC either way.
        if started_at.tzinfo is None:
            started_at = started_at.replace(tzinfo=timezone.utc)
        if started_at >= since:
            return str(container.get("container_id"))
    return None


def health_ok(url: str) -> bool:
    try:
        with urllib.request.urlopen(url, timeout=15) as response:  # noqa: S310 — https, ours
            return 200 <= response.status < 300
    except (urllib.error.URLError, OSError, ValueError):
        return False


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--app", required=True, help="Modal app name, e.g. aai-server-web")
    parser.add_argument(
        "--since",
        required=True,
        help="ISO-8601 instant the deploy began; a container must postdate it",
    )
    parser.add_argument("--health-url", default="", help="Probed once a container is up")
    parser.add_argument("--timeout", type=int, default=DEFAULT_TIMEOUT_SECONDS)
    args = parser.parse_args()

    since = datetime.fromisoformat(args.since)
    if since.tzinfo is None:
        since = since.replace(tzinfo=timezone.utc)

    deadline = time.monotonic() + args.timeout
    container: str | None = None

    while time.monotonic() < deadline:
        if container is None:
            container = container_started_since(args.app, since)
            if container:
                print(f"container {container} started after {since.isoformat()}", flush=True)
        # Ordered, not combined: a health check that passes before any new
        # container exists is the stale-container answer this gate exists to
        # reject.
        if container and (not args.health_url or health_ok(args.health_url)):
            print(f"{args.app} rolled out and is serving", flush=True)
            return 0
        time.sleep(POLL_INTERVAL_SECONDS)

    stage = "started, but never answered" if container else "never started a container"
    print(f"::error::{args.app} {stage} within {args.timeout}s — the rollout FAILED", flush=True)
    print(
        "`modal deploy` exited 0, so the image built and the app is registered; the "
        "previous deploy's containers may still be serving. Check the app log below "
        "for a container-startup traceback.",
        flush=True,
    )
    logs = _modal("app", "logs", args.app, "--since", "30m", "--timestamps", timeout=180)
    print("\n".join(logs.splitlines()[-FAILURE_LOG_LINES:]), flush=True)
    return 1


if __name__ == "__main__":
    sys.exit(main())
