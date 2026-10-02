// Copyright 2026 the AAI authors. MIT license.
/**
 * The bridge from an XState actor to `useSyncExternalStore`: the one shape
 * `_tap-to-talk-state.ts` and `_workflow-form-state.ts` hand their hooks.
 * `read` must return the SAME object while nothing it projects has changed —
 * `useSyncExternalStore` re-renders on every new reference.
 */

import type { Actor, AnyStateMachine, EventFromLogic } from "xstate";

/** A started machine, as a React hook subscribes to it. */
export type ActorStore<Event, View> = {
  send(event: Event): void;
  getView(): View;
  subscribe(listener: () => void): () => void;
  stop(): void;
};

/** Start `actor` and expose it through `read`, its memoized projection. */
export function actorStore<Machine extends AnyStateMachine, View>(
  actor: Actor<Machine>,
  read: () => View,
): ActorStore<EventFromLogic<Machine>, View> {
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
