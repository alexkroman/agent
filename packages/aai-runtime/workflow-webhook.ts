// Copyright 2026 the AAI authors. MIT license.
/**
 * The webhook route — `/.well-known/workflow/v1/webhook/:token`.
 *
 * This is the one workflow URL that LEAVES the system. `createHook({ token })`
 * mints it through `ctx.workflows.publicWebhookUrl(token)`, an author mails it
 * to a payment provider or an approver, and it has to still work weeks later —
 * after the sandbox that minted it has self-exited, and on whichever container
 * the delivery happens to reach.
 *
 * ## It answers from the JOURNAL, not from a hook table in memory
 *
 * It used to wrap the DevKit's `resumeWebhook`, which resolved a token against
 * the World's own hook table. That is gone with the DevKit: a token now names a
 * row, `WorkflowClient.signal` writes the payload against it and re-delivers the
 * run, and the answer is a BOOLEAN rather than a thrown `HookNotFoundError`.
 *
 * That collapses the module. What used to be here was an error CLASSIFICATION —
 * catching one exception class and translating it to a 404 — and the reason it
 * needed defending in prose was that the DevKit signalled an ordinary outcome by
 * throwing. `signal` returning `false` says the same thing without the
 * translation, so what is left is the HTTP shape.
 *
 * ## Why a miss is 404 and not 500
 *
 * A token nothing is listening on is an ANSWER, not a fault, and the caller is a
 * third party on the public internet with a retry loop. A 5xx tells that loop to
 * come back, so an expired callback was retried against a 500 forever. 404 tells
 * it to stop, and it is STABLE: a hook that is closed does not reopen.
 *
 * This is also why the route cannot share `serveFetch`'s catch, which answers
 * 500 and is right to for the queue's own callbacks — those the world retries on
 * purpose.
 *
 * ## The body is read as bytes and handed over as JSON when it parses
 *
 * A hook's payload is whatever the far side sends and we do not own its schema,
 * so a body that is not JSON is delivered as a STRING rather than refused: the
 * run's own `hook.payload` is where a schema belongs, and refusing here would
 * answer 400 to a provider whose content type we merely failed to anticipate.
 * An empty body delivers `undefined`, which is what a bare ping is.
 *
 * @internal
 */

import { decodePathSegment } from "./_path-decode.ts";
import type { Logger } from "./runtime-config.ts";
import { WORKFLOW_WEBHOOK_PREFIX } from "./workflow-serve.ts";

/**
 * The token from a webhook path, or undefined when the path is not one.
 *
 * A webhook URL is handed OUT of the system, so the token is the only thing
 * identifying the run, and an empty trailing segment must not read as a valid
 * one.
 *
 * **A segment that will not decode is "not a webhook path" too**, and that is
 * the load-bearing part: this call is synchronous and `createServer` invokes it
 * from the request path with no `try`, so a `URIError` from a raw `%` here
 * reached the guest's `uncaughtException` guard and exited the process — from
 * an unauthenticated `GET`. See `_path-decode.ts`.
 *
 * @internal
 */
export function webhookToken(pathname: string): string | undefined {
  if (!pathname.startsWith(WORKFLOW_WEBHOOK_PREFIX)) return;
  const token = pathname.slice(WORKFLOW_WEBHOOK_PREFIX.length);
  // A token with a slash in it is not one: the route is a single segment, and
  // accepting more would let `…/webhook/a/b` arrive as the token "a/b".
  if (token === "" || token.includes("/")) return;
  return decodePathSegment(token);
}

/** Just enough of `WorkflowClient` to deliver one webhook. */
export type WebhookTarget = {
  signal(token: string, payload?: unknown): Promise<boolean>;
};

/** The body cap. A webhook payload is a notification, never a file. */
export const MAX_WEBHOOK_BODY_BYTES = 1024 * 1024;

/** A JSON response with no cache. */
function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * Read a request body as a payload to deliver.
 *
 * Bounded before it is buffered: the route is public and reachable without a
 * credential, the token being the whole authorization (which is what the DevKit
 * documented too, and what the platform's proxy in front of this assumes).
 */
async function readPayload(req: Request): Promise<unknown> {
  const raw = await req.text();
  if (raw.length === 0) return undefined;
  if (raw.length > MAX_WEBHOOK_BODY_BYTES) {
    throw new Error(`webhook body exceeds ${MAX_WEBHOOK_BODY_BYTES} bytes`);
  }
  try {
    return JSON.parse(raw);
  } catch {
    // Not JSON is not an error — see the module doc.
    return raw;
  }
}

/**
 * Build the webhook handler over a LAZY client resolver.
 *
 * Lazy for the reason `createWorkflowApi`'s `engine` getter is: the guest builds
 * its runtime on the first thing that needs it, so capturing the client at mount
 * time captures `undefined` for the life of the server.
 *
 * @internal
 */
export function createWebhookHandler(
  resolveClient: () => WebhookTarget | undefined,
  logger: Logger,
): (token: string, req: Request) => Promise<Response> {
  return async (token: string, req: Request): Promise<Response> => {
    // An agent that declares no workflows has no hook to deliver to, and saying
    // so as a 404 is the same answer an unknown token gets — correctly, since a
    // third party cannot tell the two apart and must stop either way.
    const client = resolveClient();
    if (!client) return json(404, { error: "No workflow hook for this token" });

    let payload: unknown;
    try {
      payload = await readPayload(req);
    } catch (err: unknown) {
      return json(413, { error: err instanceof Error ? err.message : String(err) });
    }

    const delivered = await client.signal(token, payload);
    if (!delivered) {
      // Logged because this is the one failure an author debugs from the outside
      // — the provider reports a 404 and nothing else in the system mentions it.
      // The TOKEN is not logged: it is the credential.
      logger.info?.("Workflow webhook delivered to no open hook");
      return json(404, { error: "No workflow hook for this token" });
    }
    return json(200, { ok: true });
  };
}
