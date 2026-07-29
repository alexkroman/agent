// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connection client-config wire format.
 *
 * `GET /client-config` (dev server) / `GET /:slug/client-config` (platform)
 * tells a browser client how to talk to the agent *before* any connection
 * exists — most importantly which transport the agent declared
 * (`agent({ transport })`). The default client fetches this on load and
 * picks the WebSocket session or the sync (HTTP-turn) shell accordingly;
 * without it, a sync-transport agent would need a custom `client.tsx` just
 * to avoid opening a WebSocket.
 *
 * Unauthenticated by design — parity with the agent page, the WebSocket
 * upgrade, and `POST /sync`, and it only reveals what the page itself shows.
 * Node-free (`sdk/`), so the same schema validates in the browser.
 */

import { z } from "zod";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";

/** Relative path of the client-config endpoint under an agent's base URL. */
export const CLIENT_CONFIG_PATH = "client-config";

/**
 * Body of `GET /client-config`. `transport` defaults to `"websocket"` so a
 * response from an older server (or a hand-rolled one) that omits the field
 * keeps today's behavior.
 */
export const ClientConfigResponseSchema = z.object({
  transport: z.enum(["websocket", "sync"]).default("websocket"),
  /** Agent display name, for the default client's header/start screen. */
  name: z.string().optional(),
  /**
   * The agent's greeting. A sync client has no session start for the server
   * to speak it on, so the default sync shell shows it as the opening
   * assistant message instead.
   */
  greeting: z.string().max(MAX_TRANSCRIPT_CHARS).optional(),
});

/** Parsed body of `GET /client-config`. */
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;
