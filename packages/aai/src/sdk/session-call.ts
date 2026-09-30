// Copyright 2026 the AAI authors. MIT license.
/**
 * Which PHONE CALL a session is — the carrier's own id for it and the custom
 * parameters the app put on the stream — for a session that arrived on
 * `WS /phone`.
 *
 * It exists for an app that PLACES calls. The app dials through the carrier's
 * REST API with TwiML like
 * `<Connect><Stream url="wss://…/phone?carrier=twilio"><Parameter name="call" value="c_81f2"/></Stream></Connect>`,
 * and when the call is answered the carrier opens the media stream back to the
 * agent. Nothing on that socket said which of the app's calls it was: the
 * carrier's `start` frame carries it (Twilio's `start.callSid` and
 * `start.customParameters`), and the bridge used to read three other fields of
 * that frame and drop the rest. Now `sessionContext` and `onSessionEnd` receive
 * it as `call`, and a tool reads it with {@link sessionCall}.
 *
 * ## It is a CLAIM, and the parameters are the part worth checking
 *
 * A carrier does not sign the WebSocket upgrade, and a server exposed through a
 * tunnel can be dialled by anyone who learns the URL. So treat `call` as what
 * the far end SAID. The check that makes it mean something is the app's own:
 * put an unguessable value in a `<Parameter>` when placing the call, and
 * `refuse` the session in `sessionContext` when the parameter is not one the
 * app issued — see `SessionContext.refuse`.
 *
 * Stored like `session-phone.ts` and for its reason — the runtime records it
 * and a tool in the agent bundle reads it, two copies of this module — so the
 * map hangs off `globalThis` under a `Symbol.for` key, with a TTL and a cap —
 * the map and its one writer are `_session-identity-store.ts`.
 *
 * @module
 */

import {
  liveSessionEntry,
  recordSessionIdentity,
  sessionCallEntries,
} from "./_session-identity-store.ts";
import type { ToolContext } from "./tool-context.ts";

/**
 * A phone session's call identity, as the carrier's `start` frame reported it.
 *
 * @public
 */
export type SessionCall = {
  /** The carrier that opened the stream — the `?carrier=` value (`"twilio"`, `"telnyx"`). */
  readonly carrier: string;
  /**
   * The carrier's id for the call: Twilio's `CallSid` (`CA…`), Telnyx's
   * `call_control_id`. Absent when the frame carried none.
   */
  readonly callId?: string;
  /**
   * The stream's custom parameters — Twilio's (and TeXML's) `<Parameter>`
   * elements, by name. Telnyx Call Control's `client_state`, when set, is here
   * as `client_state`, still base64 as Telnyx sends it. Empty when there were
   * none. Bounded by the bridge: at most 32 entries, each name plus value
   * under 500 characters (Twilio's own limit), non-string values dropped.
   */
  readonly parameters: Readonly<Record<string, string>>;
};

/**
 * Record the call a phone session's stream reported. Frozen, parameters too, so
 * the object `sessionContext`, `onSessionEnd` and every tool see is one value no
 * reader can change under another.
 *
 * @internal — the runtime's half; `recordSessionIdentity` records every field at once.
 */
export function setSessionCall(sessionId: string, call: SessionCall): void {
  recordSessionIdentity(sessionId, { call });
}

/**
 * The phone call this session is — the carrier, its call id and the stream's
 * custom parameters — or `undefined` for a session that did not arrive on
 * `WS /phone` (a browser tab, a device).
 *
 * The same object `sessionContext` and `onSessionEnd` receive as `call`:
 *
 * ```ts
 * import { sessionCall, tool } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export default tool({
 *   description: "Record how the call went.",
 *   inputSchema: z.object({ outcome: z.string() }),
 *   async execute({ outcome }, ctx) {
 *     const callId = sessionCall(ctx)?.parameters.call;
 *     if (!callId) return { error: "This is not one of our calls." };
 *     await fetch(`${ctx.env.CALLS_URL}/calls/${callId}`, {
 *       method: "PATCH",
 *       body: JSON.stringify({ outcome }),
 *     });
 *     return { recorded: true };
 *   },
 * });
 * ```
 */
export function sessionCall(ctx: Pick<ToolContext, "sessionId">): SessionCall | undefined {
  return liveSessionEntry(sessionCallEntries(), ctx.sessionId)?.call;
}
