#!/usr/bin/env python3
"""Minimal probe: does the Voice Agent API emit `transcript.agent.delta`?

Deliberately dumb — connect, configure a greeting, print the RAW text frames as
they arrive. No SDK, no event models, no normalisation layer that could invent a
frame. The greeting reply alone is the case `packages/aai/CLAUDE.md` claims
produces zero deltas, so it is the whole test.

    export ASSEMBLYAI_API_KEY=...
    uv run python scripts/vaapi_delta_probe.py [--seconds 25] [--tools]
"""

from __future__ import annotations

import argparse
import asyncio
import collections
import json
import os

import websockets
from dotenv import find_dotenv, load_dotenv

# Anchored to the WORKING directory, not this file: the script lives in the
# agent repo but is run from the tau2 checkout, whose .env holds the
# production key that matches the archived runs. Defaulting to the script's
# own tree walks up into the agent repo and picks up a different key, which
# the service rejects with a bare 1008.
load_dotenv(find_dotenv(usecwd=True))

URL = "wss://agents.assemblyai.com/v1/ws"

# A tool is declared only under --tools, to separately check the guide's other
# claim: that tool-call turns emit no agent text by either route.
TOOLS = [
    {
        "type": "function",
        "name": "get_weather",
        "description": "Get the current weather for a city.",
        "parameters": {
            "type": "object",
            "properties": {"city": {"type": "string", "description": "City name, e.g. London"}},
            "required": ["city"],
        },
    }
]


async def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--seconds", type=float, default=25.0)
    parser.add_argument("--tools", action="store_true", help="declare a tool as well")
    parser.add_argument("--raw", type=int, default=6, help="how many raw delta frames to print")
    args = parser.parse_args()

    key = os.environ.get("ASSEMBLYAI_API_KEY", "")
    if not key:
        raise SystemExit("ASSEMBLYAI_API_KEY is not set")

    session = {
        "system_prompt": "You are a friendly assistant. Keep replies to one sentence.",
        "greeting": "Thank you for calling. How can I help you today?",
        "input": {"format": {"encoding": "audio/pcm", "sample_rate": 24000}},
        "output": {"format": {"encoding": "audio/pcm", "sample_rate": 24000}},
    }
    if args.tools:
        session["tools"] = TOOLS

    counts: collections.Counter[str] = collections.Counter()
    raw_deltas: list[str] = []

    async with websockets.connect(
        URL, additional_headers={"Authorization": f"Bearer {key}"}, max_size=None
    ) as ws:
        await ws.send(json.dumps({"type": "session.update", "session": session}))
        print(f"connected; listening {args.seconds}s (tools={args.tools})\n", flush=True)

        async def read() -> None:
            async for frame in ws:
                if isinstance(frame, bytes):
                    counts["<binary>"] += 1
                    continue
                try:
                    etype = json.loads(frame).get("type", "?")
                except json.JSONDecodeError:
                    counts["<unparseable>"] += 1
                    continue
                counts[etype] += 1
                if etype == "transcript.agent.delta" and len(raw_deltas) < args.raw:
                    raw_deltas.append(frame)
                if etype in ("session.error", "error"):
                    print(f"  !! {frame}", flush=True)

        try:
            await asyncio.wait_for(read(), timeout=args.seconds)
        except asyncio.TimeoutError:
            pass
        try:
            await ws.send(json.dumps({"type": "session.end"}))
        except Exception:
            pass

    print("frame types received:")
    for etype, n in counts.most_common():
        print(f"  {etype:28s} {n}")
    print()
    n = counts["transcript.agent.delta"]
    print(f"VERDICT: transcript.agent.delta {'DOES' if n else 'does NOT'} arrive ({n} frames)")
    for frame in raw_deltas:
        print(f"  raw: {frame}")


if __name__ == "__main__":
    asyncio.run(main())
