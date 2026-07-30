// Copyright 2026 the AAI authors. MIT license.
/**
 * Pre-connection client-config wire format.
 *
 * `GET /client-config` (dev server) / `GET /:slug/client-config` (platform)
 * tells a browser client what kind of app the agent is *before* any
 * connection exists (`kind`: conversational agent vs one-shot workflow).
 * The default client fetches this on load and renders the chat shell or the
 * workflow run surface accordingly; without it, a workflow would need a
 * custom `client.tsx` just to avoid opening a chat WebSocket.
 *
 * Unauthenticated by design — parity with the agent page, the WebSocket
 * upgrade, and `POST /sync`, and it only reveals what the page itself shows.
 * Node-free (`sdk/`), so the same schema validates in the browser.
 */

import { z } from "zod";
import type { AgentKind } from "./config-rules.ts";
import { MAX_TRANSCRIPT_CHARS } from "./constants.ts";

/** Relative path of the client-config endpoint under an agent's base URL. */
export const CLIENT_CONFIG_PATH = "client-config";

/**
 * Body of `GET /client-config`. Unknown fields are stripped, so a response
 * from an older server (which also sent a `transport` field) still parses.
 */
export const ClientConfigResponseSchema = z.object({
  /**
   * The app's mode: `"agent"` renders the conversational shell, `"workflow"`
   * the one-shot record/upload + go surface. Defaults to `"agent"` so older
   * servers keep today's behavior.
   */
  kind: z.enum(["agent", "workflow"]).default("agent"),
  /** Agent display name, for the default client's header/start screen. */
  name: z.string().optional(),
  /**
   * The agent's greeting. The workflow surface has no session start for the
   * server to speak it on, so the default shell shows it as the idle-state
   * instruction line instead.
   */
  greeting: z.string().max(MAX_TRANSCRIPT_CHARS).optional(),
});

/** Parsed body of `GET /client-config`. */
export type ClientConfigResponse = z.infer<typeof ClientConfigResponseSchema>;

/**
 * Build the `GET /client-config` response body from an agent-shaped config.
 *
 * The one place the wire defaults are applied — every server that serves the
 * endpoint (self-hosted `host/server.ts`, the platform's per-slug handler,
 * the CLI dev server) goes through this, so a surface rule can't drift
 * between them (two of them once disagreed on how a workflow's fields were
 * derived, masked only by the client's check ordering).
 */
export function buildClientConfig(src: {
  kind?: AgentKind | undefined;
  name?: string | undefined;
  greeting?: string | undefined;
}): ClientConfigResponse {
  return {
    kind: src.kind ?? "agent",
    ...(src.name !== undefined ? { name: src.name } : {}),
    ...(src.greeting !== undefined ? { greeting: src.greeting } : {}),
  };
}
