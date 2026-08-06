"""Tabulate and compare replay.py result files.

Prints the τ-voice panel per condition, with the event count backing each rate
and a rough 1-sigma band, because the selectivity signals are sparse (tens of
events per run) and a sweep over them will otherwise happily report noise as a
finding. Rates whose supporting count is below the leaderboard's own 10-event
threshold are shown parenthesised and must not be read as results.

Usage:
    uv run python report.py <a.json> <b.json> ...  [--policy tau2]
"""

from __future__ import annotations

import argparse
import json
import math
import statistics
from pathlib import Path

PANEL = ["L_R", "L_Y", "R_R", "R_Y", "S_BC", "S_VT", "S_ND"]
MIN_EVENTS = 10


def panel(events: list[dict]) -> dict[str, tuple[float | None, int]]:
    def rate(cat: str) -> tuple[float | None, int]:
        evs = [e for e in events if e["cat"] == cat]
        if not evs:
            return None, 0
        return 1.0 - sum(e["err"] for e in evs) / len(evs), len(evs)

    def mean_lat(kind: str) -> tuple[float | None, int]:
        v = [e["lat"] for e in events if e["type"] == kind and e["lat"] is not None]
        return (sum(v) / len(v) if v else None), len(v)

    return {
        "L_R": mean_lat("response"),
        "L_Y": mean_lat("yield"),
        "R_R": rate("response"),
        "R_Y": rate("yield"),
        "S_BC": rate("backchannel"),
        "S_VT": rate("vocal_tic"),
        "S_ND": rate("non_directed"),
    }


def sigma(p: float, n: int) -> float:
    """1-sigma on a proportion — the resolution limit of a run this size."""
    return math.sqrt(max(p * (1 - p), 1e-9) / n) * 100 if n else float("nan")


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("files", nargs="+")
    ap.add_argument("--policy", default="tau2", help="client truncation policy to score")
    args = ap.parse_args()

    # Group replicates written as "<condition>__r<N>". Events are POOLED across
    # replicates (each is an independent draw of the conversation, so pooling
    # genuinely adds information rather than just averaging), and the spread
    # ACROSS replicates is reported separately — that spread, not the binomial
    # count, is the real resolution limit here.
    groups: dict[str, list[list[dict]]] = {}
    errs_by: dict[str, int] = {}
    for f in args.files:
        d = json.loads(Path(f).read_text())
        pol = d["policies"].get(args.policy)
        if pol is None:
            continue
        name = Path(d["label"]).name.split("__r")[0]
        groups.setdefault(name, []).append(pol["events"])
        errs_by[name] = errs_by.get(name, 0) + sum(
            1 for p in d["per_sim"] if p["error"]
        )

    rows = []
    for name, reps in groups.items():
        pooled = [e for r in reps for e in r]
        rows.append((name, panel(pooled), errs_by[name], reps))

    hdr = f"{'condition':<18}{'reps':>5}" + "".join(f"{m:>17}" for m in PANEL)
    print(hdr)
    print("-" * len(hdr))
    for name, m, errs, reps in rows:
        cells = ""
        for k in PANEL:
            v, n = m[k]
            if v is None:
                cells += f"{'—':>17}"
            elif k.startswith("L_"):
                cells += f"{v:>11.2f}s(n{n:>3})"
            else:
                txt = f"{v * 100:.1f}%"
                if n < MIN_EVENTS:
                    txt = f"({txt})"
                cells += f"{txt:>11}(n{n:>3})"
        flag = f"  !{errs} errored" if errs else ""
        print(f"{name:<18}{len(reps):>5}{cells}{flag}")

    # Across-replicate spread: the honest resolution limit. Binomial sigma on
    # the pooled count ignores that each replicate is a different conversation.
    multi = [(n, m, reps) for n, m, _, reps in rows if len(reps) > 1]
    if multi:
        print("\nacross-replicate spread (sd of the per-run rate) — the real noise floor:")
        for name, _m, reps in multi:
            parts = []
            for k in PANEL:
                vals = [panel(r)[k][0] for r in reps]
                vals = [x for x in vals if x is not None]
                if len(vals) < 2:
                    continue
                scale = 1.0 if k.startswith("L_") else 100.0
                sd = statistics.stdev([x * scale for x in vals])
                sem = sd / math.sqrt(len(vals))
                unit = "s" if k.startswith("L_") else ""
                parts.append(f"{k} sd{sd:.1f}{unit}/sem{sem:.1f}{unit}")
            print(f"  {name:<16} {'  '.join(parts)}")
        print("  a difference is only real if it clears ~2x the pooled sem of both arms")
    else:
        print(f"\n1-sigma (binomial only; rates below n={MIN_EVENTS} parenthesised):")
        base = rows[0][1] if rows else {}
        for k in PANEL:
            if k.startswith("L_") or k not in base:
                continue
            v, n = base[k]
            if v is None or not n:
                continue
            print(f"  {k}: n={n:<4} ±{sigma(v, n):.1f} pts (understates: see README)")


if __name__ == "__main__":
    main()
