// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connection client-config wire format.
 *
 * `GET /client-config` (dev server) / `GET /:slug/client-config` (platform)
 * gives a browser client the agent's display name and greeting *before* any
 * connection exists, so the default client can render its shell.
 *
 * Unauthenticated by design — parity with the agent page and the WebSocket
 * upgrade, and it only reveals what the page itself shows.
 * Node-free (`sdk/`), so the same schema validates in the browser.
 */

import { z } from "zod";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";
import { omitUndefined } from "./omit-undefined.ts";

/** Relative path of the client-config endpoint under an agent's base URL. */
export const CLIENT_CONFIG_PATH = "client-config";

/**
 * Body of `GET /client-config`. Unknown fields are stripped, so a response
 * from an older server still parses.
 */
export const ClientConfigResponseSchema = z.object({
  /** Agent display name, for the default client's header/start screen. */
  name: z.string().optional(),
  /** The agent's greeting, shown by the default shell's start screen. */
  greeting: z.string().max(MAX_TRANSCRIPT_CHARS).optional(),
  /**
   * Absolute WebSocket URL of the agent's live session endpoint. On the
   * platform, clients connect DIRECTLY to the agent's sandbox (its Modal
   * tunnel) — this endpoint is the broker that spins the sandbox up and
   * names the current URL, re-fetched on every (re)connect because the URL
   * changes when the sandbox is replaced (idle eviction, redeploy). Absent
   * on servers that terminate sessions themselves (`aai dev`), where the
   * client falls back to the same-origin `websocket` path.
   */
  sessionUrl: z.string().optional(),
});

/** Parsed body of `GET /client-config`. */
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;

/**
 * Build the `GET /client-config` response body from an agent-shaped config.
 *
 * Every server that serves the endpoint (self-hosted `host/server.ts`, the
 * platform's per-slug handler, the CLI dev server) goes through this, so a
 * surface rule can't drift between them.
 */
export function buildClientConfig(src: {
  name?: string | undefined;
  greeting?: string | undefined;
  sessionUrl?: string | undefined;
}): ClientConfigResponse {
  return omitUndefined({ name: src.name, greeting: src.greeting, sessionUrl: src.sessionUrl });
}
