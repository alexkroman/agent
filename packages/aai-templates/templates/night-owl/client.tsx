import "@alexkroman1/aai-ui/styles.css";
/**
 * Two kinds of thing arrive from the agent, and this page keeps them apart.
 *
 * The recommendation LOG is state: the agent owns it in a `sessionSlot`,
 * `syncState` projects it, and `useAgentState(nightProjection)` reads it. The
 * page stores no copy, so a reload resumes with every pick still there. That is
 * the pattern to reach for by default — see `pizza-ordering` for the same shape
 * over a shopping cart.
 *
 * The "recommending…" flash and the wind-down nudge are MOMENTS. Neither is
 * worth storing and neither should replay: a spinner for a call that finished
 * before this component mounted would be a lie, and a nudge re-shown on every
 * reconnect is nagging. `useToolCallStart` and `useEvent` are for exactly this —
 * they fire once, carry no history, and drive throwaway `useState`.
 */
import {
  Button,
  mountClient,
  useAgentState,
  useEvent,
  useToolCallStart,
} from "@alexkroman1/aai-ui";
import { useEffect, useState } from "react";
import { MOODS, nightProjection } from "./shared.ts";

const MOOD_EMOJI: Record<string, string> = {
  chill: "\u{1F60C}",
  intense: "\u{1F525}",
  cozy: "\u{1F9E3}",
  spooky: "\u{1F47B}",
  funny: "\u{1F602}",
};
const CAT_EMOJI: Record<string, string> = {
  movie: "\u{1F3AC}",
  music: "\u{1F3B5}",
  book: "\u{1F4DA}",
};

function RecSidebar() {
  // State: the agent's own log. No `useState` mirror, no event diffing.
  const { recs } = useAgentState(nightProjection);
  // Page-local view state — which mood chip is pressed. Nothing to sync.
  const [activeMood, setActiveMood] = useState<string | null>(null);
  // Moments. Both are cleared by this page, never re-delivered by the session.
  const [pendingMood, setPendingMood] = useState<string | null>(null);
  const [nudge, setNudge] = useState<string | null>(null);

  useToolCallStart("recommend", (tc) => setPendingMood(String(tc.args.mood)));
  useEvent<string>("wind_down", (text) => setNudge(text));

  // The flash ends when the picks land, which is the projection changing —
  // the same signal the list itself renders from.
  useEffect(() => setPendingMood(null), [recs.length]);

  const filtered = activeMood ? recs.filter((r) => r.mood === activeMood) : recs;

  return (
    <div className="flex flex-col h-full text-sm bg-aai-bg text-aai-text">
      <div className="px-4 py-3 border-b border-aai-border shrink-0">
        <h2 className="text-xs font-bold uppercase tracking-wide opacity-60">Recommendations</h2>
      </div>

      <div className="flex flex-wrap gap-1.5 px-3 py-2.5 border-b border-aai-border shrink-0">
        {MOODS.map((mood) => (
          <Button
            key={mood}
            variant={activeMood === mood ? "default" : "ghost"}
            onClick={() => setActiveMood(activeMood === mood ? null : mood)}
          >
            {MOOD_EMOJI[mood]} {mood}
          </Button>
        ))}
      </div>

      {nudge && (
        <div className="flex items-center gap-2 px-3 py-2 border-b border-aai-border shrink-0">
          <p className="flex-1 text-xs text-aai-primary">{nudge}</p>
          <Button variant="ghost" onClick={() => setNudge(null)}>
            Dismiss
          </Button>
        </div>
      )}

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {pendingMood && (
          <p className="text-xs py-2 opacity-60 animate-pulse">
            Finding something {pendingMood}&hellip;
          </p>
        )}
        {filtered.length === 0 && !pendingMood && (
          <p className="text-xs text-center py-8 opacity-40">
            Ask me to recommend a movie, album, or book
          </p>
        )}
        {filtered.map((rec, i) => (
          <div
            key={`${rec.category}-${rec.mood}-${i}`}
            className="mb-3 p-2.5 rounded-lg border border-aai-border bg-aai-surface"
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs">{CAT_EMOJI[rec.category]}</span>
              <span className="text-xs font-semibold capitalize text-aai-primary">
                {rec.category}s
              </span>
              <span className="text-xs capitalize opacity-50">{rec.mood}</span>
            </div>
            {rec.picks.map((pick) => (
              <p key={pick} className="text-xs pl-5 py-0.5 opacity-80">
                {pick}
              </p>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

mountClient({
  name: "Night Owl",
  icon: "\u{1F989}",
  subtitle: "A cozy companion for the small hours",
  buttonText: "Settle in",
  sidebar: RecSidebar,
  theme: {
    bg: "#0c0e1a",
    primary: "#a78bfa",
    text: "#e2e0f0",
    surface: "#131627",
    border: "#1e2340",
  },
  tools: {
    recommend: { icon: "\u{1F989}", label: "Recommending" },
  },
});
