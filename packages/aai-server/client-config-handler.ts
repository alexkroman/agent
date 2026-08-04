// Copyright 2026 the AAI authors. MIT license.
/**
 * `GET /:slug/client-config` — the session broker.
 *
 * Pre-connection client config (see `sdk/client-config.ts` in
 * `@alexkroman1/aai`): the agent's name/greeting for the default client's
 * shell, plus `sessionUrl` — the public `/websocket` endpoint on the agent's
 * sandbox tunnel that clients connect to DIRECTLY (voice sessions no longer
 * pass through the platform host). Resolving the sandbox here is what boots
 * it on the first request. Same auth posture as the agent page and the
 * session endpoint itself: none.
 */

import { buildClientConfig } from "@alexkroman1/aai/protocol";
import { HTTPException } from "hono/http-exception";
import type { AppContext } from "./context.ts";
import { brokerSessionUrl, type ResolveSandboxOpts } from "./sandbox-resolve.ts";

export async function handleAgentClientConfig(
  c: AppContext,
  broker: ResolveSandboxOpts,
): Promise<Response> {
  const slug = c.var.slug;
  // The config read and the broker are independent (the broker 404s on a
  // missing agent by itself), so run them concurrently: on the warm path the
  // broker answer is in-memory, and paying a serial row read before it just
  // delays the session URL.
  const [config, brokered] = await Promise.all([
    broker.store.getAgentConfig(slug),
    brokerSessionUrl(slug, broker),
  ]);
  if (!config) {
    throw new HTTPException(404, { message: `Not found: ${slug}` });
  }

  if (!brokered.ok) {
    if (brokered.status === 404) {
      throw new HTTPException(404, { message: `Not found: ${slug}` });
    }
    // The sandbox VM failed to start; the failure hook detaches it so the
    // next request rebuilds. Tell this client to retry rather than handing
    // it a session URL that will never answer.
    throw new HTTPException(503, {
      message: "agent unavailable, retry shortly",
      cause: brokered.cause,
    });
  }

  return c.json(
    buildClientConfig({
      name: config.name,
      greeting: config.greeting,
      sessionUrl: brokered.sessionUrl,
    }),
  );
}
