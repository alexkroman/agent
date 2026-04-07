import "@alexkroman1/aai-ui/styles.css";
import {
  Button,
  ChatView,
  defineClient,
  SidebarLayout,
  StartScreen,
  useToolCallStart,
  useToolResult,
} from "@alexkroman1/aai-ui";
import { useState } from "preact/hooks";

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

const BOUNCE_CSS = `
@keyframes owl-bounce {
  0%, 80%, 100% { transform: scale(0); }
  40% { transform: scale(1); }
}
`;

function BouncingDots() {
  return (
    <>
      <style>{BOUNCE_CSS}</style>
      <div class="flex gap-1.5">
        {[0, 1, 2].map((i) => (
          <div
            key={i}
            class="w-2 h-2 rounded-full bg-aai-primary"
            style={{ animation: `owl-bounce 1.4s ${i * 0.16}s infinite ease-in-out both` }}
          />
        ))}
      </div>
    </>
  );
}

function RecSidebar({
  recs,
  loading,
  activeMood,
  onMoodToggle,
  onClear,
}: {
  recs: Rec[];
  loading: boolean;
  activeMood: string | null;
  onMoodToggle: (mood: string) => void;
  onClear: () => void;
}) {
  const filtered = activeMood ? recs.filter((r) => r.mood === activeMood) : recs;

  return (
    <div class="flex flex-col h-full bg-aai-bg text-aai-text font-aai text-sm">
      <div class="px-4 py-3 border-b border-aai-border shrink-0">
        <h2 class="text-xs font-bold text-aai-text uppercase tracking-wide opacity-60">
          Recommendations
        </h2>
      </div>

      <div class="flex flex-wrap gap-1.5 px-3 py-2.5 border-b border-aai-border shrink-0">
        {MOODS.map((mood) => (
          <Button
            key={mood}
            variant={activeMood === mood ? "default" : "ghost"}
            onClick={() => onMoodToggle(mood)}
          >
            {MOOD_EMOJI[mood]} {mood}
          </Button>
        ))}
      </div>

      <div class="flex-1 overflow-y-auto px-3 py-2">
        {loading && (
          <div class="flex justify-center py-4">
            <BouncingDots />
          </div>
        )}
        {filtered.length === 0 && !loading && (
          <p class="text-aai-text opacity-40 text-xs text-center py-8">
            Ask me to recommend a movie, album, or book
          </p>
        )}
        {filtered.map((rec, i) => (
          <div
            key={`${rec.category}-${rec.mood}-${i}`}
            class="mb-3 p-2.5 rounded-lg bg-aai-surface border border-aai-border"
          >
            <div class="flex items-center gap-2 mb-1.5">
              <span class="text-xs">{CAT_EMOJI[rec.category]}</span>
              <span class="text-xs font-semibold text-aai-primary capitalize">{rec.category}s</span>
              <span class="text-xs text-aai-text opacity-50 capitalize">{rec.mood}</span>
            </div>
            {rec.picks.map((pick) => (
              <p key={pick} class="text-xs text-aai-text pl-5 py-0.5 opacity-80">
                {pick}
              </p>
            ))}
          </div>
        ))}
      </div>

      {recs.length > 0 && (
        <div class="px-3 py-2 border-t border-aai-border shrink-0">
          <Button variant="ghost" className="w-full" onClick={onClear}>
            Clear
          </Button>
        </div>
      )}
    </div>
  );
}

function NightOwl() {
  const [recs, setRecs] = useState<Rec[]>([]);
  const [loading, setLoading] = useState(false);
  const [activeMood, setActiveMood] = useState<string | null>(null);

  useToolCallStart((name: string, args: Record<string, unknown>) => {
    if (name === "recommend") {
      setLoading(true);
      setActiveMood(args.mood as string);
    }
  });

  useToolResult<Rec>("recommend", (result) => {
    setLoading(false);
    setRecs((prev) => [result, ...prev]);
  });

  const sidebar = (
    <RecSidebar
      recs={recs}
      loading={loading}
      activeMood={activeMood}
      onMoodToggle={(mood) => setActiveMood(activeMood === mood ? null : mood)}
      onClear={() => {
        setRecs([]);
        setActiveMood(null);
      }}
    />
  );

  return (
    <StartScreen
      icon={<span class="text-5xl">{"\u{1F989}"}</span>}
      title="Night Owl"
      subtitle="your evening companion"
      buttonText="Start Conversation"
    >
      <SidebarLayout sidebar={sidebar} side="right" width="18rem">
        <ChatView icon={<span class="text-lg">{"\u{1F989}"}</span>} />
      </SidebarLayout>
    </StartScreen>
  );
}

defineClient(NightOwl, {
  title: "Night Owl",
  theme: {
    bg: "#0c0e1a",
    primary: "#a78bfa",
    text: "#e2e0f0",
    surface: "#131627",
    border: "#1e2340",
  },
});
