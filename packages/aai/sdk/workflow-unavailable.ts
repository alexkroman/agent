// Copyright 2026 the AAI authors. MIT license.
/**
 * What `ctx.workflows` is when there is nothing behind it, and the two messages
 * that say why.
 *
 * Split from `workflow.ts` so these stay OFF the root barrel. All three are
 * `@internal` — their readers are the tool executor, the two test-context
 * builders, and this SDK's own specs — and the root export is authoring API,
 * kept small on purpose (see the `/internal` row in this package's guide). They
 * reach sibling packages through `@alexkroman1/aai/internal`.
 *
 * That also keeps them out of the TypeDoc surface, which matters: a `{@link}` to
 * an `@internal` symbol from a `@public` one is a docs-build warning, and
 * warnings are errors here.
 */

import type { WorkflowClient } from "./workflow.ts";

/**
 * What `ctx.workflows` rejects with when there is no workflow backend behind it.
 *
 * Covers both reasons at once because a tool author cannot tell them apart from
 * inside a tool, and the remedy is the same read of the docs: the app declares no
 * `workflows`, or it declares some and has nowhere to keep runs.
 *
 * @internal
 */
export const WORKFLOWS_UNAVAILABLE_MESSAGE =
  "Workflows are not available for this app. Declare them with `agent({ workflows })`, " +
  "and make sure storage is enabled (`aai storage enable`, or Settings → Database in " +
  "the studio) so runs have somewhere to live.";

/**
 * The error a declaration gets when its `run` carries no `workflowId`.
 *
 * Its own export because two layers throw it: `workflow()` at declaration time,
 * and the client when it resolves a def it was handed. Naming the bundler plugin
 * is the whole value — the symptom otherwise is `start` rejecting with the
 * Workflow DevKit's own "invalid workflow function", which points an agent author
 * at this SDK rather than at their build.
 *
 * @internal
 */
export const MISSING_WORKFLOW_ID_MESSAGE =
  'workflow({ run }) was given a function with no "use workflow" directive, or the ' +
  "Workflow DevKit bundler plugin did not run. Declare the body in a module under " +
  '`workflows/`, put `"use workflow";` as its first statement, and make sure the ' +
  "project is built by `aai build`/`aai dev` rather than a bare bundler.";

/**
 * A `WorkflowClient` whose every method rejects with `message`.
 *
 * One factory rather than a literal per site, because the literal wants writing
 * three times (the tool executor's stub, the host test helper's, and
 * `@alexkroman1/aai/testing`'s) and adding a method to the client would break all
 * three at once while each looked complete on its own.
 *
 * The message is the caller's because the cases want different ones: the
 * runtime's names the missing configuration, a test's names the missing stub.
 *
 * @internal
 */
export function rejectingWorkflows(message: string): WorkflowClient {
  // One rejector shared by every method: they differ only in return type, and
  // `never` satisfies all of them.
  const reject = (): Promise<never> => Promise.reject(new Error(message));
  // `listing` cannot reject — it is synchronous — and an empty list is the
  // truthful answer for every case this factory covers.
  return {
    start: reject,
    get: reject,
    find: reject,
    recent: reject,
    cancel: reject,
    wakeUp: reject,
    signal: reject,
    stream: reject,
    streamTail: reject,
    listing: () => [],
  };
}
