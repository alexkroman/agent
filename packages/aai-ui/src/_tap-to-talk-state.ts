// Copyright 2026 the AAI authors. MIT license.
/**
 * `useTapToTalk`'s decisions as a statechart, with no React and no session:
 * what a tap does, when a call hangs itself up, and when a connection attempt
 * has failed. The hook feeds it what the session DID (`SESSION`) and what the
 * caller pressed (`TAP`, `TEXT`, `HANG_UP`), and it calls back through
 * {@link TapToTalkEffects} — the pattern `session-core-audio-state.ts` uses, so
 * `_tap-to-talk-state.test.ts` specs every timer without a browser.
 *
 * Two regions, because they move independently:
 *
 * - **`live`** — whether the caller has the mic open for a realtime
 *   conversation. Only a tap enters it; a tap, a hang-up or the session going
 *   down leaves it. The mic is muted on the way out and unmuted on the way in
 *   (entry actions, so no path can forget).
 * - **`session`** — the call as the session reports it: `idle`, `connecting`,
 *   or `active` split by what the agent is doing, because each of those has
 *   its own hang-up clock (`quiet`: the follow-up window; `thinking`: a longer
 *   one, so a slow tool is not cut off; `speaking`: none). Any session
 *   activity RE-ENTERS the active child, which restarts its clock — the
 *   firmware's `agent_last_activity_ms()`.
 *
 * A clock only hangs up when `live` is `off`: a live conversation ends when
 * the caller says so, as the device's does.
 */

import { assign, createActor, raise, setup, stateIn } from "xstate";
import type { AgentState } from "./types.ts";

/** What the session looks like to a tap: the three phases the hook publishes. */
export type TapToTalkPhase = "idle" | "connecting" | "active";

/** The three clocks, read per use so a re-render with new options takes effect. */
export type TapToTalkTiming = {
  /** Quiet, not live, not thinking or speaking: hang up after this long. */
  idleHangupMs: number;
  /** Thinking, not live: hang up after this long. */
  thinkingHangupMs: number;
  /** Connecting: give up (and report `failed`) after this long. */
  connectTimeoutMs: number;
};

/** What the machine decides and cannot do itself. */
export type TapToTalkEffects = {
  /** Bring the session up if it is not meant to be running. Idempotent. */
  connect(): void;
  /** Hang up, resumably — `session.disconnect()`. */
  hangUp(): void;
  /** Stop the agent's current reply — `session.cancel()`. */
  cancel(): void;
  /** Mute (`true`) or open the mic. */
  setMuted(muted: boolean): void;
};

/** Everything that moves the machine. */
export type TapToTalkEvent =
  /** The talk button or key. */
  | { type: "TAP" }
  /** Hang up now, whatever the state. */
  | { type: "HANG_UP" }
  /** A typed turn: it clears a previous failure like a tap does. */
  | { type: "TEXT" }
  /**
   * The session moved or did something — sent on every activity, not only a
   * phase change. `activity` is the snapshot's `contentVersion`: informational,
   * since every SESSION event already counts as activity.
   */
  | { type: "SESSION"; phase: TapToTalkPhase; agent: AgentState; activity?: number }
  /** The session reported an error. */
  | { type: "ERROR" };

type Input = { effects: TapToTalkEffects; timing: () => TapToTalkTiming };
type Context = Input & { failed: boolean };
/** Raised internally when the session goes down on its own. */
type Internal = { type: "DROPPED" };

/**
 * An active session event's targets, by what the agent is doing. RE-ENTERED,
 * so the same child again restarts its clock: that is what activity means.
 */
const TO_ACTIVE = [
  { guard: "speaking", target: "#tapToTalk.session.active.speaking", reenter: true },
  { guard: "thinking", target: "#tapToTalk.session.active.thinking", reenter: true },
  { guard: "active", target: "#tapToTalk.session.active.quiet", reenter: true },
] as const;

const machine = setup({
  types: {} as {
    context: Context;
    input: Input;
    events: TapToTalkEvent | Internal;
  },
  actions: {
    connect: ({ context }) => context.effects.connect(),
    hangUp: ({ context }) => context.effects.hangUp(),
    cancel: ({ context }) => context.effects.cancel(),
    mute: ({ context }) => context.effects.setMuted(true),
    unmute: ({ context }) => context.effects.setMuted(false),
    markFailed: assign({ failed: true }),
    clearFailed: assign({ failed: false }),
  },
  guards: {
    notLive: stateIn({ live: "off" }),
    down: ({ event }) => event.type === "SESSION" && event.phase === "idle",
    connecting: ({ event }) => event.type === "SESSION" && event.phase === "connecting",
    active: ({ event }) => event.type === "SESSION" && event.phase === "active",
    speaking: ({ event }) =>
      event.type === "SESSION" && event.phase === "active" && event.agent === "speaking",
    thinking: ({ event }) =>
      event.type === "SESSION" && event.phase === "active" && event.agent === "thinking",
  },
  delays: {
    idle: ({ context }) => context.timing().idleHangupMs,
    thinking: ({ context }) => context.timing().thinkingHangupMs,
    connect: ({ context }) => context.timing().connectTimeoutMs,
  },
}).createMachine({
  id: "tapToTalk",
  type: "parallel",
  context: ({ input }) => ({ ...input, failed: false }),
  on: {
    ERROR: { actions: "markFailed" },
    TEXT: { actions: "clearFailed" },
  },
  states: {
    live: {
      initial: "off",
      states: {
        off: {
          entry: "mute",
          on: {
            TAP: { target: "on", actions: "clearFailed" },
            HANG_UP: { actions: "hangUp" },
          },
        },
        on: {
          // Unmuted BEFORE the connect, so the call opens with the mic live.
          entry: ["unmute", "connect"],
          on: {
            // Cut off whatever the agent was saying, then hang up.
            TAP: { target: "off", actions: ["cancel", "hangUp"] },
            HANG_UP: { target: "off", actions: "hangUp" },
            DROPPED: "off",
          },
        },
      },
    },
    session: {
      initial: "idle",
      states: {
        idle: {
          on: {
            SESSION: [{ guard: "connecting", target: "connecting" }, ...TO_ACTIVE],
          },
        },
        connecting: {
          after: {
            connect: { actions: ["markFailed", raise({ type: "HANG_UP" })] },
          },
          on: {
            SESSION: [
              { guard: "down", target: "idle", actions: raise({ type: "DROPPED" }) },
              ...TO_ACTIVE,
            ],
          },
        },
        active: {
          initial: "quiet",
          on: {
            SESSION: [
              { guard: "down", target: "idle", actions: raise({ type: "DROPPED" }) },
              { guard: "connecting", target: "connecting" },
              ...TO_ACTIVE,
            ],
          },
          states: {
            quiet: {
              after: { idle: { guard: "notLive", actions: raise({ type: "HANG_UP" }) } },
            },
            thinking: {
              after: { thinking: { guard: "notLive", actions: raise({ type: "HANG_UP" }) } },
            },
            speaking: {},
          },
        },
      },
    },
  },
});

/** What the hook renders from. A new object only when a field changes. */
export type TapToTalkView = { live: boolean; failed: boolean };

/** One running machine: send events, read and subscribe to its view, stop it. */
export type TapToTalkStore = {
  send(event: TapToTalkEvent): void;
  getView(): TapToTalkView;
  subscribe(listener: () => void): () => void;
  stop(): void;
};

/** Start a machine over `effects`. */
export function createTapToTalk(
  effects: TapToTalkEffects,
  timing: () => TapToTalkTiming,
): TapToTalkStore {
  const actor = createActor(machine, { input: { effects, timing } });
  let view: TapToTalkView = { live: false, failed: false };
  const read = (): TapToTalkView => {
    const at = actor.getSnapshot();
    const live = at.matches({ live: "on" });
    const { failed } = at.context;
    if (live !== view.live || failed !== view.failed) view = { live, failed };
    return view;
  };
  actor.start();
  return {
    send: (event) => actor.send(event),
    getView: read,
    subscribe(listener) {
      const sub = actor.subscribe(() => listener());
      return () => sub.unsubscribe();
    },
    stop: () => actor.stop(),
  };
}
