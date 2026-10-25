// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.workflows` for ONE session: the runtime's client with `"session"`
 * resolved to the session id — `StartOptions.key`'s default.
 *
 * The client is per-RUNTIME, and a run outlives the session that started it,
 * so nothing about reading a run is session-scoped — except the one thing
 * every voice tool was told to write by hand: `{ key: ctx.sessionId }` on the
 * start, and `ctx.sessionId` again on the `find` that reads it back. The key
 * is what makes the run reachable from the caller's next turn and next call,
 * and a tool that forgot it started a run nobody could find. So the session
 * id is the DEFAULT here, where it is known: a start with no key, or with the
 * literal `"session"`, is keyed by the session, and every keyed read accepts
 * the same literal.
 *
 * Only the keyed methods are wrapped; everything else is the client's own.
 * The notifier's wrapper (`withNotify`, `workflow/notify.ts`) composes over
 * this, so a tool's client is session-scoped whether or not it can be
 * notified.
 *
 * @internal
 */

import { SESSION_KEY } from "@alexkroman1/aai/host-internal";
import type { StartOptions, WorkflowClient } from "@alexkroman1/aai/workflow-api";

/**
 * `workflows`, with `"session"` (and an absent start key) meaning `sessionId`.
 *
 * @internal
 */
export function forSession(workflows: WorkflowClient, sessionId: string): WorkflowClient {
  const keyOf = (key: string | undefined): string =>
    key === undefined || key === SESSION_KEY ? sessionId : key;
  // Each overloaded method is delegated with its arguments as given and the key
  // rewritten, then asserted back to the client's own overload set: a wrapper
  // cannot restate an overload without copying it, and `never` parameters are
  // what let one body serve both arms.
  return {
    ...workflows,
    start: ((workflow: never, input: never, options?: StartOptions) =>
      workflows.start(workflow, input, {
        ...options,
        key: keyOf(options?.key),
      })) as WorkflowClient["start"],
    find: ((workflow: never, key: string, options?: never) =>
      workflows.find(workflow, keyOf(key), options)) as WorkflowClient["find"],
    latest: ((workflow: never, key?: string) =>
      workflows.latest(workflow, keyOf(key))) as WorkflowClient["latest"],
    live: ((workflow: never, key?: string) =>
      workflows.live(workflow, keyOf(key))) as WorkflowClient["live"],
    findByKey: (key, options) => workflows.findByKey(keyOf(key), options),
    cancelAll: ((workflow: never, key: string) =>
      workflows.cancelAll(workflow, keyOf(key))) as WorkflowClient["cancelAll"],
    signalRun: ((workflow: never, key: string, label: string, payload?: unknown, options?: never) =>
      workflows.signalRun(
        workflow,
        keyOf(key),
        label,
        payload,
        options,
      )) as WorkflowClient["signalRun"],
  };
}
