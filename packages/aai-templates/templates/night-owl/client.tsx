/** @jsxImportSource react */

import { Button, client, useTheme, useToolCallStart, useToolResult } from "aai-ui";
import { useState } from "react";

type Rec = { category: string; mood: string; picks: string[] };

const MOODS = ["chill", "intense", "cozy", "spooky", "funny"] as const;
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
  const theme = useTheme();
  const [recs, setRecs] = useState<Rec[]>([]);
  const [activeMood, setActiveMood] = useState<string | null>(null);

  useToolCallStart("recommend", (tc) => {
    setActiveMood(tc.args.mood as string);
  });

  useToolResult<Rec>("recommend", (result) => {
    setRecs((prev) => [result, ...prev]);
  });

  const filtered = activeMood ? recs.filter((r) => r.mood === activeMood) : recs;

  return (
    <div
      className="flex flex-col h-full text-sm"
      style={{ background: theme.bg, color: theme.text }}
    >
      <div className="px-4 py-3 border-b shrink-0" style={{ borderColor: theme.border }}>
        <h2
          className="text-xs font-bold uppercase tracking-wide opacity-60"
          style={{ color: theme.text }}
        >
          Recommendations
        </h2>
      </div>

      <div
        className="flex flex-wrap gap-1.5 px-3 py-2.5 border-b shrink-0"
        style={{ borderColor: theme.border }}
      >
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

      <div className="flex-1 overflow-y-auto px-3 py-2">
        {filtered.length === 0 && (
          <p className="text-xs text-center py-8 opacity-40" style={{ color: theme.text }}>
            Ask me to recommend a movie, album, or book
          </p>
        )}
        {filtered.map((rec, i) => (
          <div
            key={`${rec.category}-${rec.mood}-${i}`}
            className="mb-3 p-2.5 rounded-lg border"
            style={{ background: theme.surface, borderColor: theme.border }}
          >
            <div className="flex items-center gap-2 mb-1.5">
              <span className="text-xs">{CAT_EMOJI[rec.category]}</span>
              <span className="text-xs font-semibold capitalize" style={{ color: theme.primary }}>
                {rec.category}s
              </span>
              <span className="text-xs capitalize opacity-50" style={{ color: theme.text }}>
                {rec.mood}
              </span>
            </div>
            {rec.picks.map((pick) => (
              <p
                key={pick}
                className="text-xs pl-5 py-0.5 opacity-80"
                style={{ color: theme.text }}
              >
                {pick}
              </p>
            ))}
          </div>
        ))}
      </div>

      {recs.length > 0 && (
        <div className="px-3 py-2 border-t shrink-0" style={{ borderColor: theme.border }}>
          <Button
            variant="ghost"
            className="w-full"
            onClick={() => {
              setRecs([]);
              setActiveMood(null);
            }}
          >
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

client({
  name: "Night Owl",
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
