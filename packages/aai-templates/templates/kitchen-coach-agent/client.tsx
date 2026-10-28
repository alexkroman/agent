import "@alexkroman1/aai-ui/styles.css";
import {
  ChatView,
  createStoredValue,
  mountClient,
  NumberField,
  SelectField,
  SidebarLayout,
  StartScreen,
  TextAreaField,
  TextField,
  useClientId,
  useClientTool,
  useRoute,
  useSessionId,
  useStoredValue,
} from "@alexkroman1/aai-ui";
import { useEffect, useRef, useState } from "react";
import {
  DIETS,
  dueTimers,
  type History,
  kitchenFrom,
  MAX_SERVINGS,
  startTimer,
  type Timer,
  type TimerRequest,
  timeLeft,
} from "./shared.ts";

// The kitchen is the page's: a form remembered in this browser, timers that tick and chime
// here, and the two client tools that let the agent read the one and start the other.
// Everything else is the SDK's own chrome: StartScreen until the cook presses Start, then
// a SidebarLayout with the kitchen beside ChatView (the conversation, the live state and
// the Stop / New conversation / End buttons).

// Each field is one string in localStorage, created once and shared: the form and the
// get_kitchen handler read the same value, and a second tab sees an edit.
const cook = createStoredValue("kitchen-coach.cook");
const servings = createStoredValue("kitchen-coach.servings", { initial: "2" });
const diet = createStoredValue("kitchen-coach.diet", { initial: "anything" });
const pantry = createStoredValue("kitchen-coach.pantry");

function App() {
  return (
    <StartScreen
      icon={<span className="text-5xl">🍳</span>}
      subtitle="Hands busy? Talk me through dinner. Fill in your kitchen on the left once we start."
      buttonText="Start cooking"
    >
      <SidebarLayout sidebar={<Kitchen />} sidebarWidth="20rem">
        <ChatView icon="🍳" />
      </SidebarLayout>
    </StartScreen>
  );
}

function Kitchen() {
  const [cookName, setCook] = useStoredValue(cook);
  const [people, setServings] = useStoredValue(servings);
  const [eats, setDiet] = useStoredValue(diet);
  const [stock, setPantry] = useStoredValue(pantry);

  // get_kitchen (tools/get_kitchen.ts): the agent asks, this answers with the form as it
  // is NOW. useClientTool keeps the latest handler, so the closure is never stale.
  useClientTool("get_kitchen", () =>
    kitchenFrom({ cook: cookName, servings: people, diet: eats, pantry: stock }),
  );

  return (
    <aside className="aai-scroll flex h-full flex-col gap-6 overflow-y-auto p-4">
      <section className="flex flex-col gap-3" aria-label="Your kitchen">
        <h2 className="text-sm font-semibold">Your kitchen</h2>
        <TextField
          name="cook"
          label="Who's cooking"
          autoComplete="given-name"
          value={cookName}
          onChange={(e) => setCook(e.target.value)}
        />
        <NumberField
          name="servings"
          label="Cooking for"
          min={1}
          max={MAX_SERVINGS}
          value={people}
          onChange={(e) => setServings(e.target.value)}
        />
        <SelectField
          name="diet"
          label="Diet"
          options={DIETS}
          value={eats}
          onChange={(e) => setDiet(e.target.value)}
        />
        <TextAreaField
          name="pantry"
          label="In the pantry"
          hint="One item per line, or separated by commas."
          rows={6}
          placeholder="eggs, rice, spinach"
          value={stock}
          onChange={(e) => setPantry(e.target.value)}
        />
      </section>
      <Timers />
      <Earlier />
    </aside>
  );
}

/** A short two-tone chime. A browser that refuses audio just shows the timer as done. */
function chime(): void {
  try {
    const audio = new AudioContext();
    for (const [i, hz] of [880, 660].entries()) {
      const tone = audio.createOscillator();
      const gain = audio.createGain();
      const at = audio.currentTime + i * 0.35;
      tone.frequency.value = hz;
      gain.gain.setValueAtTime(0.2, at);
      gain.gain.exponentialRampToValueAtTime(0.001, at + 0.6);
      tone.connect(gain).connect(audio.destination);
      tone.start(at);
      tone.stop(at + 0.6);
    }
    setTimeout(() => void audio.close(), 1500);
  } catch {
    // No audio here: the row still says the timer is done.
  }
}

function Timers() {
  const [timers, setTimers] = useState<Timer[]>([]);
  const [now, setNow] = useState(() => Date.now());
  // The list a handler reads, synchronously: the model may start two timers in one step,
  // and the second call must see the first, which a render has not caught up with yet.
  const current = useRef<Timer[]>([]);
  const update = (next: Timer[]) => {
    current.current = next;
    setTimers(next);
  };

  // start_timer (tools/start_timer.ts): what startTimer returns is what the model reads.
  useClientTool<TimerRequest>("start_timer", (request) => {
    const next = startTimer(current.current, request, Date.now(), crypto.randomUUID());
    update(next.timers);
    return next.result;
  });

  // One tick a second while anything is running; each timer rings once.
  const running = timers.some((t) => !t.rung);
  useEffect(() => {
    if (!running) return;
    const tick = setInterval(() => {
      const at = Date.now();
      setNow(at);
      const due = new Set(dueTimers(current.current, at).map((t) => t.id));
      if (due.size === 0) return;
      chime();
      update(current.current.map((t) => (due.has(t.id) ? { ...t, rung: true } : t)));
    }, 1000);
    return () => clearInterval(tick);
  }, [running]);

  if (timers.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Timers">
      <h2 className="text-sm font-semibold">Timers</h2>
      <ul className="flex flex-col gap-2">
        {timers.map((t) => (
          <li
            key={t.id}
            className={`flex items-center justify-between rounded-lg border border-aai-border px-3 py-2 text-sm ${
              t.rung ? "bg-aai-primary text-aai-bg" : "bg-aai-surface"
            }`}
          >
            <span>{t.label}</span>
            <span className="font-mono tabular-nums">{t.rung ? "done" : timeLeft(t, now)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * This browser's past conversations (GET /api/history, history.ts). useRoute sends the
 * page's ?client= id; the list is re-read when a new session starts, so the one that
 * just ended joins it. The live one is marked by its session id.
 */
function Earlier() {
  const clientId = useClientId();
  const sessionId = useSessionId();
  const { data, error, reload } = useRoute<History>(clientId ? "/history" : null);
  // Re-read on each new session, so the one that just ended joins the list.
  useEffect(() => reload(), [reload, sessionId]);

  const conversations = data?.conversations ?? [];
  if (error) return <p className="text-xs text-red-500">{error}</p>;
  if (conversations.length === 0) return null;
  return (
    <section className="flex flex-col gap-2" aria-label="Earlier">
      <h2 className="text-sm font-semibold">Earlier</h2>
      <ul className="flex flex-col gap-2 text-sm">
        {conversations.map((c) => (
          <li key={c.sessionId} className="flex flex-col">
            <span className="truncate">
              {c.sessionId === sessionId ? "Now: " : ""}
              {c.firstLine}
            </span>
            <span className="text-xs opacity-60">
              {new Date(c.startedAt).toLocaleString([], {
                weekday: "short",
                hour: "numeric",
                minute: "2-digit",
              })}{" "}
              · {c.lines} lines
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

mountClient({
  component: App,
  // A per-browser ?client= id: what GET /history reads this browser's past sessions by.
  client: "auto",
  theme: { primary: "#d9622b", mode: "light" },
});
