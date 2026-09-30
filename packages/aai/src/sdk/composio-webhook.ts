// Copyright 2026 the AAI authors. MIT license.
/**
 * Composio's trigger events, received: the V3 payload type, the event as text
 * a model reads, a signed-webhook route that hands only trigger events to the
 * author, and the one-time setup that points the project's single webhook
 * subscription at the agent.
 *
 * On `@alexkroman1/aai/experimental`, beside {@link composio}.
 *
 * The route verifies before anything else runs ({@link webhookRoute}: the
 * Standard Webhooks signature, the replay window); the author's handler then
 * decides whether the event is one it asked for — `metadata.trigger_id` is a
 * CLAIM until matched against a trigger this agent created for
 * `metadata.user_id`.
 *
 * @module composio-webhook
 */

import type { RouteContext, RouteHandler, RouteRequest } from "./agent-routes.ts";
import { routeResponse } from "./agent-routes.ts";
import { composioApi } from "./composio-api.ts";
import { fitToolResult } from "./fit-tool-result.ts";
import { isRecord } from "./is-record.ts";
import { webhookRoute } from "./standard-webhook.ts";
import type { EnvContext } from "./step-env.ts";

/** The webhook event type a trigger's event arrives as. @public */
export const COMPOSIO_TRIGGER_MESSAGE = "composio.trigger.message";

/** The env var {@link composioWebhookRoute} reads the signing secret from by default. @public */
export const COMPOSIO_WEBHOOK_SECRET_ENV: string = "COMPOSIO_WEBHOOK_SECRET";

/** A trigger event as Composio's V3 webhook payload carries it. @public */
export type ComposioTriggerEvent = {
  /** The event id — a dedupe key: a redelivery carries the same one. */
  id: string;
  /** `"composio.trigger.message"` for a trigger's event; other project events arrive too. */
  type: string;
  timestamp?: string;
  metadata?: {
    trigger_id?: string;
    trigger_slug?: string;
    /** The Composio user the trigger's account belongs to. */
    user_id?: string;
    connected_account_id?: string;
    auth_config_id?: string;
    log_id?: string;
  };
  /** The app's own payload (an email, a PR…). */
  data?: unknown;
};

/**
 * An event's `data` as compact JSON text a model can read: empty fields
 * dropped, long strings clipped (`maxString`, default 800), and the whole at
 * most `maxChars`.
 *
 * @public
 */
export function composioTriggerText(
  data: unknown,
  options: { maxChars: number; maxString?: number },
): string {
  const fitted = fitToolResult(data ?? {}, {
    maxChars: options.maxChars,
    maxString: options.maxString ?? 800,
  });
  return JSON.stringify(fitted ?? {}).slice(0, options.maxChars);
}

/** What {@link composioWebhookRoute} takes. @public */
export interface ComposioWebhookRouteOptions {
  /** The env var holding the subscription's signing secret. Default {@link COMPOSIO_WEBHOOK_SECRET_ENV}. */
  secretEnv?: string;
  /** Replay window in seconds, as `webhookRoute`'s. Default 300. */
  toleranceS?: number;
}

/**
 * An `agent({ routes })` handler for Composio's webhook: verified as
 * {@link webhookRoute} verifies (401 on a bad signature, 500 when the secret
 * is unset), then `onTrigger` runs for a `composio.trigger.message` event and
 * its return value is the response. Any other event type is acknowledged
 * `{ ignored: <type> }` without calling it; a signed body that is not an event
 * answers 400.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { composioWebhookRoute } from "@alexkroman1/aai/experimental";
 *
 * export default agent({
 *   name: "Kitchen speaker",
 *   routes: {
 *     "POST /composio/webhook": composioWebhookRoute({}, async (event, ctx) => {
 *       // Match event.metadata.trigger_id to a trigger this agent made, then act.
 *       return { received: event.id };
 *     }),
 *   },
 * });
 * ```
 *
 * @public
 */
export function composioWebhookRoute(
  options: ComposioWebhookRouteOptions,
  onTrigger: (event: ComposioTriggerEvent, ctx: RouteContext, req: RouteRequest) => unknown,
): RouteHandler {
  return webhookRoute(
    {
      secretEnv: options.secretEnv ?? COMPOSIO_WEBHOOK_SECRET_ENV,
      ...(options.toleranceS === undefined ? {} : { toleranceS: options.toleranceS }),
    },
    async (req, ctx) => {
      const event = req.body;
      if (!(isRecord(event) && typeof event.id === "string" && typeof event.type === "string")) {
        return routeResponse(400, { error: "Not a Composio event" });
      }
      // Other project events (a connection expiring) arrive here too: acknowledged, unused.
      if (event.type !== COMPOSIO_TRIGGER_MESSAGE) return { ignored: event.type };
      return await onTrigger(event as ComposioTriggerEvent, ctx, req);
    },
  );
}

/** What {@link ensureComposioWebhook} takes beside the URL. @public */
export interface EnsureComposioWebhookOptions {
  /** As `composio()`'s. Default `"COMPOSIO_API_KEY"`. */
  apiKeyEnv?: string;
  /** As `composio()`'s. Default Composio's v3.1 REST URL. */
  baseUrl?: string;
}

/**
 * Point the Composio project's webhook at `url` — for a SETUP script, not an
 * agent. A project has one subscription: this creates it, or moves the
 * existing one, with V3 payloads and `composio.trigger.message` enabled, and
 * answers its id and signing secret (store the secret as the route's
 * `secretEnv`; never print it).
 *
 * @public
 */
export async function ensureComposioWebhook(
  ctx: EnvContext,
  url: string,
  options: EnsureComposioWebhookOptions = {},
): Promise<{ id: string; secret: string }> {
  if (!/^https:\/\//.test(url)) {
    throw new Error(`ensureComposioWebhook: the webhook URL must be https://, got ${url}`);
  }
  const api = composioApi(options);
  const want = {
    webhook_url: url,
    enabled_events: [COMPOSIO_TRIGGER_MESSAGE],
    version: "V3",
  };
  type Subscription = { id: string; secret?: string };
  const { items = [] } = await api<{ items?: Subscription[] }>(
    ctx,
    "GET",
    "/webhook_subscriptions",
  );
  const existing = items[0];
  const sub = existing
    ? await api<Subscription>(
        ctx,
        "PATCH",
        `/webhook_subscriptions/${encodeURIComponent(existing.id)}`,
        want,
      )
    : await api<Subscription>(ctx, "POST", "/webhook_subscriptions", want);
  if (typeof sub.secret !== "string" || sub.secret === "") {
    throw new Error("Composio answered the webhook subscription without its secret");
  }
  return { id: sub.id, secret: sub.secret };
}
