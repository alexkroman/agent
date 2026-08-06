"""Score a speculative turn-start policy from a recorded replay, offline.

The question this answers: if the pipeline began its LLM turn as soon as the
STT's end-of-turn confidence crossed some threshold — rather than waiting for
the committed final — how much latency would that buy, and how often would the
speculation have been WASTED because the transcript changed before the turn
actually ended?

Both halves matter and they trade against each other. A low threshold fires
early (more lead) but on less settled text (more misses); a high one is the
reverse. Nothing has to be built to find the knee: `user_transcript_partial`
carries `eotConfidence`, so every replay already contains the whole curve.

  hit   = normalised interim text at the crossing == normalised final text
  lead  = seconds from the crossing to the final committing

A hit saves min(lead, LLM time-to-first-token) — the LLM is the work being
hidden, and you cannot save more of it than you have lead. A miss costs no
latency (the turn re-runs exactly as it does today) but does cost the tokens.

Usage:
    uv run python eot_speculation.py <replay.json> [--llm-ttft 3.06]
"""

from __future__ import annotations

import argparse
import json
import re
import statistics
from pathlib import Path

THRESHOLDS = [0.3, 0.5, 0.7, 0.9]


def norm(text: str) -> str:
    return " ".join(re.sub(r"[^a-z0-9 ]", " ", text.lower()).split())


def turns(eot: list) -> list[tuple[list, tuple]]:
    """Group the interim stream into (interims, final) per committed turn."""
    out, pending = [], []
    for t, kind, conf, text in eot:
        if kind == "user_transcript":
            if pending:
                out.append((pending, (t, text)))
            pending = []
        else:
            pending.append((t, conf, text))
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument(
        "--llm-ttft",
        type=float,
        default=3.06,
        help="mean seconds of LLM work a hit can hide (measured: 3.06)",
    )
    args = ap.parse_args()

    grouped = []
    have_conf = 0
    total_interims = 0
    for f in args.files:
        d = json.loads(Path(f).read_text())
        for p in d["per_sim"]:
            eot = p.get("eot_raw") or []
            total_interims += sum(1 for e in eot if e[1] == "user_transcript_partial")
            have_conf += sum(
                1 for e in eot if e[1] == "user_transcript_partial" and e[2] is not None
            )
            grouped.extend(turns(eot))

    print(f"committed turns: {len(grouped)}   interims: {total_interims}   "
          f"with confidence: {have_conf} ({have_conf / max(total_interims, 1):.0%})")
    if not have_conf:
        print("\nNo confidence reported — the provider omitted it, or the run predates "
              "the field. Nothing to score.")
        return

    hdr = f"{'threshold':>10}{'fired':>8}{'hit':>8}{'lead p50':>10}{'lead mean':>11}{'saving/turn':>13}"
    print(f"\n{hdr}\n{'-' * len(hdr)}")
    for th in THRESHOLDS:
        fired = hits = 0
        leads: list[float] = []
        savings: list[float] = []
        for interims, (t_final, final_text) in grouped:
            cross = next((i for i in interims if (i[1] or 0) >= th), None)
            if cross is None:
                # Never crossed: no speculation, no saving, and today's latency.
                savings.append(0.0)
                continue
            fired += 1
            lead = max(0.0, t_final - cross[0])
            leads.append(lead)
            if norm(cross[2]) == norm(final_text):
                hits += 1
                savings.append(min(lead, args.llm_ttft))
            else:
                savings.append(0.0)
        if not fired:
            print(f"{th:>10}{0:>8}{'—':>8}{'—':>10}{'—':>11}{'—':>13}")
            continue
        print(
            f"{th:>10}{fired:>8}{hits / fired:>7.0%}"
            f"{statistics.median(leads):>9.2f}s{statistics.mean(leads):>10.2f}s"
            f"{statistics.mean(savings):>12.2f}s"
        )

    print(
        "\nsaving/turn is the EXPECTED value over all committed turns (misses and "
        "never-fired count as zero),\ncapped at --llm-ttft because that is the work "
        "a head start can hide."
    )


if __name__ == "__main__":
    main()
