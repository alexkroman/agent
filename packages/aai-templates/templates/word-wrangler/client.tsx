import "@alexkroman1/aai-ui/styles.css";
import type { AgentState, UseUserTranscriptResult } from "@alexkroman1/aai-ui";
import {
  AGENT_STATE_LABELS,
  mountClient,
  useAgentState,
  useSessionStatus,
  useUserTranscript,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import { containsWord } from "./guess.ts";
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
 *
 * Two things come off the SESSION rather than the projection, because they are
 * facts about the call and not about the game: what the describer is being
 * heard to say, and what the host is doing with the turn. Their web game had
 * neither, and both are the difference between a fair round and a mystifying
 * one — a foul is ruled on the transcript, so the transcript is on screen.
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

/**
 * The game's own word for three of the seven agent states — the three a
 * describer on a two-minute clock actually needs, said in the game's terms
 * rather than the console's. Everything else falls through to
 * `AGENT_STATE_LABELS`, so a state added upstream still reads as something.
 */
const STATE_WORD: Partial<Record<AgentState, string>> = {
  listening: "your turn",
  thinking: "player is guessing",
  speaking: "host is talking",
};

/**
 * The describer's own words as the host hears them, red the moment they give
 * the word away.
 *
 * The foul is ruled on this text (`relay_description` reads the committed
 * transcript, not the host's relay), so showing it is showing the evidence —
 * and `containsWord` is the very function the referee uses, imported rather
 * than approximated, so the warning cannot disagree with the ruling.
 */
function Heard({ transcript, word }: { transcript: UseUserTranscriptResult; word: string | null }) {
  const foul = word !== null && containsWord(transcript.text, word);
  return (
    <div className={`text-sm italic ${foul ? "text-red-400" : "opacity-60"}`}>
      {foul ? `Careful - that's the word. ` : ""}
      {transcript.text}
    </div>
  );
}

/**
 * One row, narrowly subscribed: the live transcript while the describer holds
 * the turn, and what the host is doing when they do not.
 *
 * `speaking` rather than a falsy check on the text — `""` is "speech detected,
 * no words back yet", which is the moment the row is for. Both hooks live here
 * and not in {@link Scoreboard} so the STT-partial re-render rate stays off the
 * clock, the word card and the round log.
 */
function Listening({ word }: { word: string | null }) {
  const transcript = useUserTranscript();
  const status = useSessionStatus();
  if (transcript.speaking) return <Heard transcript={transcript} word={word} />;
  return (
    <div className="text-xs uppercase tracking-wider opacity-60">
      {STATE_WORD[status] ?? AGENT_STATE_LABELS[status]}
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

      <Listening word={view.word} />

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
