// Copyright 2026 the AAI authors. MIT license.
/**
 * One door for a queue message the PLATFORM delivered, and the reason it is not
 * the two routes the DevKit's own queue uses.
 *
 * `/.well-known/workflow/v1/{flow,step}` are the queue callbacks, and they are
 * refused from any peer that is not loopback (`handleWorkflowRequest`) — the
 * gate that closed an unauthenticated hole on every deployed agent's public
 * tunnel. A platform-owned queue lives OUTSIDE the container, so it needs a way
 * in, and there were two shapes available:
 *
 * - Widen the flow/step gate to also accept the platform's bearer. The platform
 *   then has to decide which of the two a message is, which means the DevKit's
 *   queue-name grammar has to be reimplemented in `aai-server` — a third-party
 *   grammar duplicated across a package boundary, on the side that does not
 *   depend on the DevKit and so cannot notice when it changes.
 * - One door the platform POSTs every message to, which dispatches by that
 *   grammar HERE, where the DevKit is a declared dependency and moves with it.
 *
 * This is the second. The platform's delivery is then a dumb forward — body,
 * three headers, a bearer — and the two loopback-only routes keep the gate they
 * have. The classification is the only thing that has to be right, and it fails
 * LOUDLY (400, naming the queue name) rather than guessing a route.
 *
 * ## It is `host-only`, and refused by default
 *
 * `GUEST_ROUTE_EXPOSURE.workflowQueue` declares it `host-only`: the platform
 * dials it over the sandbox tunnel with this sandbox's manage bearer, and no
 * client ever does. Authentication is INJECTED (`allowRemote`), because this
 * package is also what a self-hoster runs and the platform credential is not its
 * business. A composition that supplies no predicate refuses the route outright
 * — which is correct for `aai dev`, host mode and a self-hosted server, none of
 * which have a platform-owned queue.
 */

import type { WorkflowSurface } from "./workflow-serve.ts";

/**
 * The platform's delivery door.
 *
 * Deliberately NOT under `/.well-known/workflow/v1/` — that prefix is the
 * DevKit's own namespace and a future version of it may add routes there; this
 * one is ours. It is also not under `/workflows`, which is the run API a caller
 * uses (`WORKFLOW_API_PREFIX`), and whose gate answers a different question.
 *
 * @internal
 */
export const WORKFLOW_QUEUE_PATH = "/workflow-queue";

/**
 * The header the DevKit's queue puts the queue name in, and the only thing that
 * says whether a message is a run replay or one step.
 *
 * The three `x-vqs-*` headers are the queue↔executor contract
 * (`executeMessageOverHttp` in `@workflow/world-postgres`); a platform-owned
 * queue reproduces them, and this is the one that decides routing.
 *
 * @internal
 */
export const QUEUE_NAME_HEADER = "x-vqs-queue-name";

/**
 * Which handler a queue name belongs to, or undefined when it is not one.
 *
 * The grammar is the DevKit's — `__[<namespace>_]wkf_(workflow|step)_<id>`, from
 * `parseQueueName` in `@workflow/world`. It is matched here rather than imported
 * because `@workflow/world` is a transitive dependency this package does not
 * declare and `workflow` does not re-export it; the shape is one line, and the
 * cost of it drifting is bounded by the caller answering 400 rather than picking
 * a route.
 *
 * @internal
 */
export function queueNameKind(queueName: string | null): "workflow" | "step" | undefined {
  if (queueName === null) return;
  const match = /^__(?:[a-z][a-z0-9]*_)?wkf_(workflow|step)_.+$/.exec(queueName);
  // `match[1]` is one of the two alternatives by construction; the cast-free
  // check keeps that true for a reader rather than asserting it.
  if (match?.[1] === "workflow") return "workflow";
  if (match?.[1] === "step") return "step";
}

/**
 * Hand one platform-delivered message to the handler its queue name names.
 *
 * The `Request` is forwarded whole rather than rebuilt: the body is the DevKit's
 * own opaque payload and the `x-vqs-*` headers are what the entrypoint reads, so
 * anything this function reconstructed would be a second place for that contract
 * to be wrong. Only the URL changes, to the path the handler expects.
 *
 * @internal
 */
export async function dispatchQueueMessage(
  surface: WorkflowSurface,
  request: Request,
): Promise<Response> {
  const queueName = request.headers.get(QUEUE_NAME_HEADER);
  const kind = queueNameKind(queueName);
  if (kind === undefined) {
    // 400, not 500: the queue sent something this guest cannot route, and the
    // platform must not retry it into the abandonment budget as if the guest
    // were down. Naming the value is the whole diagnostic — a DevKit that
    // changed its grammar looks exactly like a corrupt header otherwise.
    return Response.json(
      { error: `unroutable queue name: ${queueName ?? "(absent)"}` },
      { status: 400 },
    );
  }
  // The request goes through UNCHANGED, URL included. A DevKit entrypoint routes
  // on the payload and the `x-vqs-*` headers, never on the path — which is the
  // same fact `toFetchRequest` records when it invents `http://guest.local` for
  // a `Request` that requires an absolute URL and does nothing with it. So
  // rewriting the URL to the flow/step path would look tidier, add an
  // ALLOCATION and a second copy of the routing contract, and change nothing.
  //
  // It also keeps this module's only import type-only, which is what stops it
  // and `workflow-serve.ts` forming a cycle.
  return kind === "workflow" ? surface.flow(request) : surface.step(request);
}
