// Copyright 2026 the AAI authors. MIT license.
/**
 * Pressing phone keys from a tool — how an agent gets through "press 1 for
 * appointments".
 *
 * An outbound call rarely reaches a person first: it reaches a phone menu, and
 * a menu listens for DTMF tones, not words. `sendDtmf(ctx, "1")` plays the
 * standard tone pair for each key into the session's agent audio, so it reaches
 * the far end the way the agent's voice does — over a carrier media stream on a
 * `WS /phone` call (in-band, which every menu on a G.711 line decodes), or out
 * of the speaker on a browser session.
 *
 * ## A function of the context, not a field on it
 *
 * The shape of `endSession(ctx)`, for the same reason: it is per-SESSION and
 * reachable from `ctx.sessionId`, so it is not a `ToolContext` field
 * (`guard-invariants` rule 24). The runtime registers a sender for each
 * attached session and a tool in the agent bundle calls it — two copies of this
 * module, so the registry hangs off `globalThis` (an {@link OwnedMap}, since a
 * resumed session claims the SAME id while the old connection's teardown
 * settles).
 *
 * EXPERIMENTAL (`@alexkroman1/aai/experimental`): in-band tones are what every
 * carrier passes and every menu on a G.711 line decodes, but no menu has been
 * measured against them yet.
 *
 * ## Where the tones land in the audio
 *
 * Behind whatever agent audio is already queued, and paced like it: a key
 * pressed after "one moment" is heard after it. They ARE agent audio, so a
 * barge-in that cancels the reply drops tones not yet played — press keys in a
 * turn that says nothing, which is also what a menu expects.
 *
 * @module
 */

import { globalSlot } from "./_boundary.ts";
import { createOwnedMap, type OwnedMap } from "./owned-map.ts";
import type { ToolContext } from "./tool-context.ts";

/**
 * The keys {@link sendDtmf} accepts: the twelve on a phone pad, the four
 * `A`–`D` column keys, and `w`, a half-second pause between keys (Twilio's
 * `sendDigits` spelling) for a menu that needs a beat before the next one.
 *
 * @public
 */
export const DTMF_KEYS: string = ["0123456789", "*#", "ABCD", "w"].join("");

/**
 * Most keys one {@link sendDtmf} call presses, pauses included. Past any
 * extension, PIN or account number a menu asks for; a longer string is a model
 * looping, and tones are seconds of audio each.
 *
 * @public
 */
export const MAX_DTMF_KEYS = 64;

/** What the runtime registers for a session — see {@link claimDtmfSender}. */
export type DtmfSender = (keys: string) => void;

const DTMF_SENDERS_SLOT = globalSlot<OwnedMap<string, DtmfSender>>("sessionDtmfSenders");

function senders(): OwnedMap<string, DtmfSender> {
  let map = DTMF_SENDERS_SLOT.get();
  if (map === undefined) {
    map = createOwnedMap();
    DTMF_SENDERS_SLOT.set(map);
  }
  return map;
}

/**
 * Register how `sessionId` plays keys; returns the release for THIS claim, a
 * no-op once a resumed connection has claimed the id again.
 *
 * @internal — the runtime's half (`aai-runtime/src/session/attach.ts`), and `createToolContext`'s.
 */
export function claimDtmfSender(sessionId: string, sender: DtmfSender): () => boolean {
  return senders().claim(sessionId, sender);
}

/**
 * `keys` with spaces, dashes and commas dropped and lowercase `a`–`d` raised —
 * the separators a model writes into "1, 2, 3" or "555-0100" — or a
 * `TypeError` naming the first key no phone has.
 */
function normalizeKeys(keys: string): string {
  const cleaned = keys.replace(/[\s,-]/g, "").replace(/[a-d]/g, (k) => k.toUpperCase());
  if (cleaned.length === 0) throw new TypeError("sendDtmf: no keys to press");
  if (cleaned.length > MAX_DTMF_KEYS) {
    throw new TypeError(`sendDtmf: ${cleaned.length} keys is over the ${MAX_DTMF_KEYS}-key limit`);
  }
  for (const key of cleaned) {
    if (!DTMF_KEYS.includes(key)) {
      throw new TypeError(`sendDtmf: "${key}" is not a phone key (use 0-9, *, #, A-D, or w)`);
    }
  }
  return cleaned;
}

/**
 * Press phone keys — DTMF tones played into this session's audio, for
 * navigating a phone menu ("press 1 for billing") or entering an extension.
 *
 * ```ts
 * import { tool } from "@alexkroman1/aai";
 * import { sendDtmf } from "@alexkroman1/aai/experimental";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Press keys on the phone keypad to answer an automated menu.",
 *   inputSchema: z.object({ keys: z.string().describe("e.g. '1', '2#', '1234#'") }),
 *   execute({ keys }, ctx) {
 *     return { pressed: sendDtmf(ctx, keys) ? keys : null };
 *   },
 * });
 * ```
 *
 * `keys` is any of {@link DTMF_KEYS}; spaces, commas and dashes are ignored,
 * and `w` waits half a second. The tones queue behind the agent audio already
 * playing. A barge-in drops the ones not yet played, as it does speech.
 *
 * @throws TypeError when `keys` names no key, a character no phone has, or more
 * than {@link MAX_DTMF_KEYS} keys — a tool's throw reaches the model as the
 * tool's error, which is how it learns to retry with a real key.
 * @returns `true` when the keys were queued; `false` when this context belongs
 * to no connected session (it ended, or never had audio to play into).
 */
export function sendDtmf(ctx: Pick<ToolContext, "sessionId">, keys: string): boolean {
  const cleaned = normalizeKeys(keys);
  const sender = senders().get(ctx.sessionId);
  if (sender === undefined) return false;
  sender(cleaned);
  return true;
}
