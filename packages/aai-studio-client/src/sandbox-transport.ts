// Copyright 2026 the AAI authors. MIT license.
/**
 * The chat transport, aimed at the project's CURRENT sandbox lease.
 *
 * A brokered session is a lease on a guest sandbox, and that sandbox is
 * evicted after an idle window (`STUDIO_SESSION_IDLE_MS`) — so a tab left
 * open over lunch holds a URL and a token for a process that no longer
 * exists. `DefaultChatTransport` captures its `api` and `headers` at
 * construction and `useChat` needs ONE transport for the life of the
 * conversation, so a transport built from the lease that existed at mount can
 * only ever talk to that one sandbox: the re-broker landed in the query cache
 * and the chat went on posting to the dead origin, message after message,
 * until the user reloaded the page. This wrapper is the seam that fixes it —
 * it builds the real transport per REQUEST, from the lease the app holds now.
 *
 * It also owns the RETRY, because a turn is the unit that can be retried and
 * a request is not: the replacement sandbox answers on a different origin
 * with a different token, so nothing inside a single fetch can re-aim itself.
 * A stale turn is sent again — once — on the fresh lease, which is what makes
 * a spun-down sandbox a pause instead of an error the user has to retype
 * through.
 *
 * Retrying is safe precisely because of what {@link StaleSandboxError} means:
 * either the guest never received the request (a rejected fetch) or it
 * refused it before the turn began (401/409). Nothing ran, so nothing can be
 * duplicated — which is also why the busy guest's 423 is NOT in that class
 * (see resilient-fetch.ts).
 */

import { type ChatTransport, DefaultChatTransport, type UIMessage } from "ai";
import type { ChatSession } from "./api.ts";
import { createResilientFetch, StaleSandboxError } from "./resilient-fetch.ts";

export type SandboxTransportOptions = {
  /** The lease to aim at, read per REQUEST — never captured. */
  session: () => ChatSession;
  /**
   * Re-broker the project's sandbox, resolving with the REPLACEMENT lease —
   * or with nothing when the broker gave up, which is when a retry would have
   * nothing to aim at and the turn fails with its original error.
   *
   * It reports the lease rather than leaving this module to re-read
   * `session()` because those are not the same moment: the broker's query
   * settles before React has re-rendered the component that owns the prop, so
   * a re-read sees the dead lease and gives up on a sandbox that is right
   * there.
   */
  rebroker: () => Promise<ChatSession | undefined>;
  /**
   * Told when the transport starts and stops waiting on a replacement
   * sandbox. That wait is a Modal spawn — seconds, not milliseconds — and
   * without it the panel says "Working…" through all of it, which is a stall
   * with no explanation attached.
   */
  onRestarting?: ((restarting: boolean) => void) | undefined;
  /** Injectable for tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch | undefined;
};

export function createSandboxTransport(options: SandboxTransportOptions): ChatTransport<UIMessage> {
  const { session, rebroker } = options;
  // One wrapper for every lease: it reads nothing but the response.
  const fetchImpl = createResilientFetch({ fetchImpl: options.fetchImpl });

  /** The AI SDK's own transport, pointed at exactly one lease. */
  const aimedAt = (lease: ChatSession): DefaultChatTransport<UIMessage> =>
    new DefaultChatTransport<UIMessage>({
      // Turns stream DIRECTLY to the project's sandbox, mirroring how voice
      // clients connect straight to a deployed agent.
      api: lease.url,
      // The broker-minted per-session token — the browser never holds a
      // long-lived credential for the sandbox's public surface.
      headers: { Authorization: `Bearer ${lease.token}` },
      fetch: fetchImpl,
    });

  /**
   * Run one request against the current lease, and run it again on a fresh
   * one when the sandbox it was aimed at turns out to be gone.
   */
  async function onLiveSandbox<T>(
    run: (transport: DefaultChatTransport<UIMessage>) => Promise<T>,
    aborted: () => boolean,
  ): Promise<T> {
    try {
      return await run(aimedAt(session()));
    } catch (err) {
      if (!(err instanceof StaleSandboxError)) throw err;
      options.onRestarting?.(true);
      try {
        const fresh = await rebroker();
        // No replacement (the broker gave up), or the user pressed Stop while
        // we waited — either way this turn is over, and the failure that
        // ended it is the one worth reporting.
        if (!fresh || aborted()) throw err;
        return await run(aimedAt(fresh));
      } finally {
        options.onRestarting?.(false);
      }
    }
  }

  return {
    sendMessages: (opts) =>
      onLiveSandbox(
        (transport) => transport.sendMessages(opts),
        () => opts.abortSignal?.aborted === true,
      ),
    reconnectToStream: (opts) =>
      onLiveSandbox(
        (transport) => transport.reconnectToStream(opts),
        // A reconnect carries no signal of its own; there is no user gesture
        // behind it to respect.
        () => false,
      ),
  };
}
