// Copyright 2026 the AAI authors. MIT license.
/**
 * `@alexkroman1/aai/send` subpath barrel.
 *
 * Re-exports the send-channel descriptor factories (`slack`), the resolver
 * (`openSender`), and the shared contract types. Zero Node dependencies —
 * safe to import from agent bundles running in the guest sandbox.
 */

export type { Sender, SendMessage, SendProvider } from "../providers.ts";
export { type OpenSenderOptions, openSender, sendAllowedHosts } from "./send/open.ts";
export {
  SLACK_SEND_KIND,
  SLACK_WEBHOOK_HOST,
  SLACK_WEBHOOK_URL_ENV,
  type SlackSendOptions,
  type SlackSendProvider,
  slack,
} from "./send/slack.ts";
