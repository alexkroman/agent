// Copyright 2026 the AAI authors. MIT license.
/**
 * The phone number a CLIENT reported for its session — `?phone=` on
 * `WS /websocket`, e.g. the number a browser UI's owner typed into a settings
 * field — so a tool that texts can text THAT number.
 *
 * Normalized to E.164 at the upgrade ({@link normalizeE164}), recorded under
 * the session id before the session exists (beside `?location=` and
 * `?client=`), and read by a tool with {@link sessionClientPhone}.
 *
 * Stored like `session-client.ts` and for its reason: the runtime records the
 * number and a tool in the agent bundle reads it, which are two copies of this
 * module, so the map hangs off `globalThis` under a `Symbol.for` key. A TTL
 * plus a hard cap, so an abandoned process cannot grow it.
 *
 * The value is personal data: never log it.
 *
 * @module
 */

import { liveSessionEntry } from "./session-client.ts";
import type { ToolContext } from "./tool-context.ts";

const SESSION_PHONES_SLOT = Symbol.for("@alexkroman1/aai.sessionPhones");

/** Longer than any session; this only reaps abandoned entries. */
const SESSION_PHONE_TTL_MS = 86_400_000;
const MAX_SESSION_PHONES = 10_000;

/** Longest raw `?phone=` looked at: formatting included, a real number is far shorter. */
const MAX_RAW_PHONE_CHARS = 64;

/** A `+`, then 8–15 digits, the first not 0 (no country code starts with 0). */
const E164_RE = /^\+[1-9]\d{7,14}$/;

type Entry = { phone: string; expiresAt: number };
type Slot = { [SESSION_PHONES_SLOT]?: Map<string, Entry> };

function entries(): Map<string, Entry> {
  const slot = globalThis as Slot;
  slot[SESSION_PHONES_SLOT] ??= new Map();
  return slot[SESSION_PHONES_SLOT];
}

/**
 * `raw` as an E.164 number (`+15035550123`), or `undefined` when it is not one.
 * Spaces, dashes, dots and parentheses are formatting and are stripped. A
 * number without its `+` is refused rather than guessed at: a bare ten digits
 * is not assumed to be North American.
 *
 * @internal — the upgrade's half.
 */
export function normalizeE164(raw: string): string | undefined {
  if (raw.length > MAX_RAW_PHONE_CHARS) return;
  const phone = raw.replace(/[\s().-]/g, "");
  return E164_RE.test(phone) ? phone : undefined;
}

/**
 * Record the number a session's socket reported. A resume that reports none
 * keeps the previous one: the caller only calls this with a number.
 *
 * @internal — the runtime's half, called where the session id is decided.
 */
export function setSessionPhone(sessionId: string, phone: string): void {
  const map = entries();
  // Delete-then-set keeps insertion order = least-recently-written first.
  map.delete(sessionId);
  map.set(sessionId, { phone, expiresAt: Date.now() + SESSION_PHONE_TTL_MS });
  while (map.size > MAX_SESSION_PHONES) {
    const oldest = map.keys().next().value;
    if (oldest === undefined) break;
    map.delete(oldest);
  }
}

/**
 * The phone number this session's client reported (`?phone=` on
 * `WS /websocket`, the `phone` option of `createBrowserSession` and
 * `mountClient`), in E.164 form — `"+15035550123"` — or `undefined` when it
 * reported none or an invalid one.
 *
 * **Trust model: it is whatever the connecting client CLAIMED.** Nothing
 * verifies the caller owns the number. A tool that texts it is texting a
 * number the browser supplied — fine for a single-owner home device whose
 * owner typed their own number in, but NOT for a public agent, where anyone
 * who can open a session could point your SMS tool at any number they like.
 *
 * So do not text it as is: pass it through `allowedSmsRecipient` (from
 * `@alexkroman1/aai/channels`), which uses it only when it equals
 * `SMS_TO_PHONE` or one of the comma-separated `SMS_ALLOWED_PHONES`, and
 * otherwise falls back to `SMS_TO_PHONE`. The `text_me` builtin does exactly
 * that. Personal data: do not log it.
 *
 * ```ts
 * import { sessionClientPhone, tool } from "@alexkroman1/aai";
 * import { allowedSmsRecipient, sendToChannel, textbeltChannel } from "@alexkroman1/aai/channels";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Text the owner a link.",
 *   inputSchema: z.object({ url: z.string().url() }),
 *   async execute({ url }, ctx) {
 *     const to = allowedSmsRecipient(sessionClientPhone(ctx), ctx.env);
 *     const key = ctx.env.TEXTBELT_KEY;
 *     if (!to || !key) return { error: "Texting is not set up." };
 *     await sendToChannel(textbeltChannel({ key, to }), { text: url });
 *     return { sent: true };
 *   },
 * });
 * ```
 */
export function sessionClientPhone(ctx: Pick<ToolContext, "sessionId">): string | undefined {
  return liveSessionEntry(entries(), ctx.sessionId)?.phone;
}
