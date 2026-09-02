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
 * What `ctx.workflows` rejects with when the app declares no workflows.
 *
 * ONE cause, and it used to claim two. The second half said to "make sure storage
 * is enabled (`aai storage enable`, or Settings → Database in the studio) so runs
 * have somewhere to live", and it was wrong on both counts:
 *
 * - **Storage was never a reason.** `buildWorkflowClient` returns `undefined`
 *   only for an empty `workflows` — a missing database changes which KEY STORE is
 *   used, not whether the client exists, and that module's doc says so outright
 *   ("A missing database is therefore NOT a reason to withhold the client"). So
 *   the advice sent an author to configure something that would not have fixed it.
 * - **The command is gone**, with per-app databases. Runs live on the platform's
 *   own database now, reached over HTTP, so a deployed app never lacks somewhere
 *   to keep them.
 *
 * Naming one cause is the whole improvement: a message listing two makes the
 * reader check both, and the one they cannot rule out is the one that was never
 * true.
 *
 * @internal
 */
export const WORKFLOWS_UNAVAILABLE_MESSAGE =
  "Workflows are not available for this app: it declares none. Add them with " +
  "`agent({ workflows })`, with each body an exported async function in a module " +
  "under `workflows/` taking `(input, ctx)`.";

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
  //
  // `publicWebhookUrl` is synchronous TOO and gets the opposite treatment,
  // because there is no truthful empty answer: a URL is either the one a third
  // party can reach or it is a lie, so it throws the same message the async
  // methods reject with.
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
    lastLine: reject,
    publicWebhookUrl: () => {
      throw new Error(message);
    },
    listing: () => [],
  };
}

/**
 * What `publicWebhookUrl` throws when the deployment never told the SDK its own
 * public URL.
 *
 * One message for both halves of the same configuration, because a tool author
 * cannot tell them apart and the fix is one line either way: `publicUrl` on
 * `createAgentServer`/`createRuntime` for a self-hosted server (which
 * `server.mjs` reads from `PUBLIC_URL`), and `AAI_PUBLIC_ORIGIN` on the platform
 * — the only thing that makes the brokered origin deterministic when a replica
 * has served no request yet.
 *
 * @internal
 */
export const PUBLIC_URL_UNCONFIGURED_MESSAGE =
  "This agent does not know its own public URL, so a webhook URL cannot be minted. " +
  "Set `publicUrl` on createAgentServer/createRuntime (server.mjs reads PUBLIC_URL), " +
  "or set AAI_PUBLIC_ORIGIN on the platform.";
