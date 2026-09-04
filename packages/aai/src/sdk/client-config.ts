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

// The endpoint's path lives in a leaf module and is re-exported here, so this
// module stays the one place a caller reads it from while the zod-free half of
// the SDK can import it without pulling a schema in. See that module.
export { CLIENT_CONFIG_METHODS, CLIENT_CONFIG_PATH } from "./client-config-path.ts";

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
  /**
   * What this agent's front door is — see `AgentDef.page`.
   *
   * Here so a client can tell the two apart BEFORE it dials: a static agent has
   * no `/websocket` to open, and the default shell would otherwise render a
   * start screen whose only button opens a socket the server declines.
   *
   * Always sent: `buildClientConfig` defaults it, so every server that serves the
   * endpoint states the front door rather than leaving a reader to infer one.
   */
  page: z.enum(["voice", "static"]),
});

/** Parsed body of `GET /client-config`. */
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;

/**
 * Build the `GET /client-config` response body from an agent-shaped config.
 *
 * Every server that serves the endpoint (a self-hosted `createRuntimeServer`, the
 * platform's per-slug handler, the CLI dev server) goes through this, so a
 * surface rule can't drift between them.
 */
export function buildClientConfig(src: {
  name?: string | undefined;
  greeting?: string | undefined;
  sessionUrl?: string | undefined;
  page?: "voice" | "static" | undefined;
}): ClientConfigResponse {
  return {
    ...omitUndefined({
      name: src.name,
      greeting: src.greeting,
      sessionUrl: src.sessionUrl,
    }),
    page: src.page ?? "voice",
  };
}
