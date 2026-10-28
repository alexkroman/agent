import { sessionSlot } from "@alexkroman1/aai";

/** Digits in a pairing code: short enough to read aloud, with the window and cap below. */
export const PAIR_CODE_DIGITS = 6;

/** How long a phone waits for the door to hear its code. */
export const PAIR_WINDOW_MS = 10 * 60 * 1000;

/** Wrong codes one conversation at the door may try before link_phone refuses. */
export const MAX_LINK_ATTEMPTS = 5;

/** A client id, as the inbox and the session take it. */
export const CLIENT_ID = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * How many codes this conversation at the door has tried. A slot, so the cap holds across
 * the conversation's turns: guessing a six-digit code five at a time, in a window of ten
 * minutes, by voice, is not a way in.
 */
export const linkSlot = sessionSlot("link", { attempts: 0 });

/** What POST /api/pair answers: the code to show, and the run to watch. */
export type PairStarted = { runId: string; code: string; expiresAt: number };

/** What GET /api/pair/:runId answers. */
export type PairStatus =
  | { status: "waiting" }
  | { status: "linked"; doorId: string }
  | { status: "expired" };

/** What the door tells the phone, as the notice's `data`. */
export type DoorNotice =
  | { kind: "visitor"; name: string; message: string }
  | { kind: "ring" }
  | { kind: "digest"; summary: string };
