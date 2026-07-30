// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /:slug/client-config` — pre-connection client config (see
 * `sdk/client-config.ts` in `@alexkroman1/aai`): the agent's app kind, plus
 * name/greeting for the default client's shell. Same auth posture as the
 * agent page and the WebSocket: none.
 *
 * Its own module (like `sync-turn-handler.ts`) rather than a corner of the
 * WebSocket transport file — this endpoint is plain HTTP and serves both app
 * kinds.
 */

import { buildClientConfig } from "@alexkroman1/aai/protocol";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";

export async function handleAgentClientConfig(c: AppContext): Promise<Response> {
  const slug = c.var.slug;
  const config = await c.env.store.getAgentConfig(slug);
  if (!config) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }
  return c.json(
    buildClientConfig({ kind: config.kind, name: config.name, greeting: config.greeting }),
  );
}
