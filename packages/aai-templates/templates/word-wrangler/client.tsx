import "@alexkroman1/aai-ui/styles.css";
import { mountClient, useAgentState } from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import { type GameView, gameProjection } from "./shared.ts";

/**
 * The describer's screen — their web game's `Card`, `Game` and timer components
 * over one projection instead of five hooks.
 *
 * The word is here because the describer needs to SEE it: the host says it once,
 * and a describer mid-sentence should not have to ask for it again. The
 * countdown is computed on the client from `startedAt`, exactly as their
 * `useGameTimer` counted down from the moment the intro finished: the server
 * owns whether the round is over, the screen owns the ticking digits.
 */

/** Once a second, so the ring moves. */
function useNow(): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return now;
}

const OUTCOME_LABEL: Record<GameView["rounds"][number]["outcome"], string> = {
  solved: "✓",
  skipped: "→",
  fouled: "✗",
};

function Clock({ view, now }: { view: GameView; now: number }) {
  if (view.startedAt === null) return null;
  const remaining = Math.max(0, view.startedAt + view.durationMs - now);
  const seconds = Math.ceil(remaining / 1000);
  const fraction = remaining / view.durationMs;
  const low = seconds <= 10 && view.phase === "playing";
  return (
    <div className="flex items-center gap-3">
      <div
        className="relative h-14 w-14 rounded-full"
        style={{
          background: `conic-gradient(${low ? "#f87171" : "#facc15"} ${fraction * 360}deg, rgba(255,255,255,0.08) 0deg)`,
        }}
        aria-label={`${seconds} seconds left`}
      >
        <div className="absolute inset-1.5 rounded-full bg-aai-bg flex items-center justify-center text-sm font-bold tabular-nums">
          {view.phase === "playing" ? seconds : "—"}
        </div>
      </div>
      <div className="text-xs uppercase tracking-wider opacity-60">
        {view.phase === "playing" ? "seconds left" : "clock stopped"}
      </div>
    </div>
  );
}

function Scoreboard() {
  const view = useAgentState(gameProjection);
  const now = useNow();
  return (
    <div className="flex flex-col gap-5 p-4 text-aai-text">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-xs uppercase tracking-wider opacity-60">Score</div>
          <div className="text-4xl font-black tabular-nums text-aai-primary">{view.score}</div>
        </div>
        <Clock view={view} now={now} />
      </div>

      <div className="rounded-xl bg-aai-surface p-4 text-center">
        <div className="text-xs uppercase tracking-wider opacity-60">
          {view.phase === "playing"
            ? "Describe this word"
            : view.phase === "over"
              ? "Round over"
              : "Ready when you are"}
        </div>
        <div className="mt-1 text-3xl font-bold text-balance">
          {view.phase === "playing"
            ? view.word
            : view.phase === "over"
              ? `${view.score} points`
              : "Say “ready”"}
        </div>
        {view.phase === "playing" && (
          <p className="mt-2 text-xs opacity-60">
            Don't say any part of it. “Skip” for a new word.
          </p>
        )}
        {view.phase === "over" && view.best > 0 && (
          <p className="mt-2 text-xs opacity-60">Best this session: {view.best}</p>
        )}
      </div>

      {view.lastRemark !== null && (
        <div className="rounded-lg border border-aai-border p-3 text-sm">
          <span className="opacity-60">Player: </span>
          {view.lastRemark}
        </div>
      )}

      {view.wrongGuesses.length > 0 && (
        <div className="text-xs opacity-60">Wrong so far: {view.wrongGuesses.join(", ")}</div>
      )}

      {view.rounds.length > 0 && (
        <ul className="flex flex-col gap-1 text-sm">
          {[...view.rounds].reverse().map((r, i) => (
            <li key={`${r.word}-${i}`} className="flex justify-between">
              <span className={r.outcome === "solved" ? "" : "opacity-50 line-through"}>
                {r.word}
              </span>
              <span className="opacity-60">
                {OUTCOME_LABEL[r.outcome]}
                {r.guesses > 0 ? ` after ${r.guesses}` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}

      <div className="flex gap-4 text-xs opacity-60">
        <span>Words left: {view.wordsLeft}</span>
        <span>Skips: {view.skips}</span>
        <span>Fouls: {view.fouls}</span>
      </div>
    </div>
  );
}

mountClient({
  name: "Word Wrangler",
  sidebar: Scoreboard,
  sidebarWidth: "20rem",
  theme: {
    bg: "#14102a",
    primary: "#facc15",
    text: "#f5f3ff",
    surface: "#221a44",
    border: "#37306b",
  },
});
