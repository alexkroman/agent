import { sessionSlot } from "@alexkroman1/aai";

export const CATEGORIES = ["movie", "music", "book"] as const;
export const MOODS = ["chill", "intense", "cozy", "spooky", "funny"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Mood = (typeof MOODS)[number];

/** One answer from `recommend`, as the sidebar renders it. */
export type Rec = { category: Category; mood: Mood; picks: string[] };

/**
 * The most picks one night keeps.
 *
 * A bound is not optional here: the log rides EVERY `syncState` frame, so an
 * unbounded list is a frame that grows for as long as the session lasts — and
 * a night owl asking for one more album at a time is exactly the session that
 * lasts. Twelve is a scroll of the sidebar; older than that is history nobody
 * is going to ask about.
 */
export const MAX_RECS = 12;

/**
 * The night's recommendation log — the agent's own state, not the page's.
 *
 * It used to live in a `useState` in `client.tsx`, rebuilt from a
 * `ctx.send("recommendations", …)` event per call. That made the list a
 * DERIVED thing: a page that mounted late, or reloaded mid-session, started
 * empty while the session it reconnected to still remembered every pick. A
 * slot is the same list stored once, on the side that already survives a
 * reload.
 *
 * Stored OLDEST FIRST, which is two decisions rather than one:
 *
 * - **`caps` keeps the TAIL.** The bound is declared on the slot, so it holds
 *   for whatever path wrote — the alternative is a `pushCapped` wrapper each
 *   writer has to remember, and the writer that forgets is the one that ships.
 *   A trim drops from the front, so a log that grew by `unshift` would lose
 *   the pick it just took.
 * - **A position word means the order the CONVERSATION happened in.** "The
 *   last one you gave me" is the newest, and `revisit` resolves it with
 *   `at(-1)`; the sidebar's newest-first painting is a display choice, and it
 *   is the projection below that makes it.
 */
export const nightSlot = sessionSlot("night", () => ({ recs: [] as Rec[] }), {
  caps: { recs: MAX_RECS },
});

/**
 * What the browser sees. The projection BOTH ends use: `syncState` on the
 * agent, `useAgentState` in the client — so the page's empty state is derived
 * from the same function the server pushes, rather than guessed at.
 *
 * It REVERSES, over a copy: the slot's own order is chronological (see above)
 * and newest-first is what the sidebar reads best. Doing it here rather than
 * in `client.tsx` keeps the two ends from disagreeing about which end is new.
 */
export const nightProjection = nightSlot.projection((night) => ({
  recs: [...night.recs].reverse(),
}));
