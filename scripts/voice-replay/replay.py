"""Replay real tau2-bench caller audio against a live AAI pipeline agent and
score the τ-voice interaction panel with tau2's own metric code.

Why this exists: a full tau2 run costs ~25 conversations of LLM + TTS and
confounds task success with turn-taking. The interaction panel, though, is
decided almost entirely by the STT -> barge-in path, which is exercised
faithfully by replaying the caller's recorded audio open-loop.

Fidelity notes (each one matters for the numbers to mean anything):
  * The caller track is the LEFT channel of the archived ``both.wav`` — the
    agent is on the right and is exactly silent during caller turns, so the
    split is clean and keeps the benchmark's street noise, muffling, vocal
    tics and non-directed speech.
  * The USER half of the tick stream is reused verbatim from the original
    simulation, so backchannel/tic/non-directed annotations are ground truth.
    Only the AGENT half is re-measured.
  * ``agent_chunk.contains_speech`` is reproduced the way tau2 derives it:
    audio bytes delivered into this 200 ms tick's playout window, with the
    buffer dropped on interruption (``--truncate-on`` selects which wire
    event counts as one).

Open-loop caveat: the caller is a recording and does not adapt to what the
agent says, so this measures turn-taking against a fixed stimulus. That makes
conditions comparable to each other; it does not reproduce task success.
"""

from __future__ import annotations

import argparse
import asyncio
import hashlib
import json
import os
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np
import websockets
from loguru import logger
from scipy.signal import resample_poly

logger.remove()

from tau2.data_model.message import AssistantMessage, Tick  # noqa: E402

TICK_SEC = 0.2
SEND_RATE = 24_000  # what tau2's aai provider declares and sends
RECV_RATE = 24_000
BYTES_PER_TICK_OUT = int(RECV_RATE * TICK_SEC) * 2


# ── corpus ────────────────────────────────────────────────────────────────
def load_caller_track(wav_path: Path) -> np.ndarray:
    """Left (caller) channel of a sim's both.wav, resampled to SEND_RATE."""
    with wave.open(str(wav_path)) as w:
        assert w.getnchannels() == 2, "expected stereo caller/agent mix"
        sr = w.getframerate()
        raw = np.frombuffer(w.readframes(w.getnframes()), dtype=np.int16)
    caller = raw.reshape(-1, 2)[:, 0].astype(np.float32)
    if sr != SEND_RATE:
        g = np.gcd(SEND_RATE, sr)
        caller = resample_poly(caller, SEND_RATE // g, sr // g)
    return np.clip(caller, -32768, 32767).astype(np.int16)


def find_wav(run_dir: Path, sim_id: str) -> Path:
    hits = list(run_dir.glob(f"artifacts/*/sim_{sim_id}/audio/both.wav"))
    if not hits:
        raise FileNotFoundError(f"no both.wav for sim {sim_id}")
    return hits[0]


# ── replay ────────────────────────────────────────────────────────────────
@dataclass
class ReplayResult:
    sim_id: str
    task_id: str
    n_ticks: int
    # (t_sec, n_bytes) for every agent audio frame, and (t_sec, kind) for every
    # wire event. Recording the raw timeline instead of a single playout lets
    # the same real run be re-scored under several client truncation policies.
    arrivals: list[tuple[float, int]] = field(default_factory=list)
    events: list[tuple[float, str]] = field(default_factory=list)
    agent_bytes: int = 0
    error: str | None = None


def simulate_playout(
    rep: ReplayResult, truncate_on: set[str]
) -> tuple[list[bool], int]:
    """Replay the recorded arrival timeline through a tick-quantized playout
    buffer, dropping buffered audio on each truncating event — tau2's
    ``bytes_per_tick`` consumption model, run offline.

    Returns (per-tick speaking flags, bytes discarded by truncation).
    """
    timeline: list[tuple[float, int, int]] = []  # (t, kind: 0=audio 1=trunc, bytes)
    for t, n in rep.arrivals:
        timeline.append((t, 0, n))
    for t, kind in rep.events:
        if kind in truncate_on:
            timeline.append((t, 1, 0))
    timeline.sort(key=lambda x: (x[0], x[1]))

    speaking: list[bool] = []
    buffered = 0
    truncated = 0
    idx = 0
    for i in range(rep.n_ticks):
        tick_end = (i + 1) * TICK_SEC
        while idx < len(timeline) and timeline[idx][0] < tick_end:
            _, kind, nbytes = timeline[idx]
            if kind == 0:
                buffered += nbytes
            else:
                truncated += buffered
                buffered = 0
            idx += 1
        took = min(buffered, BYTES_PER_TICK_OUT)
        speaking.append(took > 0)
        buffered -= took
    return speaking, truncated


async def replay_one(
    *,
    ws_url: str,
    caller: np.ndarray,
    n_ticks: int,
    system_prompt: str,
    greeting: str,
    sim_id: str,
    task_id: str,
    audio_lead: object = "default",
) -> ReplayResult:
    """Stream one caller track in real time; record the agent's audio-arrival
    and wire-event timeline. Playout is simulated afterwards, not here."""
    res = ReplayResult(sim_id=sim_id, task_id=task_id, n_ticks=n_ticks)
    t0 = time.monotonic()
    stop = asyncio.Event()

    try:
        async with websockets.connect(
            ws_url, max_size=None, ping_interval=None, open_timeout=20
        ) as ws:
            host: dict = {
                "systemPrompt": system_prompt,
                "greeting": greeting,
                "tools": [],
            }
            # `audioLeadMs` is CLIENT-declared, so pacing can be swept against a
            # single server: omit for the pacer default, null for unpaced, or a
            # number of ms. This replay drains at 1x real time (the tick loop
            # sleeps to each deadline), so the default is the honest setting and
            # `null` models a harness whose clock can run ahead.
            if audio_lead != "default":
                host["audioLeadMs"] = audio_lead
            await ws.send(
                json.dumps(
                    {
                        "type": "config",
                        "host": host,
                        "sampleRate": SEND_RATE,
                        "ttsSampleRate": RECV_RATE,
                    }
                )
            )

            async def reader() -> None:
                async for msg in ws:
                    now = time.monotonic() - t0
                    if isinstance(msg, (bytes, bytearray)):
                        res.arrivals.append((now, len(msg)))
                        res.agent_bytes += len(msg)
                        continue
                    try:
                        ev = json.loads(msg)
                    except Exception:
                        continue
                    kind = ev.get("type", "?")
                    res.events.append((now, kind))
                    if kind == "error" and ev.get("fatal") is not False:
                        res.error = f"{ev.get('code')}: {ev.get('message')}"
                        stop.set()

            rtask = asyncio.create_task(reader())

            samples_per_tick = int(SEND_RATE * TICK_SEC)
            for i in range(n_ticks):
                if stop.is_set():
                    break
                deadline = t0 + (i + 1) * TICK_SEC
                chunk = caller[i * samples_per_tick : (i + 1) * samples_per_tick]
                if len(chunk) < samples_per_tick:
                    chunk = np.pad(chunk, (0, samples_per_tick - len(chunk)))
                await ws.send(chunk.tobytes())
                sleep = deadline - time.monotonic()
                if sleep > 0:
                    await asyncio.sleep(sleep)
            rtask.cancel()
    except Exception as e:  # noqa: BLE001 - reported, not raised, per sim
        res.error = f"{type(e).__name__}: {e}"

    return res


# ── selection ─────────────────────────────────────────────────────────────
def rank_sims_by_selectivity(results) -> list[str]:
    """Sim ids ordered by how many selectivity events they carry.

    Backchannels, vocal tics and non-directed speech are sparse (~0-8 per
    conversation), so a random sample spends most of its wall clock on
    conversations that cannot move S_BC/S_VT/S_ND at all.
    """
    from tau2.metrics.voice_interaction_metrics import (
        extract_all_segments,
        extract_interruption_events,
        extract_out_of_turn_effects,
        filter_end_of_conversation_ticks,
    )

    selectivity = {
        "backchannel",
        "vocal_tic",
        "non_directed_speech",
        "agent_responds_to_vocal_tic",
        "agent_responds_to_non_directed",
        "vocal_tic_silent_correct",
        "non_directed_silent_correct",
    }
    scored = []
    for sim in results.simulations:
        if not sim.ticks:
            continue
        ft = filter_end_of_conversation_ticks(sim.ticks)
        us, ags = extract_all_segments(ft, TICK_SEC)
        oot = extract_out_of_turn_effects(ft, TICK_SEC)
        ies = extract_interruption_events(
            us, ags, ft, tick_duration_sec=TICK_SEC, out_of_turn_effects=oot
        )
        n = sum(1 for i in ies if i.event_type in selectivity)
        scored.append((n, sim.id))
    scored.sort(reverse=True)
    return [sid for _, sid in scored]


# ── scoring ───────────────────────────────────────────────────────────────
def build_ticks(orig_ticks: list[Tick], agent_speech: list[bool]) -> list[Tick]:
    """Original user half + measured agent half, in tau2's Tick shape."""
    out: list[Tick] = []
    for i, t in enumerate(orig_ticks):
        speaking = agent_speech[i] if i < len(agent_speech) else False
        agent_chunk = AssistantMessage(
            role="assistant", content=None, contains_speech=speaking
        )
        user_chunk = t.user_chunk
        out.append(
            Tick(
                tick_id=t.tick_id,
                timestamp=t.timestamp,
                agent_chunk=agent_chunk,
                user_chunk=user_chunk,
                agent_tool_calls=[],
                user_tool_calls=[],
                agent_tool_results=[],
                user_tool_results=[],
                user_transcript=t.user_transcript,
                tick_duration_seconds=TICK_SEC,
                wall_clock_duration_seconds=0.0,
            )
        )
    return out


def main() -> None:
    ap = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    ap.add_argument(
        "--run-dir",
        default=os.environ.get("TAU2_RUN_DIR", ""),
        help="a tau2 experiment dir (results.json + simulations/ + artifacts/); "
        "defaults to $TAU2_RUN_DIR",
    )
    ap.add_argument("--ws", default=os.environ.get("AAI_WS_URL", "ws://127.0.0.1:8791/websocket?host=1"))
    ap.add_argument(
        "--sims",
        default="",
        help="comma-separated sim ids; default picks the --top-n sims richest "
        "in selectivity events",
    )
    ap.add_argument("--top-n", type=int, default=10)
    ap.add_argument("--concurrency", type=int, default=4)
    ap.add_argument(
        "--policies",
        default="tau2=speech_started;cancel-only=cancelled;never=",
        help="';'-separated name=events client truncation policies to score. "
        "'tau2' reproduces the benchmark harness, which drops buffered agent "
        "audio on speech_started and has no cancelled handler at all.",
    )
    ap.add_argument("--max-ticks", type=int, default=0, help="0 = full sim")
    ap.add_argument(
        "--system-prompt",
        default="",
        help="file whose contents REPLACE the task policy as the agent's "
        "instructions (host.systemPrompt)",
    )
    ap.add_argument(
        "--prompt-prefix",
        default="",
        help="file prepended to the task policy",
    )
    ap.add_argument(
        "--prompt-suffix",
        default="",
        help="file appended to the task policy — the usual lever, since it "
        "adds guidance without discarding the domain rules the tasks are "
        "scored against",
    )
    ap.add_argument(
        "--audio-lead",
        default="default",
        help="client-declared HostConfig.audioLeadMs: 'default' (omit, pacer "
        "default), 'null' (unpaced), or a number of ms",
    )
    ap.add_argument("--label", default="run")
    ap.add_argument("--out", default="")
    args = ap.parse_args()

    from tau2.data_model.simulation import Results

    if not args.run_dir:
        ap.error("--run-dir (or $TAU2_RUN_DIR) is required")
    run_dir = Path(args.run_dir)
    results = Results.load(run_dir)
    by_id = {s.id: s for s in results.simulations}
    sim_ids = [s.strip() for s in args.sims.split(",") if s.strip()]
    if not sim_ids:
        sim_ids = rank_sims_by_selectivity(results)[: args.top_n]
    policies: dict[str, set[str]] = {}
    for spec in args.policies.split(";"):
        if not spec.strip():
            continue
        name, _, evs = spec.partition("=")
        policies[name.strip()] = {e.strip() for e in evs.split(",") if e.strip()}

    jobs = []
    for sid in sim_ids:
        sim = by_id[sid]
        caller = load_caller_track(find_wav(run_dir, sid))
        n_ticks = len(sim.ticks)
        if args.max_ticks:
            n_ticks = min(n_ticks, args.max_ticks)
        jobs.append((sim, caller, n_ticks))

    # System-prompt variants. These land in the SDK's "Agent-Specific
    # Instructions" section; the scaffold around them (DEFAULT_SYSTEM_PROMPT,
    # TOOL_PREAMBLE, VOICE_RULES in sdk/system-prompt.ts) is server-side code
    # and cannot be varied from here — to sweep THAT, edit the constant and run
    # a separate sweep per variant.
    def read_opt(p: str) -> str:
        return Path(p).read_text() if p else ""

    prompt_override = read_opt(args.system_prompt)
    prompt_prefix = read_opt(args.prompt_prefix)
    prompt_suffix = read_opt(args.prompt_suffix)

    def build_prompt(policy: str) -> str:
        base = prompt_override or policy
        return f"{prompt_prefix}{base}{prompt_suffix}"

    if args.audio_lead == "default":
        audio_lead: object = "default"
    elif args.audio_lead == "null":
        audio_lead = None
    else:
        audio_lead = float(args.audio_lead)

    sem = asyncio.Semaphore(args.concurrency)

    async def run_job(sim, caller, n_ticks):
        async with sem:
            print(f"  [{sim.id[:8]}] task {sim.task_id}: {n_ticks} ticks "
                  f"({n_ticks * TICK_SEC:.0f}s)", flush=True)
            return await replay_one(
                ws_url=args.ws,
                caller=caller,
                n_ticks=n_ticks,
                system_prompt=build_prompt(
                    sim.policy or "You are a helpful retail support agent."
                ),
                greeting="Thank you for calling. How can I help you today?",
                sim_id=sim.id,
                task_id=str(sim.task_id),
                audio_lead=audio_lead,
            )

    async def run_all():
        return await asyncio.gather(*(run_job(*j) for j in jobs))

    t_start = time.time()
    replays = asyncio.run(run_all())
    elapsed = time.time() - t_start

    from tau2.metrics.voice_interaction_metrics import (
        extract_voice_quality_events_from_simulation,
    )

    per_sim = [
        {
            "sim": rep.sim_id,
            "task": rep.task_id,
            "agent_kb": round(rep.agent_bytes / 1024),
            "ticks": rep.n_ticks,
            "error": rep.error,
            "n_speech_started": sum(1 for _, k in rep.events if k == "speech_started"),
            "n_cancelled": sum(1 for _, k in rep.events if k == "cancelled"),
            "n_reply_done": sum(1 for _, k in rep.events if k == "reply_done"),
            # The raw timeline, kept so a finished run can be re-analysed
            # (barge-in decision latency, cancel-vs-speech_started skew)
            # without paying for the conversations again.
            "events_raw": [[round(t, 3), k] for t, k in rep.events],
            "arrivals_raw": [[round(t, 3), n] for t, n in rep.arrivals],
        }
        for rep in replays
    ]

    scored: dict[str, dict] = {}
    for pname, trunc in policies.items():
        all_events = []
        truncated_kb = 0
        speaking_ticks = 0
        for sim, (_, _, n_ticks), rep in zip(
            [j[0] for j in jobs], jobs, replays, strict=True
        ):
            speech, truncated = simulate_playout(rep, trunc)
            truncated_kb += truncated // 1024
            speaking_ticks += sum(speech)
            ticks = build_ticks(sim.ticks[:n_ticks], speech)
            all_events.extend(
                extract_voice_quality_events_from_simulation(
                    ticks,
                    tick_duration_sec=TICK_SEC,
                    simulation_id=sim.id,
                    task_id=str(sim.task_id),
                )
            )
        scored[pname] = {
            "truncate_on": sorted(trunc),
            "truncated_kb": truncated_kb,
            "speaking_ticks": speaking_ticks,
            "events": [
                {
                    "cat": e.event_category,
                    "type": e.event_type,
                    "err": e.is_error,
                    "lat": e.latency_sec,
                    "t": e.event_time_sec,
                    "sim": e.simulation_id,
                    "tx": e.transcript[:80],
                }
                for e in all_events
            ],
        }

    payload = {
        "label": args.label,
        "audio_lead": args.audio_lead,
        "prompt": {
            "override": bool(prompt_override),
            "prefix_chars": len(prompt_prefix),
            "suffix_chars": len(prompt_suffix),
            "sha256": hashlib.sha256(
                build_prompt("").encode()
            ).hexdigest()[:12],
        },
        "wall_seconds": round(elapsed),
        "per_sim": per_sim,
        "policies": scored,
    }
    out = Path(args.out or f"{args.label}.json")
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_text(json.dumps(payload, indent=1))
    print(f"\nwrote {out}  ({elapsed:.0f}s wall)")
    report(payload)


# ── reporting ─────────────────────────────────────────────────────────────
def panel(events: list[dict]) -> dict:
    """The eight τ-voice panel metrics, from a scored event list."""

    def rate(cat: str) -> tuple[float | None, int]:
        evs = [e for e in events if e["cat"] == cat]
        if not evs:
            return None, 0
        return 1.0 - sum(e["err"] for e in evs) / len(evs), len(evs)

    lats = [e["lat"] for e in events if e["type"] == "response" and e["lat"] is not None]
    ylats = [e["lat"] for e in events if e["type"] == "yield" and e["lat"] is not None]
    r_r, n_resp = rate("response")
    r_y, n_yield = rate("yield")
    s_bc, n_bc = rate("backchannel")
    s_vt, n_vt = rate("vocal_tic")
    s_nd, n_nd = rate("non_directed")
    return {
        "L_R": sum(lats) / len(lats) if lats else None,
        "L_Y": sum(ylats) / len(ylats) if ylats else None,
        "R_R": r_r,
        "R_Y": r_y,
        "S_BC": s_bc,
        "S_VT": s_vt,
        "S_ND": s_nd,
        "counts": {
            "response": n_resp,
            "yield": n_yield,
            "backchannel": n_bc,
            "vocal_tic": n_vt,
            "non_directed": n_nd,
        },
    }


def report(payload: dict) -> None:
    errs = [p for p in payload["per_sim"] if p["error"]]
    print(f"\n=== {payload['label']}  ({len(payload['per_sim'])} sims, "
          f"{len(errs)} errored)")
    for p in errs:
        print(f"  ! {p['sim'][:8]} {p['error']}")
    hdr = f"{'policy':<12}{'L_R':>8}{'L_Y':>8}{'R_R':>8}{'R_Y':>8}{'S_BC':>8}{'S_VT':>8}{'S_ND':>8}"
    print(hdr)
    print("-" * len(hdr))
    for name, pol in payload["policies"].items():
        m = panel(pol["events"])
        def f(k, pct=True):
            v = m[k]
            if v is None:
                return f"{'—':>8}"
            return f"{v * 100:>7.1f}%" if pct else f"{v:>7.2f}s"
        print(f"{name:<12}{f('L_R', False)}{f('L_Y', False)}{f('R_R')}{f('R_Y')}"
              f"{f('S_BC')}{f('S_VT')}{f('S_ND')}")
    c = panel(next(iter(payload["policies"].values()))["events"])["counts"]
    print(f"\nevent counts: {c}")
    for name, pol in payload["policies"].items():
        print(f"  {name:<12} truncated {pol['truncated_kb']:>6} KB   "
              f"agent speaking ticks {pol['speaking_ticks']}")


if __name__ == "__main__":
    main()
