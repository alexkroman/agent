// Copyright 2026 the AAI authors. MIT license.
/**
 * The webhook route's one error classification.
 *
 * Its own module because `workflow-serve.ts` is at the repo's 500-line cap and
 * this is the leaf the file's own seam suggests: it names no route, imports no
 * DevKit, and its whole content is deciding what ONE failure means.
 *
 * @internal
 */

import type { WorkflowSurface } from "./workflow-serve.ts";

/**
 * Wrap the DevKit's `resumeWebhook` so a token nothing is listening on answers
 * 404 rather than reaching {@link serveFetch}'s catch as a 500.
 *
 * A token nothing is listening on is an ANSWER, not a fault — the same
 * translation `WdkAdapter.signal` already makes for this exact error class
 * ("the run moved past its hook, finished, or was never started"), and the
 * DevKit's own `resumeHook` doc example answers it `404` too.
 *
 * **It cannot be made in {@link serveFetch}**, whose catch is shared with `flow`
 * and `step` and whose 500 is deliberate for them: those two are the queue's OWN
 * callbacks, and the world retries a 5xx, which is how a transient fault gets
 * another attempt. This route's caller is a third party on the public internet —
 * a payment provider, an approval mail — and for them a 5xx also means "retry",
 * so an expired callback was retried against a 500 indefinitely. 404 is what
 * tells them to stop, and it is a STABLE answer: a hook that is gone does not
 * come back.
 *
 * Its own function, and the predicate injected, because that classification is
 * the whole content of it and is untestable inside `createWorkflowSurface` —
 * reaching that closure means loading the DevKit and resolving a World. Same
 * split, for the same reason, as `pinnedLookup` out of `pinnedDispatcher`.
 *
 * @internal
 */
export function createWebhookHandler(
  resume: (token: string, req: Request) => Promise<Response>,
  isHookNotFound: (err: unknown) => boolean,
): WorkflowSurface["webhook"] {
  return async (token: string, req: Request): Promise<Response> => {
    try {
      return await resume(token, req);
    } catch (err: unknown) {
      if (!isHookNotFound(err)) throw err;
      return new Response(JSON.stringify({ error: "No workflow hook for this token" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      });
    }
  };
}
