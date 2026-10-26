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
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import { mapArgument, wrapStart } from "./_client-wrap.ts";

/**
 * `workflows`, with `"session"` (and an absent start key) meaning `sessionId`.
 *
 * @internal
 */
export function forSession(workflows: WorkflowClient, sessionId: string): WorkflowClient {
  const keyOf = (key: string | undefined): string =>
    key === undefined || key === SESSION_KEY ? sessionId : key;
  // The key is the second argument of every keyed method but two: `start`
  // carries it in its options, `findByKey` first.
  const keyed = <F extends (...args: never[]) => unknown>(method: F, at = 1): F =>
    mapArgument(method, at, keyOf);
  return {
    ...wrapStart(workflows, (start, workflow, input, options) =>
      start(workflow, input, { ...options, key: keyOf(options?.key) }),
    ),
    find: keyed(workflows.find),
    latest: keyed(workflows.latest),
    live: keyed(workflows.live),
    findByKey: keyed(workflows.findByKey, 0),
    cancelAll: keyed(workflows.cancelAll),
    signalRun: keyed(workflows.signalRun),
  };
}
