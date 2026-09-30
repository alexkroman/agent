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
 * plus a hard cap, so an abandoned process cannot grow it. The map, the E.164
 * rule and the one writer (which applies it) are `_session-identity-store.ts`.
 *
 * The value is personal data: never log it.
 *
 * @module
 */

import {
  liveSessionEntry,
  recordSessionIdentity,
  sessionPhoneEntries,
} from "./_session-identity-store.ts";
import type { ToolContext } from "./tool-context.ts";

export { normalizeE164 } from "./_session-identity-store.ts";

/**
 * Record the number a session's socket reported, in E.164 (`normalizeE164`;
 * one that is not E.164 is not recorded). A resume that reports none keeps the
 * previous one: the caller only calls this with a number.
 *
 * @internal — the runtime's half; `recordSessionIdentity` records every field at once.
 */
export function setSessionPhone(sessionId: string, phone: string): void {
  recordSessionIdentity(sessionId, { phone });
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
  return liveSessionEntry(sessionPhoneEntries(), ctx.sessionId)?.phone;
}
