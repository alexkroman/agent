#!/usr/bin/env python3
"""Replay a recorded tau2 voice session against AssemblyAI's Voice Agent API.

**No AAI SDK in the path.** This speaks the documented Voice Agent API wire
format itself (`wss://agents.assemblyai.com/v1/ws`, inline `session.update`,
`input.audio`, `tool.call`/`tool.result`), so a score difference against a
`--audio-native-provider aai` run localises to our stack rather than to the
service. See https://www.assemblyai.com/docs/voice-agents/voice-agent-api

What it replays: the USER channel (left) of a run's `artifacts/**/audio/both.wav`,
byte-identical, paced in real time. `audio/user_labels.txt` supplies the ground
truth for what the caller said and when, so "did the service hear the caller"
is measurable rather than inferred.

Tools execute for real against a fresh copy of the domain's database, so the
conversation can actually progress and tool arguments are worth reading.

Known limitation, and the reason the report leads with transcription rather than
task success: the recorded caller audio was produced against a DIFFERENT agent's
turn-taking, so this agent hears a caller whose pauses are not responsive to it.
Recall of the caller's utterances and the arguments of the tool calls are robust
to that; conversational outcome is not.

This is the S2S counterpart of `replay.py` next to it (which measures the
interaction panel against a PIPELINE agent) and follows the same convention: run
it from the tau2-bench checkout under that project's environment, since tau2
owns the domains, the audio helpers and the archived runs.

    export ASSEMBLYAI_API_KEY=...
    cd ~/Code/tau2-bench
    uv run python ~/Code/aai/agent/scripts/voice-replay/vaapi_replay.py \
        --run retail-stt-voice-api-948 --task 0

    # Same audio and pacing through OUR host-mode server, for the A/B:
    uv run python ~/Code/aai/agent/scripts/voice-replay/vaapi_replay.py \
        --run retail-stt-voice-api-948 --task 0 --prompt tau2 \
        --target aai-host --host-url "ws://localhost:3002/websocket?host=1"

`--sims-root` (or `$TAU2_SIMS_ROOT`) overrides where runs are looked up when the
working directory is not the checkout.

Note `--target aai-host` drives OUR host-mode server, which loads the SDK from
`packages/aai/dist` — the `@dev/source` condition is not set for the CLI — so
rebuild `packages/aai` before trusting a result: a source-only change silently
replays the previous build.
"""

from __future__ import annotations

import argparse
import array
import ast
import asyncio
import base64
import json
import os
import re
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, Optional

import websockets
from dotenv import find_dotenv, load_dotenv

from tau2.agent.discrete_time_audio_native_agent import (  # noqa: E402
    AUDIO_NATIVE_SYSTEM_PROMPT_PLAIN,
    AUDIO_NATIVE_VOICE_INSTRUCTION,
)
from tau2.data_model.audio import (  # noqa: E402
    AudioData,
    AudioEncoding,
    AudioFormat,
)
from tau2.registry import registry  # noqa: E402
from tau2.voice.utils.audio_preprocessing import (  # noqa: E402
    convert_to_ulaw,
    resample_audio,
)

# Anchored to the WORKING directory, not this file: the script lives in the
# agent repo but is run from the tau2 checkout, whose .env holds the
# production key that matches the archived runs. Defaulting to the script's
# own tree walks up into the agent repo and picks up a different key, which
# the service rejects with a bare 1008.
load_dotenv(find_dotenv(usecwd=True))

VAAPI_URL = "wss://agents.assemblyai.com/v1/ws"

# Set from --sims-root before any lookup; the env var is the fallback.
_SIMS_ROOT_OVERRIDE: Optional[str] = None


def simulations_root() -> Path:
    """Where archived runs live — `data/simulations` under the tau2 checkout.

    Relative to the working directory by default, matching the sibling
    `replay.py`'s "run it from tau2-bench" convention. `$TAU2_SIMS_ROOT`
    overrides it for a run from anywhere else.
    """
    override = _SIMS_ROOT_OVERRIDE or os.environ.get("TAU2_SIMS_ROOT")
    root = Path(override).expanduser() if override else Path("data/simulations")
    if not root.is_dir():
        raise SystemExit(
            f"no archived runs at {root.resolve()} — run this from the tau2-bench "
            "checkout, or set $TAU2_SIMS_ROOT / pass --sim with a full path."
        )
    return root


# Recorded tau2 audio is telephony PCM16 at 8 kHz (the wav's own rate).
SOURCE_RATE = 8000

# The two encodings the service accepts for this corpus.
#   pcm  — 24 kHz PCM16. What the SDK's S2S transport pins and sends, so this is
#          the control arm: it forces an 8k -> 24k upsample of telephony audio.
#   pcmu — 8 kHz G.711 mu-law. tau2's NATIVE format, so nothing is resampled at
#          all. The docs recommend it for telephony for exactly this reason.
ENCODINGS = {
    "pcm": ("audio/pcm", 24000),
    "pcmu": ("audio/pcmu", 8000),
}

# How much audio rides in each input.audio frame. The service rejects
# faster-than-real-time input with session.error/audio_rate_violation, so the
# send loop paces against a monotonic schedule rather than sleeping per chunk.
CHUNK_MS = 100

# ── The SDK's own prompt scaffolding, ported verbatim ────────────────────────
#
# Only used under `--prompt sdk`. The point is a controlled A/B: a bare client
# sending tau2's prompt alone differs from the SDK arm in TWO ways (the wire
# layer and the prompt), and this collapses it to one. Sources:
#   packages/aai/sdk/agent-defaults.ts   DEFAULT_SYSTEM_PROMPT
#   packages/aai/sdk/system-prompt.ts    TOOL_PREAMBLE, VOICE_RULES
#   packages/aai/host/builtin-tools.ts   the four builtins' `guidance`
SDK_DEFAULT_SYSTEM_PROMPT = """\
You are a voice agent in a real-time spoken conversation. What you
receive is a live speech transcript, and everything you write will be
spoken aloud by a text-to-speech system. Agent-specific instructions
may follow this prompt; where they conflict with these defaults, the
agent-specific instructions win.

## SPEAKING
- Be brief. One or two short sentences per turn is the target. Every
  extra sentence is time the user spends listening instead of talking.
- Speak plainly, as you would out loud to a friend. No markdown, no
  bullet points, no code, no headings — none of it can be spoken. To
  list things, say "First," "Next," "Finally," and never read out more
  than three items; offer to narrow down instead.
- Say numbers, amounts, and dates the way a person says them ("one
  hundred fifty-four dollars, on March third").
- Ask at most one question per turn, and make it the one that unblocks
  the most.
- Don't repeat the user's request back to them, don't recap what you
  just did unless asked, and vary your openers — don't start consecutive
  replies with the same acknowledgment.
- If the user interrupts, stop and address what they said.
- Never verbalize internal reasoning, tool names, or system mechanics.

## LISTENING
- The transcript carries fillers, pauses, false starts, and
  self-corrections. Read through the noise to the user's final intent
  and act on it. When they correct themselves ("Boston... actually,
  Chicago"), use only the last value.
- Ask the user to repeat something at most once, and only when a value
  you truly need is unintelligible — otherwise act on your best
  understanding rather than stalling.
- When a spoken value fails a lookup, it was probably misheard.
  Repeating it returns the same guess ("Sean" and "Shawn" sound
  identical), so ask for it letter by letter as words ("M as in Mike")
  and trust the spelling over what you heard. Digits transcribe more
  reliably than names — prefer a number when one is accepted.
- When the user spells a code ("B O B 1 2"), join the characters into
  one token (BOB12). A spelled-out name is still a name (Maria Garza,
  not MARIA GARZA). Don't read spelled input back letter by letter —
  confirm briefly and move on.

## TOOLS
- Never fabricate. If you don't know something, look it up with a tool;
  if no tool can answer it, say so. Never state data from memory that a
  tool can retrieve.
- Act first, ask second: if the user's words contain everything a tool
  needs, call it immediately. Ask only when a required value is
  genuinely missing — and never fill one with a placeholder or a guess.
  A date, time, or priority the user hasn't stated is theirs to give,
  not yours to pick.
- Copy values from prior tool results exactly. Never retype, reformat,
  or construct an ID from a pattern — if you don't have it, look it up
  first, then use it.
- Finish the whole request: every task in the user's message gets
  completed or explicitly addressed. Never stop halfway and ask "shall
  I continue?".
- On a tool error, read the message. Fix the specific problem and retry
  once with something actually different — never resend arguments that
  already failed, and never pretend a failed call succeeded.
- Before an action that is hard to undo, state what you are about to do
  and get a clear yes. When the user's request already says exactly what
  to do, that request is the authorization — execute it.
- Use a calculator tool for any arithmetic you are about to say out
  loud, if one exists. Never compute in your head.
- If a tool fails or returns nothing, answer as naturally as you can
  without explaining the failure."""

SDK_TOOL_PREAMBLE = (
    "\n\nBefore the FIRST tool call of a turn, say a brief natural phrase "
    '(e.g. "Let me look that up" or "One moment while I check"). '
    "This fills silence while the tool executes. Keep it to one short sentence.\n"
    "\nSay it ONCE PER TURN, not once per tool call. If you need several tools to answer, stay "
    "silent between them and speak again when you have the answer. Narrating each step "
    '("I will check the next order. I will keep checking your orders.") tells the caller nothing '
    "they need and makes a short wait sound like a long one.\n"
    "\nNEVER tell the caller an action is done unless a tool call returned a successful result for "
    "it. Announcing an action is not performing it: if you say you are looking something up, "
    "booking, changing, moving, or cancelling it, you MUST make the matching tool call in that same "
    "turn. If you did not call the tool, or it returned an error, say what you still need — do not "
    "describe the action as complete. Never state a confirmation number, price, total, seat, or "
    "other detail that did not come from a tool result; if you need one, call the tool that returns "
    "it. Carrying something over (a seat, a bag allowance, a preference) is itself an action: it "
    "needs its own tool call, and does not happen because a related call succeeded.\n"
    "\nWhen the caller speaks an identifier — an order or confirmation number, a product code, an "
    "email — write it in its normal written form in the tool argument, not as it was spoken. Drop "
    'spoken separators ("K dash 2" is K2, "P dash five dash two" is P52) and join spelled-out '
    'letters and digits ("A B C one two three" is ABC123). Add nothing the caller did not say: '
    '"Z K 3 F F W" is ZK3FFW, never ZEDK3FFW. Write personal names in ordinary title case '
    '("Rivera", not "rivera"), matching how the record would store them.\n'
    "\nIf a lookup on something the caller spelled comes back not-found, treat a MIS-HEARING as the "
    "most likely cause before you assume the record is missing. Spoken letters are easily confused "
    "— F and S, B and P and V, D and G and T, M and N — so retry the lookup with the plausible "
    "alternatives first. Only ask the caller to repeat themselves after that, and when you do, ask "
    "for something DIFFERENT (another identifier, or just the one letter you are unsure of) rather "
    "than making them say the same thing again. Repeating the same request gets the same audio."
)

SDK_VOICE_RULES = (
    "\n\nCRITICAL OUTPUT RULES — you MUST follow these for EVERY response:\n"
    "Your response will be spoken aloud by a TTS system and displayed as plain text.\n"
    "- NEVER use markdown: no **, no *, no _, no #, no `, no [](), no ---\n"
    "- NEVER use bullet points (-, *, •) or numbered lists (1., 2.)\n"
    "- NEVER use code blocks or inline code\n"
    "- NEVER mention tools, search, APIs, or technical failures to the user. "
    "If a tool returns no results, just answer naturally without explaining why.\n"
    "- Write exactly as you would say it out loud to a friend\n"
    '- NEVER use contractions. Write every word out in full: "I will" not "I\'ll", '
    '"cannot" not "can\'t", "it is" not "it\'s", "do not" not "don\'t"\n'
    '- Use short conversational sentences. To list things, say "First," "Next," "Finally,"\n'
    "- Keep responses concise — 1 to 3 sentences max\n"
    "- Do NOT read out long lists. When a tool returns several items, say how many there are, name "
    "at most two, and ask which one they mean "
    '(e.g. "There are five items on that order — the headphones and the vacuum, plus three more. '
    'Which one do you want to return?"). Reading every item invites the caller to interrupt, and '
    "everything after the interruption is never heard.\n"
    "- When the caller spells something (a name, email, or ID) or reads out digits, do NOT "
    "read the whole thing back letter by letter — it is slow and invites interruptions. "
    'Confirm briefly and move on (e.g. "Thanks, got it" or "Okay, Yusuf Rossi, ZIP 1-9-1-2-2 — one moment"). '
    "Only re-spell a specific character if you need to resolve a genuine ambiguity."
)

# The four builtins the SDK merges into every host-mode session's tool surface,
# with the `guidance` it appends to the prompt. Declared and executed here so
# `--builtins` reproduces the SDK arm's tool surface exactly; without it the
# bare arm shows the model four fewer tools than the SDK arm did.
BUILTIN_TOOLS: list[dict[str, Any]] = [
    {
        "type": "function",
        "name": "think",
        "description": (
            "Use the tool to think about something. It will not obtain new information or change "
            "the database, but just append the thought to the log. Use it when complex reasoning "
            "or some cache memory is needed."
        ),
        "parameters": {
            "type": "object",
            "properties": {"thought": {"type": "string", "description": "A thought to think about."}},
            "required": ["thought"],
        },
    },
    {
        "type": "function",
        "name": "remember",
        "description": (
            "Save a confirmed fact to private session notes under a short key (e.g. user_id, "
            "order_id, reservation_code). Overwrites any previous value for that key and returns "
            "all notes. Use it right after a value is confirmed, so later steps can recall the "
            "exact value instead of re-reading a noisy transcript."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "key": {
                    "type": "string",
                    "description": 'Short snake_case label for the fact (e.g. "user_id", "reservation_code")',
                },
                "value": {"type": "string", "description": "The exact value to store, verbatim"},
            },
            "required": ["key", "value"],
        },
    },
    {
        "type": "function",
        "name": "recall",
        "description": (
            "Read private session notes saved with remember. Pass a key to get one value, or no "
            "key to list every saved note. Notes are per-session and never shown to the customer."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "key": {"type": "string", "description": "The note key to read. Omit to list all notes."}
            },
        },
    },
    {
        "type": "function",
        "name": "calculate",
        "description": (
            "Evaluate an arithmetic expression and return the exact numeric result. Supports + - * "
            "/ % (remainder), ^ (power), parentheses, unary minus, and decimal numbers (currency "
            "symbols and commas are ignored). Use for ALL math: totals, differences, taxes, refunds."
        ),
        "parameters": {
            "type": "object",
            "properties": {
                "expression": {
                    "type": "string",
                    "description": 'Arithmetic expression to evaluate, e.g. "(120.50 + 35) * 0.925"',
                }
            },
            "required": ["expression"],
        },
    },
]

# Keyed by tool, because guidance follows the builtins that were actually
# RESOLVED: a builtin shadowed by a domain tool of the same name contributes
# neither a schema nor a line of prompt. `recall` has no guidance in the SDK.
BUILTIN_GUIDANCE = {
    "think": "Before any write action, and after any tool result that is unexpected or an error, "
    "use the think tool as a private scratchpad: list the specific policy rules that apply, "
    "check that you have every required argument, and verify the planned action complies. "
    "Thoughts are never shown or spoken to the customer.",
    "remember": "The moment a tool result or the customer confirms an important value (an ID, code, "
    "name, or date), save it with remember. Before using such a value in a later tool call, "
    "recall it instead of retyping it from the conversation.",
    "calculate": "Use calculate for ALL arithmetic — totals, differences, fees, percentages, refund "
    "amounts. Never compute numbers in your head.",
}


# ── Recorded session ────────────────────────────────────────────────────────


@dataclass
class GoldUtterance:
    start_s: float
    end_s: float
    text: str


@dataclass
class RecordedSession:
    """One recorded tau2 simulation: the caller's audio plus its ground truth."""

    path: Path
    user_pcm16_8k: bytes
    gold: list[GoldUtterance]

    @property
    def duration_s(self) -> float:
        return len(self.user_pcm16_8k) / (SOURCE_RATE * 2)


def load_recorded_session(sim_dir: Path) -> RecordedSession:
    """Extract the caller's channel and gold utterances from a sim's artifacts.

    `both.wav` is stereo with the USER on the LEFT channel and the assistant on
    the right (see `voice/utils/conversation_builder.py`). Taking the left
    channel gives the exact bytes the caller spoke, background noise bed
    included — the interferer is part of the test, not something to clean up.
    """
    wav_path = sim_dir / "audio" / "both.wav"
    if not wav_path.exists():
        raise FileNotFoundError(f"no recorded audio at {wav_path}")

    with wave.open(str(wav_path)) as w:
        if w.getsampwidth() != 2:
            raise ValueError(f"expected 16-bit audio, got {w.getsampwidth() * 8}-bit")
        if w.getframerate() != SOURCE_RATE:
            raise ValueError(f"expected {SOURCE_RATE} Hz, got {w.getframerate()} Hz")
        frames = w.readframes(w.getnframes())
        channels = w.getnchannels()

    if channels == 1:
        user_pcm16 = frames
    else:
        samples = array.array("h")
        samples.frombytes(frames)
        left = samples[0::channels]
        user_pcm16 = left.tobytes()

    return RecordedSession(
        path=sim_dir,
        user_pcm16_8k=user_pcm16,
        gold=_read_labels(sim_dir / "audio" / "user_labels.txt"),
    )


def read_tick_durations(sim_dir: Path) -> list[float]:
    """The wall-clock each tick of the original run actually took.

    tau2's discrete-time loop sends one tick of audio (200 ms) per iteration and
    enforces a MINIMUM tick duration, not a maximum — so orchestrator overhead
    (the user simulator's LLM calls, its TTS) makes a tick run LONG, and the
    audio stream is then delivered slower than real time. Replaying these
    durations instead of a real-time schedule reproduces the harness's actual
    delivery timing with nothing else changed.
    """
    log = sim_dir / "task.log"
    if not log.exists():
        return []
    text = log.read_text(encoding="utf-8", errors="replace")
    return [float(v) for v in re.findall(r"Wall-clock duration: ([\d.]+)s", text)]


def _read_labels(path: Path) -> list[GoldUtterance]:
    """Parse an Audacity-style label file: `start\tend\ttext`."""
    if not path.exists():
        return []
    out: list[GoldUtterance] = []
    for line in path.read_text(encoding="utf-8").splitlines():
        parts = line.split("\t", 2)
        if len(parts) != 3:
            continue
        try:
            out.append(GoldUtterance(float(parts[0]), float(parts[1]), parts[2].strip()))
        except ValueError:
            continue
    return out


def resolve_sim_dir(run: str, task: Optional[int], sim: Optional[str]) -> Path:
    """Locate one simulation's artifact directory."""
    if sim:
        return Path(sim).expanduser().resolve()
    root = simulations_root() / run / "artifacts"
    if not root.is_dir():
        raise FileNotFoundError(f"no artifacts under {root}")
    task_dirs = (
        [root / f"task_{task}"] if task is not None else sorted(root.glob("task_*"))
    )
    for task_dir in task_dirs:
        # A retried task has several sims; the LAST one is the attempt whose
        # score `results.json` reports (a retry overwrites the earlier score).
        sims = sorted(
            (d for d in task_dir.glob("sim_*") if (d / "audio" / "both.wav").exists()),
            key=lambda d: (d / "audio" / "both.wav").stat().st_mtime,
        )
        if sims:
            return sims[-1]
    raise FileNotFoundError(f"no sim with recorded audio under {root}")


# ── Wire client ─────────────────────────────────────────────────────────────


def encode_for_wire(pcm16_8k: bytes, encoding: str) -> bytes:
    """Convert the recorded caller audio into the declared wire encoding."""
    audio = AudioData(
        data=pcm16_8k,
        format=AudioFormat(
            encoding=AudioEncoding.PCM_S16LE, sample_rate=SOURCE_RATE, channels=1
        ),
    )
    if encoding == "pcmu":
        return convert_to_ulaw(audio).data
    return resample_audio(audio, ENCODINGS["pcm"][1]).data


def build_tool_schemas(tools: list[Any]) -> list[dict[str, Any]]:
    """tau2 `Tool` -> Voice Agent API function schema (flat, not OpenAI-nested)."""
    schemas = []
    for tool in tools:
        fn = tool.openai_schema["function"]
        schemas.append(
            {
                "type": "function",
                "name": fn["name"],
                "description": fn["description"],
                "parameters": fn["parameters"],
            }
        )
    return schemas


def build_system_prompt(policy: str, style: str, builtin_names: list[str]) -> str:
    """Compose the system prompt.

    `tau2` is the benchmark's own prompt, exactly what the harness injects.
    `sdk` wraps it the way our runtime does, so the only remaining difference
    against an `--audio-native-provider aai` run is the wire layer itself.
    """
    tau2_prompt = AUDIO_NATIVE_SYSTEM_PROMPT_PLAIN.format(
        agent_instruction=AUDIO_NATIVE_VOICE_INSTRUCTION, domain_policy=policy
    )
    if style == "tau2":
        return tau2_prompt

    today = time.strftime("%A, %B ") + str(int(time.strftime("%d"))) + time.strftime(", %Y")
    lines = [BUILTIN_GUIDANCE[name] for name in builtin_names if name in BUILTIN_GUIDANCE]
    guidance = f"\n\nBuilt-in Tool Usage:\n{chr(10).join(lines)}" if lines else ""
    return (
        SDK_DEFAULT_SYSTEM_PROMPT
        + f"\n\nToday's date is {today}."
        + f"\n\nAgent-Specific Instructions:\n{tau2_prompt}"
        + SDK_TOOL_PREAMBLE
        + guidance
        + SDK_VOICE_RULES
    )


@dataclass
class Wire:
    """One replay target's connect + framing, normalised to Voice Agent API names.

    The report only ever sees Voice Agent API event names, so the same metrics
    apply to both targets and the comparison is arithmetic rather than judgement.
    """

    url: str
    headers: dict[str, str]
    handshake: str
    audio_frame: Any  # bytes -> str | bytes
    tool_result: Any  # dict -> str
    normalize: Any  # dict -> dict
    end_frame: Optional[str]


def _vaapi_wire(
    args: argparse.Namespace, session_block: dict[str, Any], _tools: list[dict[str, Any]]
) -> Wire:
    """Speak the Voice Agent API directly — no SDK in the path."""
    api_key = os.environ["ASSEMBLYAI_API_KEY"]
    return Wire(
        url=VAAPI_URL,
        headers={"Authorization": f"Bearer {api_key}"},
        handshake=json.dumps({"type": "session.update", "session": session_block}),
        audio_frame=lambda chunk: json.dumps(
            {"type": "input.audio", "audio": base64.b64encode(chunk).decode("ascii")}
        ),
        tool_result=lambda item: json.dumps(
            {
                "type": "tool.result",
                "call_id": item["call_id"],
                "result": item["result"],
                "is_error": item["is_error"],
            }
        ),
        normalize=lambda event: event,
        end_frame=json.dumps({"type": "session.end"}),
    )


# Our host protocol's server->client names, mapped onto the Voice Agent API's.
# `cancelled` is the host's rendering of `reply.done{status:"interrupted"}`, so
# it has to fold back into a reply.done or the interrupted count reads as zero.
_HOST_EVENT_MAP = {
    "config": "session.ready",
    "speech_started": "input.speech.started",
    "speech_stopped": "input.speech.stopped",
    "user_transcript": "transcript.user",
    "user_transcript_partial": "transcript.user.delta",
    "agent_transcript": "transcript.agent",
    "tool_call": "tool.call",
    "reply_done": "reply.done",
    "error": "session.error",
}


def _normalize_host_event(event: dict[str, Any]) -> dict[str, Any]:
    etype = event.get("type", "?")
    if etype == "cancelled":
        return {**event, "type": "reply.done", "status": "interrupted"}
    mapped = _HOST_EVENT_MAP.get(etype)
    if mapped is None:
        return event
    out = {**event, "type": mapped}
    if mapped == "session.ready":
        out["session_id"] = event.get("sessionId")
    elif mapped == "tool.call":
        out["call_id"] = event.get("toolCallId")
        out["name"] = event.get("toolName")
        out["arguments"] = event.get("args") or {}
    elif mapped == "reply.done":
        out.setdefault("status", "completed")
    return out


def _aai_host_wire(
    args: argparse.Namespace, session_block: dict[str, Any], tools: list[dict[str, Any]]
) -> Wire:
    """Speak OUR host-mode protocol, which relays into the same service.

    Same audio, same pacing, same prompt, same tools as the `vaapi` target — so
    a divergence between the two arms is our stack and nothing else. Needs a
    host-mode server accepting `?host=1` (`AAI_ALLOW_HOST=1 aai dev`, with
    `AAI_S2S=1` for the S2S transport under test).
    """
    _, wire_rate = ENCODINGS[args.encoding]
    if args.encoding != "pcm":
        raise SystemExit("--target aai-host speaks PCM16 only; use --encoding pcm")
    host_block: dict[str, Any] = {
        "systemPrompt": session_block["system_prompt"],
        "tools": tools,
    }
    if session_block.get("greeting"):
        host_block["greeting"] = session_block["greeting"]
    return Wire(
        url=args.host_url,
        headers={},
        handshake=json.dumps(
            {
                "type": "config",
                "audioFormat": "pcm16",
                "sampleRate": wire_rate,
                "ttsSampleRate": wire_rate,
                "host": host_block,
            }
        ),
        # Binary frames, not base64 JSON — the host protocol's audio encoding.
        audio_frame=lambda chunk: chunk,
        tool_result=lambda item: json.dumps(
            {
                "type": "tool_result",
                "toolCallId": item["call_id"],
                "result": item["result"],
            }
        ),
        normalize=_normalize_host_event,
        # The host protocol has no client-initiated end frame; closing the socket
        # is the hangup.
        end_frame=None,
    )


TARGETS = {"vaapi": _vaapi_wire, "aai-host": _aai_host_wire}


@dataclass
class ReplayLog:
    """Everything the run observed, for the report and for the JSONL dump."""

    events: list[dict[str, Any]] = field(default_factory=list)
    user_finals: list[tuple[float, str]] = field(default_factory=list)
    user_partials: int = 0
    agent_transcripts: list[tuple[float, str, bool]] = field(default_factory=list)
    tool_calls: list[dict[str, Any]] = field(default_factory=list)
    replies_started: list[float] = field(default_factory=list)
    replies_done: list[tuple[float, str]] = field(default_factory=list)
    speech_started: list[float] = field(default_factory=list)
    errors: list[dict[str, Any]] = field(default_factory=list)
    audio_bytes: int = 0
    audio_chunks: list[bytes] = field(default_factory=list)
    session_id: Optional[str] = None
    ready_at: Optional[float] = None
    closed: Optional[dict[str, Any]] = None


class BuiltinExecutor:
    """The four SDK builtins, executed locally exactly as the host does.

    They never reach the domain environment — in the SDK arm they run host-side
    and are invisible to the client too, so intercepting them here keeps the
    tool surfaces comparable without polluting the domain's tool-call record.
    """

    def __init__(self) -> None:
        self.notes: dict[str, str] = {}
        # Builtin names a domain tool already claims. Those calls belong to the
        # DOMAIN tool and must reach the environment, so `handles()` excludes them.
        self.shadowed: set[str] = set()

    @property
    def names(self) -> set[str]:
        return {"think", "remember", "recall", "calculate"}

    def handles(self, name: str) -> bool:
        return name in self.names and name not in self.shadowed

    def execute(self, name: str, args: dict[str, Any]) -> Any:
        if name == "think":
            return "ok"
        if name == "remember":
            self.notes[str(args.get("key", ""))] = str(args.get("value", ""))
            return {"saved": args.get("key"), "notes": dict(self.notes)}
        if name == "recall":
            key = args.get("key")
            if key is not None:
                return {"key": key, "value": self.notes.get(str(key))}
            return {"notes": dict(self.notes)}
        if name == "calculate":
            expr = str(args.get("expression", ""))
            value = _safe_arithmetic(expr)
            if value is None:
                return {"error": "could not evaluate expression", "expression": expr}
            return {"expression": expr, "result": value}
        raise KeyError(name)


_ARITHMETIC_BINOPS = {
    ast.Add: lambda a, b: a + b,
    ast.Sub: lambda a, b: a - b,
    ast.Mult: lambda a, b: a * b,
    ast.Div: lambda a, b: a / b,
    ast.Mod: lambda a, b: a % b,
    ast.Pow: lambda a, b: a**b,
}

# Cap the exponent: the expression is model-controlled, and `9**9**9` is a hang
# rather than an error. Anything a refund calculation needs is far below this.
_MAX_EXPONENT = 32


def _safe_arithmetic(expr: str) -> Optional[float]:
    """Evaluate an arithmetic expression by walking its AST.

    Deliberately not `eval`: the expression comes from the model, so the only
    safe reading is a whitelist of numeric node types. Anything else — a name, a
    call, a subscript — returns None and the model gets an error result back.
    """
    cleaned = re.sub(r"[$,\s]", "", expr).replace("^", "**")
    try:
        tree = ast.parse(cleaned, mode="eval")
    except SyntaxError:
        return None

    def evaluate(node: ast.AST) -> float:
        if isinstance(node, ast.Constant):
            if isinstance(node.value, bool) or not isinstance(node.value, (int, float)):
                raise ValueError("non-numeric literal")
            return float(node.value)
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            value = evaluate(node.operand)
            return -value if isinstance(node.op, ast.USub) else value
        if isinstance(node, ast.BinOp):
            op = _ARITHMETIC_BINOPS.get(type(node.op))
            if op is None:
                raise ValueError("unsupported operator")
            left, right = evaluate(node.left), evaluate(node.right)
            if isinstance(node.op, ast.Pow) and abs(right) > _MAX_EXPONENT:
                raise ValueError("exponent too large")
            return op(left, right)
        raise ValueError("unsupported expression")

    try:
        return evaluate(tree.body)
    except (ValueError, ZeroDivisionError, OverflowError):
        return None


async def replay(args: argparse.Namespace, session: RecordedSession) -> ReplayLog:
    """Stream one recorded session through the target and record what came back.

    Two targets, same audio and same pacing, so a difference between them is our
    stack and nothing else:

    - `vaapi`    — the Voice Agent API directly. No SDK anywhere in the path.
    - `aai-host` — our own host-mode WebSocket (`aai dev` with AAI_S2S=1), which
      relays into the same service through `connectS2s` + `createS2sTransport`.
    """
    api_key = os.environ.get("ASSEMBLYAI_API_KEY", "")
    if not api_key and args.target == "vaapi":
        raise SystemExit("ASSEMBLYAI_API_KEY is not set")

    env = registry.get_env_constructor(args.domain)()
    tools = env.get_tools()
    builtins = BuiltinExecutor() if args.builtins else None

    tool_schemas = build_tool_schemas(tools)
    if builtins:
        # Relayed tools first, then builtins — the order `mergeBuiltinSurface`
        # produces, so the model sees the same list in the same order. A builtin
        # whose name a domain tool already uses is DROPPED, not shadowed: retail
        # ships its own `calculate`, and declaring the name twice is a malformed
        # tool list the service accepts silently (per the docs, `parameters` is
        # not validated at session.update time).
        provided = {schema["name"] for schema in tool_schemas}
        declared_builtins = [s for s in BUILTIN_TOOLS if s["name"] not in provided]
        tool_schemas = tool_schemas + declared_builtins
        builtins.shadowed = provided & builtins.names
        builtin_names = [s["name"] for s in declared_builtins]
    else:
        builtin_names = []

    encoding_name, wire_rate = ENCODINGS[args.encoding]
    wire_audio = encode_for_wire(session.user_pcm16_8k, args.encoding)
    bytes_per_second = wire_rate * (1 if args.encoding == "pcmu" else 2)
    chunk_bytes = int(bytes_per_second * args.chunk_ms / 1000)

    tick_durations: list[float] = []
    if args.pace_from_log:
        tick_durations = read_tick_durations(session.path)
        if not tick_durations:
            raise SystemExit(f"--pace-from-log needs tick timings in {session.path}/task.log")
        if args.chunk_ms != 200:
            # One measured duration corresponds to one 200ms tick of audio.
            raise SystemExit("--pace-from-log requires --chunk-ms 200 (tau2's tick size)")

    session_block: dict[str, Any] = {
        "system_prompt": build_system_prompt(env.get_policy(), args.prompt, builtin_names),
        "greeting": args.greeting,
        "tools": tool_schemas,
        "input": {"format": {"encoding": encoding_name, "sample_rate": wire_rate}},
        "output": {"format": {"encoding": encoding_name, "sample_rate": wire_rate}},
    }
    if args.voice:
        session_block["output"]["voice"] = args.voice
    turn_detection = {}
    if args.min_silence is not None:
        turn_detection["min_silence"] = args.min_silence
    if args.max_silence is not None:
        turn_detection["max_silence"] = args.max_silence
    if turn_detection:
        session_block["input"]["turn_detection"] = turn_detection

    # The transcription-side knobs. Our pipeline path pins every one of these
    # after measuring them on this benchmark; `S2sSessionConfig` cannot express
    # any of them, so an S2S session runs on service defaults throughout. These
    # flags are how that gap gets measured rather than argued about.
    if args.languages:
        session_block["input"]["language_codes"] = args.languages.split(",")
    if args.keyterms:
        session_block["input"]["keyterms"] = [k for k in args.keyterms.split(",") if k]
    if args.transcription_prompt:
        session_block["input"]["transcription_prompt"] = args.transcription_prompt
    if args.voice_focus_threshold is not None:
        session_block["input"]["voice_focus"] = args.voice_focus
        session_block["input"]["voice_focus_threshold"] = args.voice_focus_threshold

    if args.dry_run:
        print("dry run — not connecting")
        print(f"  url            {VAAPI_URL}")
        print(f"  encoding       {encoding_name} @ {wire_rate} Hz")
        print(f"  wire audio     {len(wire_audio)} bytes ({len(wire_audio) / bytes_per_second:.1f}s)")
        print(f"  chunk          {chunk_bytes} bytes / {args.chunk_ms}ms")
        print(f"  tools          {len(tool_schemas)}: {[t['name'] for t in tool_schemas]}")
        print(f"  system_prompt  {len(session_block['system_prompt'])} chars")
        print(f"  greeting       {session_block['greeting']!r}")
        print(f"  input/output   {json.dumps(session_block['input'])} / {json.dumps(session_block['output'])}")
        probe = env.to_json_str(
            env.make_tool_call(
                "find_user_id_by_name_zip", first_name="Yusuf", last_name="Rossi", zip="19122"
            )
        )
        print(f"  tool probe     find_user_id_by_name_zip -> {probe}")
        return ReplayLog()

    log = ReplayLog()
    t0 = time.monotonic()

    def elapsed() -> float:
        return time.monotonic() - t0

    wire = TARGETS[args.target](args, session_block, tool_schemas)

    print(
        f"→ {wire.url}  encoding={encoding_name}@{wire_rate}  prompt={args.prompt}"
        f"  tools={len(tool_schemas)}  chunk={args.chunk_ms}ms  audio={session.duration_s:.1f}s",
        flush=True,
    )

    async with websockets.connect(
        wire.url, additional_headers=wire.headers, max_size=None
    ) as ws:
        await ws.send(wire.handshake)

        ready = asyncio.Event()
        finished = asyncio.Event()
        # Tool results wait for `reply.done` to be the latest event received —
        # the documented gate. Sending earlier lands mid-transition-phrase and
        # sending later collides with the next turn.
        pending: list[dict[str, Any]] = []
        last_event: Optional[str] = None

        async def flush_if_idle() -> None:
            nonlocal pending
            if last_event != "reply.done" or not pending:
                return
            for item in pending:
                await ws.send(wire.tool_result(item))
                print(f"  [{elapsed():6.1f}s] tool.result -> {item['name']}", flush=True)
            pending = []

        def run_tool(name: str, tool_args: dict[str, Any]) -> tuple[str, bool]:
            if builtins and builtins.handles(name):
                try:
                    return json.dumps(builtins.execute(name, tool_args), default=str), False
                except Exception as exc:  # noqa: BLE001 - reported to the model
                    return f"Error: {exc}", True
            try:
                result = env.make_tool_call(name, **tool_args)
                env.sync_tools()
                return env.to_json_str(result), False
            except Exception as exc:  # noqa: BLE001 - the model must see this
                return f"Error: {exc}", True

        async def receive() -> None:
            nonlocal last_event
            async for raw in ws:
                # Our host protocol carries agent audio as BINARY frames; the
                # Voice Agent API base64s it inside `reply.audio`. Both land here.
                if isinstance(raw, bytes):
                    log.audio_bytes += len(raw)
                    log.audio_chunks.append(raw)
                    continue
                event = wire.normalize(json.loads(raw))
                etype = event.get("type", "?")

                if etype == "reply.audio":
                    data = base64.b64decode(event.get("data", ""))
                    log.audio_bytes += len(data)
                    log.audio_chunks.append(data)
                    continue

                log.events.append({"at": round(elapsed(), 3), **event})

                if etype == "session.ready":
                    log.session_id = event.get("session_id")
                    log.ready_at = elapsed()
                    ready.set()
                elif etype == "session.updated":
                    ready.set()
                elif etype == "input.speech.started":
                    log.speech_started.append(elapsed())
                    last_event = etype
                elif etype == "transcript.user.delta":
                    log.user_partials += 1
                elif etype == "transcript.user":
                    log.user_finals.append((elapsed(), event.get("text", "")))
                    print(f"  [{elapsed():6.1f}s] user: {event.get('text', '')}", flush=True)
                elif etype == "reply.started":
                    log.replies_started.append(elapsed())
                    last_event = etype
                elif etype == "transcript.agent":
                    log.agent_transcripts.append(
                        (elapsed(), event.get("text", ""), bool(event.get("interrupted")))
                    )
                    print(f"  [{elapsed():6.1f}s] agent: {event.get('text', '')}", flush=True)
                elif etype == "tool.call":
                    name = event.get("name", "")
                    tool_args = event.get("arguments") or event.get("args") or {}
                    log.tool_calls.append(
                        {"at": round(elapsed(), 3), "name": name, "arguments": tool_args}
                    )
                    print(f"  [{elapsed():6.1f}s] tool.call {name}({json.dumps(tool_args)})", flush=True)
                    result, is_error = run_tool(name, tool_args)
                    pending.append(
                        {
                            "call_id": event.get("call_id"),
                            "name": name,
                            "result": result,
                            "is_error": is_error,
                        }
                    )
                    # The tool may have returned AFTER reply.done already fired.
                    await flush_if_idle()
                elif etype == "reply.done":
                    status = event.get("status", "completed")
                    log.replies_done.append((elapsed(), status))
                    last_event = etype
                    if status == "interrupted":
                        pending.clear()
                    else:
                        await flush_if_idle()
                elif etype in ("session.error", "error"):
                    log.errors.append({"at": elapsed(), **event})
                    print(
                        f"  [{elapsed():6.1f}s] !! {etype} {event.get('code', '')} "
                        f"{event.get('message', '')}",
                        flush=True,
                    )
                elif etype == "session.ended":
                    finished.set()
                    return

        receiver = asyncio.create_task(receive())

        try:
            await asyncio.wait_for(ready.wait(), timeout=30)
        except asyncio.TimeoutError:
            receiver.cancel()
            raise SystemExit("no session.ready within 30s")

        # Real-time pacing. The service rejects faster-than-real-time input
        # (`audio_rate_violation`), and a per-chunk sleep drifts late, so the
        # schedule is absolute: chunk N is due at start + N * chunk_ms.
        #
        # Under --pace-from-log the schedule is CUMULATIVE MEASURED instead:
        # frame N is due after the sum of the original run's first N tick
        # durations. That delivers the same bytes at the same (sub-real-time,
        # stall-prone) rate the harness did, which is the variable under test.
        stream_start = time.monotonic()
        cumulative = 0.0
        for index, offset in enumerate(range(0, len(wire_audio), chunk_bytes)):
            if receiver.done():
                break
            if tick_durations:
                # Ran out of measured ticks → fall back to nominal spacing.
                step = tick_durations[index] if index < len(tick_durations) else args.chunk_ms / 1000
                due = stream_start + cumulative
                cumulative += step
            else:
                due = stream_start + (index * args.chunk_ms) / 1000
            delay = due - time.monotonic()
            if delay > 0:
                await asyncio.sleep(delay)
            await ws.send(wire.audio_frame(wire_audio[offset : offset + chunk_bytes]))

        # Let the last turn land before hanging up.
        if not receiver.done():
            await asyncio.sleep(args.drain_seconds)

        if not receiver.done() and wire.end_frame is not None:
            await ws.send(wire.end_frame)
            try:
                await asyncio.wait_for(finished.wait(), timeout=10)
            except asyncio.TimeoutError:
                pass
        receiver.cancel()

    log.closed = {"at": elapsed()}
    return log


# ── Report ──────────────────────────────────────────────────────────────────

_WORD = re.compile(r"[a-z0-9]+")


def _tokens(text: str) -> list[str]:
    return _WORD.findall(text.lower())


def _spoken_digits_to_text(tokens: list[str]) -> list[str]:
    """Fold digit strings into their spoken words so `19122` matches `one nine ...`."""
    words = {
        "0": "zero", "1": "one", "2": "two", "3": "three", "4": "four",
        "5": "five", "6": "six", "7": "seven", "8": "eight", "9": "nine",
    }
    out: list[str] = []
    for token in tokens:
        if token.isdigit() and len(token) > 1:
            out.extend(words[c] for c in token)
        elif token.isdigit():
            out.append(words[token])
        else:
            out.append(token)
    return out


def report(args: argparse.Namespace, session: RecordedSession, log: ReplayLog) -> dict[str, Any]:
    """Summarise what the service heard and did, and print it."""
    gold_tokens: list[str] = []
    for utterance in session.gold:
        gold_tokens.extend(_spoken_digits_to_text(_tokens(utterance.text)))
    heard_tokens: set[str] = set()
    for _, text in log.user_finals:
        heard_tokens.update(_spoken_digits_to_text(_tokens(text)))

    matched = sum(1 for token in gold_tokens if token in heard_tokens)
    recall = matched / len(gold_tokens) if gold_tokens else 0.0

    # A gold utterance counts as heard if any final transcript overlaps its
    # content words. Timing alignment is not usable here — the replayed caller
    # is not responding to THIS agent — so this is a content check.
    heard_utterances = 0
    for utterance in session.gold:
        content = [t for t in _spoken_digits_to_text(_tokens(utterance.text)) if len(t) > 2]
        if content and sum(1 for t in content if t in heard_tokens) / len(content) >= 0.5:
            heard_utterances += 1

    audio_seconds = log.audio_bytes / (
        ENCODINGS[args.encoding][1] * (1 if args.encoding == "pcmu" else 2)
    )
    summary = {
        "sim": str(session.path),
        "encoding": args.encoding,
        "prompt": args.prompt,
        "builtins": bool(args.builtins),
        "session_id": log.session_id,
        "replayed_audio_s": round(session.duration_s, 1),
        "gold_utterances": len(session.gold),
        "user_finals": len(log.user_finals),
        "utterances_heard": heard_utterances,
        "word_recall": round(recall, 3),
        "user_partials": log.user_partials,
        "speech_started": len(log.speech_started),
        "replies_started": len(log.replies_started),
        "replies_completed": sum(1 for _, s in log.replies_done if s == "completed"),
        "replies_interrupted": sum(1 for _, s in log.replies_done if s == "interrupted"),
        "agent_transcripts": len(log.agent_transcripts),
        "tool_calls": len(log.tool_calls),
        "reply_audio_s": round(audio_seconds, 1),
        "errors": log.errors,
    }

    print("\n── replay summary ─────────────────────────────────────────")
    for key, value in summary.items():
        if key == "errors":
            continue
        print(f"  {key:22s} {value}")
    if log.errors:
        print(f"  {'errors':22s} {len(log.errors)}")
        for err in log.errors[:5]:
            print(f"      {err}")
    if log.tool_calls:
        print("\n  tool calls:")
        for call in log.tool_calls:
            print(f"    [{call['at']:6.1f}s] {call['name']}({json.dumps(call['arguments'])})")
    print()
    return summary


def write_artifacts(out_dir: Path, args: argparse.Namespace, summary: dict, log: ReplayLog) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    (out_dir / "summary.json").write_text(json.dumps(summary, indent=2), encoding="utf-8")
    with (out_dir / "events.jsonl").open("w", encoding="utf-8") as fh:
        for event in log.events:
            fh.write(json.dumps(event) + "\n")
    if log.audio_chunks:
        wire_rate = ENCODINGS[args.encoding][1]
        agent_audio = b"".join(log.audio_chunks)
        if args.encoding == "pcmu":
            # Store as PCM16 so the file is playable anywhere.
            from tau2.voice.utils.audio_preprocessing import convert_to_pcm16

            agent_audio = convert_to_pcm16(
                AudioData(
                    data=agent_audio,
                    format=AudioFormat(
                        encoding=AudioEncoding.ULAW, sample_rate=wire_rate, channels=1
                    ),
                )
            ).data
        with wave.open(str(out_dir / "agent.wav"), "wb") as w:
            w.setnchannels(1)
            w.setsampwidth(2)
            w.setframerate(wire_rate)
            w.writeframes(agent_audio)
    print(f"artifacts → {out_dir}")


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    source = parser.add_argument_group("recorded session")
    source.add_argument("--run", help="run name under data/simulations/")
    source.add_argument("--task", type=int, help="task index within the run")
    source.add_argument("--sim", help="path to a sim_* artifact directory (overrides --run/--task)")
    source.add_argument("--domain", default="retail", help="tau2 domain for tools + policy")
    source.add_argument(
        "--sims-root",
        default=None,
        help="where archived runs live (default: ./data/simulations, i.e. run from the checkout)",
    )

    arm = parser.add_argument_group("arm under test")
    arm.add_argument(
        "--target",
        choices=sorted(TARGETS),
        default="vaapi",
        help="vaapi = the Voice Agent API directly, no SDK. "
        "aai-host = our host-mode WebSocket, which relays into the same service.",
    )
    arm.add_argument(
        "--host-url",
        default="ws://localhost:3002/websocket?host=1",
        help="host-mode endpoint for --target aai-host",
    )
    arm.add_argument(
        "--chunk-ms",
        type=int,
        default=CHUNK_MS,
        help=f"audio per input frame (default {CHUNK_MS}). tau2's own adapter sends one "
        "frame per tick (200ms), so this is the knob for testing frame cadence.",
    )
    arm.add_argument(
        "--pace-from-log",
        action="store_true",
        help="deliver audio at the ORIGINAL run's measured tick rate (from its task.log) "
        "instead of real time — reproduces the harness's sub-real-time, stall-prone "
        "delivery. Requires --chunk-ms 200.",
    )
    arm.add_argument(
        "--encoding",
        choices=sorted(ENCODINGS),
        default="pcm",
        help="pcm = 24 kHz PCM16 (what the SDK pins; upsamples telephony audio). "
        "pcmu = 8 kHz mu-law, tau2's native format, no resampling. Default pcm.",
    )
    arm.add_argument(
        "--prompt",
        choices=("tau2", "sdk"),
        default="tau2",
        help="tau2 = the benchmark's prompt alone. sdk = wrapped the way our runtime wraps it.",
    )
    arm.add_argument(
        "--builtins",
        action="store_true",
        help="also declare think/remember/recall/calculate, as the SDK's host mode does",
    )
    arm.add_argument("--voice", default=None, help="output voice (default: service default)")
    arm.add_argument(
        "--greeting",
        default="Thank you for calling. How can I help you today?",
        help="spoken at session start; matches tau2's DEFAULT_AAI_GREETING",
    )
    arm.add_argument("--min-silence", type=int, default=None, help="turn_detection.min_silence (ms)")
    arm.add_argument("--max-silence", type=int, default=None, help="turn_detection.max_silence (ms)")

    stt = parser.add_argument_group(
        "transcription knobs (all reachable inline; NONE reachable through our S2S transport)"
    )
    stt.add_argument("--languages", default=None, help="input.language_codes, comma separated (e.g. en)")
    stt.add_argument("--keyterms", default=None, help="input.keyterms, comma separated (max 100)")
    stt.add_argument(
        "--transcription-prompt",
        default=None,
        help="input.transcription_prompt — biases transcription toward expected vocabulary (max 1750 chars)",
    )
    stt.add_argument("--voice-focus", default="near-field", help="input.voice_focus model")
    stt.add_argument(
        "--voice-focus-threshold",
        type=float,
        default=None,
        help="input.voice_focus_threshold (service default 0.7; our pipeline pins 0.9)",
    )
    arm.add_argument(
        "--drain-seconds",
        type=float,
        default=15.0,
        help="wait this long after the audio ends for the last turn to land",
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="resolve audio, tools and prompt and print the session config without connecting",
    )
    parser.add_argument("--out", default=None, help="artifact directory (default: <tau2>/data/vaapi_replay/<label>)")
    parser.add_argument("--label", default=None, help="artifact subdirectory name")

    args = parser.parse_args()
    if not args.sim and not args.run:
        parser.error("pass --sim, or --run (optionally with --task)")

    global _SIMS_ROOT_OVERRIDE
    _SIMS_ROOT_OVERRIDE = args.sims_root
    sim_dir = resolve_sim_dir(args.run, args.task, args.sim)
    session = load_recorded_session(sim_dir)
    print(
        f"replaying {sim_dir.name} — {session.duration_s:.1f}s of caller audio, "
        f"{len(session.gold)} gold utterances"
    )

    log = asyncio.run(replay(args, session))
    if args.dry_run:
        return
    summary = report(args, session, log)

    label = args.label or f"{sim_dir.parent.name}-{args.encoding}-{args.prompt}"
    # Artifacts live next to the runs they replay, not in this repo.
    out_dir = Path(args.out) if args.out else simulations_root().parent / "vaapi_replay" / label
    write_artifacts(out_dir, args, summary, log)


if __name__ == "__main__":
    main()
