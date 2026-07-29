// Copyright 2026 the AAI authors. MIT license.
/**
 * Slack send-channel descriptor — posts messages to a Slack incoming
 * webhook (`https://hooks.slack.com/services/...`).
 *
 * The webhook URL embeds its own credential, so it is a secret: it resolves
 * from the agent env ({@link SLACK_WEBHOOK_URL_ENV}, set via `.env` locally
 * or `aai secret put` in production), never from descriptor options.
 *
 * Implemented with plain `fetch` rather than `@slack/webhook` deliberately:
 * the official package is Node-only (engines >= node 20, pulls `retry` /
 * `p-retry` / `@types/node`), so it can neither run in the Deno guest
 * sandbox nor ship inside agent bundles — and an incoming webhook is a
 * single JSON POST.
 */

import type { SendProvider } from "../../providers.ts";

/** Provider kind tag for the Slack send channel. */
export const SLACK_SEND_KIND = "slack" as const;

/** Env var holding the Slack incoming-webhook URL (the URL is the credential). */
export const SLACK_WEBHOOK_URL_ENV = "SLACK_WEBHOOK_URL";

/**
 * Host Slack incoming webhooks live on. Declaring `send: slack()` adds this
 * to the agent's `allowedHosts` automatically, so tool code inside the guest
 * sandbox can post through the proxied fetch without extra configuration.
 */
export const SLACK_WEBHOOK_HOST = "hooks.slack.com";

/** Options for the Slack send channel. (None yet — the webhook URL carries everything.) */
export type SlackSendOptions = Record<string, never>;

/** Descriptor for the Slack send channel. See {@link slack}. */
export type SlackSendProvider = SendProvider & {
  readonly kind: typeof SLACK_SEND_KIND;
  readonly options: SlackSendOptions;
};

/**
 * Declare Slack as the agent's outbound send channel.
 *
 * Messages post to the incoming webhook in `SLACK_WEBHOOK_URL`. A string
 * message becomes `{ text }`; an object posts verbatim as the webhook body
 * (so callers control the full payload — blocks, attachments, etc.).
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { slack } from "@alexkroman1/aai/send";
 *
 * export default agent({
 *   name: "My Agent",
 *   send: slack(),
 * });
 * ```
 *
 * @public
 */
export function slack(): SlackSendProvider {
  return { kind: SLACK_SEND_KIND, options: {} };
}
