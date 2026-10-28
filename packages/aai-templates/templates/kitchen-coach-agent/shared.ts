// What the page and the agent agree on: the kitchen the page reports, the timers it runs,
// and the rows of the "Earlier" list. Plain functions over plain values, so the page's
// tool handlers are tested without a browser (agent.test.ts).

/** The diets the page offers. "anything" is no restriction. */
export const DIETS = ["anything", "vegetarian", "vegan", "pescatarian", "gluten-free"] as const;
export type Diet = (typeof DIETS)[number];

/** Most people one recipe is scaled for: past this it is catering. */
export const MAX_SERVINGS = 12;

/** Most pantry items reported to the model: a long list is noise in every prompt. */
export const MAX_PANTRY_ITEMS = 40;

/** What get_kitchen answers: the kitchen as the page's form has it. */
export type Kitchen = {
  /** Who is cooking, or "" when they did not say. */
  cook: string;
  servings: number;
  diet: Diet;
  pantry: string[];
};

/** The form's raw strings, as the page stores them. */
export type KitchenForm = { cook: string; servings: string; diet: string; pantry: string };

/**
 * The form as get_kitchen reports it: servings a whole number in range (a blank or a
 * typo is 2), an unknown diet "anything", and the pantry one item per line or comma,
 * trimmed, without repeats, capped.
 */
export function kitchenFrom(form: KitchenForm): Kitchen {
  const servings = Math.round(Number(form.servings));
  const diet = DIETS.find((d) => d === form.diet) ?? "anything";
  const seen = new Set<string>();
  const pantry: string[] = [];
  for (const raw of form.pantry.split(/[\n,]/)) {
    const item = raw.trim();
    if (item === "" || seen.has(item.toLowerCase())) continue;
    seen.add(item.toLowerCase());
    pantry.push(item);
    if (pantry.length === MAX_PANTRY_ITEMS) break;
  }
  return {
    cook: form.cook.trim(),
    servings: Number.isFinite(servings) && servings >= 1 ? Math.min(servings, MAX_SERVINGS) : 2,
    diet,
    pantry,
  };
}

/** Whole quarters, as a cook measures them. */
const QUARTERS = ["", "a quarter", "a half", "three quarters"] as const;

/**
 * An amount as it is SAID: "one and a half", "three quarters", "two". Rounded to the
 * nearest quarter, because nobody measures 1.37 cups, and anything under an eighth is
 * "a pinch".
 */
export function spokenAmount(amount: number): string {
  const quarters = Math.round(amount * 4);
  if (quarters === 0) return "a pinch";
  const whole = Math.floor(quarters / 4);
  const part = QUARTERS[quarters % 4] ?? "";
  if (whole === 0) return part;
  return part === "" ? String(whole) : `${whole} and ${part}`;
}

/** Longest timer: three hours covers a braise. */
export const MAX_TIMER_MINUTES = 180;

/** Most timers running at once. */
export const MAX_TIMERS = 6;

/** One kitchen timer, as the page runs it. */
export type Timer = { id: string; label: string; endsAt: number; rung: boolean };

/** What start_timer is called with. */
export type TimerRequest = { label: string; minutes: number };

/**
 * Add a timer, or say why not. The page's start_timer handler is this plus a setState;
 * what it returns is what the model reads.
 */
export function startTimer(
  timers: readonly Timer[],
  request: TimerRequest,
  now: number,
  id: string,
): {
  timers: Timer[];
  result: { started: true; label: string; minutes: number } | { error: string };
} {
  const running = timers.filter((t) => !t.rung);
  if (running.length >= MAX_TIMERS) {
    return {
      timers: [...timers],
      result: { error: `${MAX_TIMERS} timers are already running. Let one finish first.` },
    };
  }
  const label = request.label.trim() || "timer";
  const timer: Timer = { id, label, endsAt: now + request.minutes * 60_000, rung: false };
  // Rung timers are dropped as a new one starts, so the list stays the ones that matter.
  return {
    timers: [...running, timer],
    result: { started: true, label, minutes: request.minutes },
  };
}

/** The timers that have just come due: ring each once. */
export function dueTimers(timers: readonly Timer[], now: number): Timer[] {
  return timers.filter((t) => !t.rung && t.endsAt <= now);
}

/** "4:05" — what is left on a timer, for its row. */
export function timeLeft(timer: Timer, now: number): string {
  const seconds = Math.max(0, Math.ceil((timer.endsAt - now) / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** One past conversation, as the sidebar's "Earlier" list renders it. */
export type PastConversation = {
  sessionId: string;
  startedAt: number;
  /** What the cook said first: enough to recognize it by. */
  firstLine: string;
  lines: number;
};

/** What GET /history answers. */
export type History = { conversations: PastConversation[] };
