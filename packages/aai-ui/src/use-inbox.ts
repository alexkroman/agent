// Copyright 2026 the AAI authors. MIT license.
/**
 * `useInbox()` — the session's client, reachable after the session has ended.
 *
 * A tool that starts a durable run (a reminder, a research job) hands the run
 * `sessionClientId(ctx)`, and the run's `stepNotifyClient` delivers to whoever
 * holds that client's `WS /inbox` socket when it is done — usually long after
 * the voice session closed. This hook holds that socket for the page, under the
 * SESSION's own client id (`mountClient({ client: "auto" })` is the one-word
 * way to have one) and this tab's holder id, and plays each notice aloud.
 *
 * Three decisions a hand-written copy got wrong or had to rediscover:
 *
 * - **Busy by default while the session is running**, so a reminder never talks
 *   over a reply: the page answers `busy`, the step's retry brings the notice
 *   back, and it plays once the call is over. Override with `busy`.
 * - **Callbacks are read at call time**, not captured at mount: a new `onNotice`
 *   every render does not reconnect the socket. Only `events` does, because it
 *   is part of the socket's URL.
 * - **Playback is unlocked by the page's first gesture** (`notice-player.ts`):
 *   the autoplay policy silences a context created without one, and a notice
 *   arrives hours after any click.
 * - **One tab plays: the one last touched.** Every tab is a holder of its own,
 *   and the inbox sends a notice to each, so nine open tabs played it nine
 *   times a few milliseconds apart — heard as one choppy, phasing voice. A
 *   gesture claims the client's player in `localStorage`, which every tab of
 *   the origin shares synchronously; the others still ack and still call
 *   `onNotice`, they just stay quiet. A claimant that closes gives the claim
 *   back, and with no claim every unlocked tab plays, as before.
 *
 * @module
 */

import { useCallback, useEffect, useRef, useState } from "react";
import { useSessionCore } from "./context.ts";
import { createInbox } from "./inbox.ts";
import type { InboxEvent, InboxNotice } from "./inbox-protocol.ts";
import { createNoticePlayer, type NoticePlayer } from "./notice-player.ts";

/**
 * Options for {@link useInbox}.
 *
 * @public
 */
export type UseInboxOptions = {
  /**
   * A notice arrived whole — once per delivery, after playback has started
   * (when `play` is on). Log it, show it, or play it yourself with `play: false`.
   */
  onNotice?: ((notice: InboxNotice) => void) | undefined;
  /**
   * A frame of the client's live conversation — every session of this client,
   * this page's own included (compare `sessionId` with `useSessionId()` to skip
   * it). Giving one asks for the feed, unless `events` says otherwise.
   */
  onEvent?: ((event: InboxEvent) => void) | undefined;
  /**
   * Whether to refuse a notice for now (`busy`; it comes back later). Default:
   * the session is running — connecting, listening, thinking or speaking.
   */
  busy?: (() => boolean) | undefined;
  /**
   * Play each notice's audio (PCM16LE mono, 16 kHz) through built-in playback.
   * Default `true`.
   */
  play?: boolean | undefined;
  /** Ask for the client's live conversation (`?events=1`). Default: whether `onEvent` is set. */
  events?: boolean | undefined;
};

/**
 * What {@link useInbox} returns.
 *
 * @public
 */
export type UseInboxResult = {
  /** Whether the inbox socket is open now. */
  readonly connected: boolean;
  /** Silence a notice that is playing — e.g. when the user starts talking. */
  stopPlayback(): void;
};

/** The page gestures that unlock playback — see `notice-player.ts`. */
const GESTURES = ["pointerdown", "keydown"] as const;

/** The `localStorage` key naming which holder of `clientId` plays its notices. */
const playerKey = (clientId: string): string => `aai.inbox.player.${clientId}`;

/**
 * Read, claim or release the client's player — see the module doc. Storage
 * that throws (a sandboxed frame, a full quota) claims nothing, so every tab
 * plays, which is the behaviour before there was a claim at all.
 */
const claims = {
  mine(clientId: string, holder: string): boolean {
    try {
      const owner = localStorage.getItem(playerKey(clientId));
      return owner === null || owner === holder;
    } catch {
      return true;
    }
  },
  claim(clientId: string, holder: string): void {
    try {
      localStorage.setItem(playerKey(clientId), holder);
    } catch {
      // No storage: nothing to claim, so every tab plays.
    }
  },
  release(clientId: string, holder: string): void {
    try {
      if (localStorage.getItem(playerKey(clientId)) === holder)
        localStorage.removeItem(playerKey(clientId));
    } catch {
      // No storage: nothing to claim, so every tab plays.
    }
  },
};

/**
 * Hold this session's `WS /inbox` socket open for the life of the component,
 * and play what arrives — see the module doc.
 *
 * The session needs a client id: `mountClient({ client: "auto" })`, or a
 * `client` of your own. With none, no socket is opened (`connected` stays
 * `false`) until the session's `client` getter answers one.
 *
 * @example
 * ```tsx
 * import { mountClient, useInbox } from "@alexkroman1/aai-ui";
 *
 * function App() {
 *   const { connected } = useInbox({
 *     onNotice: (notice) => console.log(notice.event, notice.data),
 *   });
 *   return <p>{connected ? "Reminders on" : "Reminders offline"}</p>;
 * }
 *
 * mountClient({ client: "auto", component: App });
 * ```
 *
 * @param options - What to do with a notice or a live event; see {@link UseInboxOptions}.
 * @returns Whether the socket is open, and a way to stop playback.
 *
 * @public
 */
export function useInbox(options: UseInboxOptions = {}): UseInboxResult {
  const session = useSessionCore();
  const latest = useRef(options);
  latest.current = options;
  const events = options.events ?? options.onEvent !== undefined;
  const [connected, setConnected] = useState(false);
  const player = useRef<NoticePlayer | null>(null);
  player.current ??= createNoticePlayer();

  useEffect(() => {
    const notices = player.current;
    const { identity } = session;
    const holder = identity.holderId();
    const unlock = () => {
      notices?.unlock();
      const client = identity.clientId();
      if (client) claims.claim(client, holder);
    };
    const release = () => {
      const client = identity.clientId();
      if (client) claims.release(client, holder);
    };
    for (const type of GESTURES) addEventListener(type, unlock, { capture: true });
    addEventListener("pagehide", release);
    return () => {
      for (const type of GESTURES) removeEventListener(type, unlock, { capture: true });
      removeEventListener("pagehide", release);
      release();
      notices?.close();
    };
  }, [session]);

  useEffect(() => {
    const { identity } = session;
    const holder = identity.holderId();
    const inbox = createInbox({
      platformUrl: identity.platformUrl,
      client: () => identity.clientId(),
      holder,
      events,
      busy: () => (latest.current.busy ?? (() => session.getSnapshot().running))(),
      onNotice: (notice) => {
        const client = identity.clientId();
        const mine = client === undefined || claims.mine(client, holder);
        if (latest.current.play !== false && mine) player.current?.play(notice.pcm);
        latest.current.onNotice?.(notice);
      },
      onEvent: (event) => latest.current.onEvent?.(event),
    });
    const off = inbox.subscribe(() => setConnected(inbox.connected()));
    return () => {
      off();
      inbox.close();
      setConnected(false);
    };
  }, [session, events]);

  const stopPlayback = useCallback(() => player.current?.stop(), []);
  return { connected, stopPlayback };
}
