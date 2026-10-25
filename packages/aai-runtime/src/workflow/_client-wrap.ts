// Copyright 2026 the AAI authors. MIT license.
/**
 * The two ways a `WorkflowClient` is WRAPPED without restating its overloads.
 *
 * Three wrappers exist — the session scope (`client-session.ts`), the notifier
 * (`notify.ts`) and the eval's start recorder (`eval/session.ts`) — and each
 * wants one of two things: to run something around `start`, or to rewrite the
 * KEY argument of a keyed method. `WorkflowClient`'s methods are overloaded (a
 * def or a name), which gives a function expression no contextual parameter
 * types, so a hand-written wrapper is a `never`-parameter arrow asserted back
 * to the method's own type — once per method, in three files. These are that
 * assertion, written once.
 *
 * A SPREAD rather than a `Proxy`: every client's methods are closures over
 * their own factory's state, never `this`, and a recorder's attachments
 * (`starts`, `seed`) are plain own properties the spread carries across.
 *
 * @internal
 */

import type { AnyWorkflowDef, StartOptions, WorkflowClient } from "@alexkroman1/aai/workflow-api";

/**
 * `WorkflowClient.start` with its overloads ERASED — the one signature both
 * arms reach, and what a wrapper's body is handed.
 */
export type StartCall = (
  workflow: AnyWorkflowDef | string,
  input?: unknown,
  options?: StartOptions,
) => Promise<string>;

/**
 * `client` with `start` replaced by `around`, which is handed the client's own
 * `start` and the call's arguments as given. Everything else is the client's.
 */
export function wrapStart(
  client: WorkflowClient,
  around: (
    start: StartCall,
    workflow: AnyWorkflowDef | string,
    input: unknown,
    options: StartOptions | undefined,
  ) => Promise<string>,
): WorkflowClient {
  // The erased union is what both overloads reach, and the cast back is what
  // the client itself does for its own `start`.
  const inner = client.start as unknown as StartCall;
  const start = ((workflow: AnyWorkflowDef | string, input?: unknown, options?: StartOptions) =>
    around(inner, workflow, input, options)) as WorkflowClient["start"];
  return { ...client, start };
}

/**
 * `method` with its argument at `at` rewritten by `map` on every call — the
 * key of a keyed method — and its overload set kept.
 *
 * A missing argument (`latest(def)`) is still mapped: `map` sees `undefined`,
 * which is how an absent key becomes the session's.
 */
export function mapArgument<F extends (...args: never[]) => unknown>(
  method: F,
  at: number,
  map: (value: string | undefined) => string,
): F {
  return ((...args: unknown[]) => {
    const next = [...args];
    next[at] = map(next[at] as string | undefined);
    return (method as unknown as (...args: unknown[]) => unknown)(...next);
  }) as unknown as F;
}
