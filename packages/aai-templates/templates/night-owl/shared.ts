import { sessionSlot } from "@alexkroman1/aai";

export const CATEGORIES = ["movie", "music", "book"] as const;
export const MOODS = ["chill", "intense", "cozy", "spooky", "funny"] as const;

export type Category = (typeof CATEGORIES)[number];
export type Mood = (typeof MOODS)[number];

/** One answer from `recommend`, as the sidebar renders it. */
export type Rec = { category: Category; mood: Mood; picks: string[] };

/**
 * The night's recommendation log — the agent's own state, not the page's.
 *
 * It used to live in a `useState` in `client.tsx`, rebuilt from a
 * `ctx.send("recommendations", …)` event per call. That made the list a
 * DERIVED thing: a page that mounted late, or reloaded mid-session, started
 * empty while the session it reconnected to still remembered every pick. A
 * slot is the same list stored once, on the side that already survives a
 * reload.
 */
export const nightSlot = sessionSlot("night", () => ({ recs: [] as Rec[] }));

/**
 * What the browser sees. The projection BOTH ends use: `syncState` on the
 * agent, `useAgentState` in the client — so the page's empty state is derived
 * from the same function the server pushes, rather than guessed at.
 */
export const nightProjection = nightSlot.projection((night) => ({ recs: night.recs }));
