// Copyright 2026 the AAI authors. MIT license.
/**
 * Send-channel resolution — descriptor → {@link Sender}.
 *
 * Unlike the STT/TTS/LLM resolvers (host-only, in `host/providers/`), this
 * lives in `sdk/` with zero Node dependencies because a sender is just
 * `fetch` + the agent env — both of which exist everywhere tools run:
 *
 * - **Host** (self-hosted `aai dev`, host-side builtins): the runtime passes
 *   its SSRF-guarded fetch.
 * - **Guest sandbox** (custom tool code in gVisor/Deno): `globalThis.fetch`
 *   is the harness's RPC-proxied fetch, validated host-side against the
 *   agent's `allowedHosts` (which auto-includes the channel's host — see
 *   {@link sendAllowedHosts}) and SSRF rules.
 *
 * One implementation, no new RPC surface, no provider SDK in the bundle.
 */

import type { Sender, SendMessage, SendProvider } from "../../providers.ts";
import { type FetchLike, httpErrorDetail, resolveFetch } from "../_http.ts";
import { SLACK_SEND_KIND, SLACK_WEBHOOK_HOST, SLACK_WEBHOOK_URL_ENV } from "./slack.ts";

/** Options for {@link openSender}. */
export type OpenSenderOptions = {
  /**
   * Fetch implementation. Defaults to `globalThis.fetch` — the proxied fetch
   * inside the guest sandbox, the real one elsewhere. The platform runtime
   * passes its SSRF-guarded fetch for host-side execution.
   */
  fetch?: FetchLike | undefined;
};

function openSlack(env: Readonly<Record<string, string>>, fetchFn: FetchLike): Sender {
  return {
    name: SLACK_SEND_KIND,
    async send(message: SendMessage, opts?: { signal?: AbortSignal }): Promise<void> {
      // Resolved per send (not at open) so an agent that never sends doesn't
      // fail at session start over a missing secret.
      const url = env[SLACK_WEBHOOK_URL_ENV] ?? "";
      if (!url) {
        throw new Error(
          `Slack send: missing webhook URL. Set ${SLACK_WEBHOOK_URL_ENV} in the agent env ` +
            "(.env locally, `aai secret put` in production).",
        );
      }
      const body = typeof message === "string" ? { text: message } : message;
      const resp = await fetchFn(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        ...(opts?.signal ? { signal: opts.signal } : {}),
      });
      if (!resp.ok) {
        // Slack answers webhook errors as short plain text ("invalid_payload",
        // "no_service"...). Never include the URL — it embeds the credential.
        const detail = await httpErrorDetail(resp);
        throw new Error(`Slack send failed: HTTP ${resp.status}${detail ? ` (${detail})` : ""}`);
      }
    },
  };
}

/** One registry entry per send-channel kind. */
type SendChannelEntry = {
  /** Env var the channel's credential lives in. */
  readonly envVar: string;
  /** Hostnames the channel posts to (auto-allowlisted for the guest sandbox). */
  readonly hosts: readonly string[];
  readonly open: (env: Readonly<Record<string, string>>, fetchFn: FetchLike) => Sender;
};

/**
 * The send-channel registry — env var, egress hosts, and opener live
 * together, so adding a channel is one entry here (mirroring the STT/TTS/LLM
 * registries in `host/providers/resolve.ts`, which derive the channel
 * credential names from this table).
 */
export const SEND_CHANNEL_REGISTRY: Record<string, SendChannelEntry> = {
  [SLACK_SEND_KIND]: {
    envVar: SLACK_WEBHOOK_URL_ENV,
    hosts: [SLACK_WEBHOOK_HOST],
    open: openSlack,
  },
};

/**
 * Resolve a {@link SendProvider} descriptor into a live {@link Sender}.
 *
 * Safe to call anywhere (browser, guest sandbox, host) — the credential
 * comes from `env` and the network side from `opts.fetch` / global fetch.
 *
 * @example Inside a custom tool
 * ```ts
 * import { openSender, slack } from "@alexkroman1/aai/send";
 *
 * const notify = tool({
 *   description: "Notify the team channel",
 *   parameters: z.object({ text: z.string() }),
 *   execute: async ({ text }, ctx) => {
 *     await openSender(slack(), ctx.env).send(text, { signal: ctx.signal });
 *     return "sent";
 *   },
 * });
 * ```
 *
 * @public
 */
export function openSender(
  descriptor: SendProvider,
  env: Readonly<Record<string, string>>,
  opts?: OpenSenderOptions,
): Sender {
  const entry = SEND_CHANNEL_REGISTRY[descriptor.kind];
  if (!entry) {
    throw new Error(
      `Unknown send provider kind: "${descriptor.kind}". ` +
        `Supported: ${Object.keys(SEND_CHANNEL_REGISTRY).join(", ")}.`,
    );
  }
  return entry.open(env, resolveFetch(opts?.fetch));
}

/**
 * Hostnames a send channel posts to. `parseManifest` unions these into the
 * agent's `allowedHosts`, so declaring the channel is the egress opt-in —
 * guest tool code can post through the sandbox's proxied fetch without the
 * author hand-listing the webhook host.
 */
export function sendAllowedHosts(descriptor: SendProvider | undefined): string[] {
  if (!descriptor) return [];
  return [...(SEND_CHANNEL_REGISTRY[descriptor.kind]?.hosts ?? [])];
}
