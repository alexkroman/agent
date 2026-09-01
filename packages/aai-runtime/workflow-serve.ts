// Copyright 2026 the AAI authors. MIT license.
/**
 * Durable workflows inside the guest: loading the compiled surface out of the
 * bundle and serving the three routes the Workflow DevKit's queue calls back on.
 *
 * The agent's workflows arrive as DATA — two strings on the bundle
 * (`__aaiWorkflowCode`, `__aaiStepCode`), compiled per tenant by the CLI at
 * deploy time. They cannot be compiled here: this image is baked once and serves
 * every tenant, so there is no `workflows/` directory in existence when it is
 * built. See `aai-cli/workflow-bundler.ts` for the other half.
 *
 * ## Both halves are ROUTE MODULES, and neither is raw workflow code
 *
 * This is the thing to know before changing anything here, because the naming
 * suggests otherwise and the failure is late and unhelpful. What
 * `createWorkflowsBundle`/`createStepsBundle` emit is what the DevKit's own
 * framework integrations mount as HTTP handlers: an ESM module exporting
 * `POST`. The flow module holds the real workflow bundle as a STRING and calls
 * `workflowEntrypoint(...)` on it itself; the step module ends in
 * `export { stepEntrypoint as POST }` above its `registerStepFunction(...)`
 * calls.
 *
 * So both are imported and both contribute their `POST`, and calling
 * `workflowEntrypoint(workflowCode)` here is a DOUBLE WRAP: the route module's
 * own source goes into the `node:vm` `Script` that expects the inner bundle,
 * and every run fails at replay with `SyntaxError: Cannot use import statement
 * outside a module` pointing at a line of generated code. `bundleFinalOutput:
 * false` does not change this — it means "do not bundle the route module's
 * imports", not "do not emit one".
 *
 * ## Why they cannot just go in /tmp
 *
 * `harness-bundle.ts` writes the worker bundle to `/tmp/aai-bundle-*.mjs` and
 * imports it by file URL, which works because that bundle is FULLY INLINED —
 * `ssr.noExternal: true`, so it imports nothing but `node:` builtins.
 *
 * These two are the opposite by design: the DevKit is left external so the
 * artifacts stay ~69 KB and ~7 KB instead of 3.7 MB and 12 MB (they resolve from
 * this image instead). So they carry real bare imports — and a module at
 * `/tmp/x.mjs` resolves those against `/tmp/node_modules` and `/node_modules`,
 * neither of which exists. The failure is `ERR_MODULE_NOT_FOUND` on `workflow`,
 * from a path that looks nothing like the guest.
 *
 * Rewriting the specifiers to absolute URLs is the fix that does not depend on
 * where the file lands or on the image's directory layout — the alternative,
 * writing next to the harness so Node's walk-up finds its `node_modules`, bets
 * on a writable install directory that nothing else here needs.
 */

import { rm, writeFile } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { consoleLogger, type Logger } from "./runtime-config.ts";
import { type FetchHandler, serveFetch } from "./workflow-http-adapter.ts";
import {
  deliverQueueMessage,
  dispatchQueueMessage,
  WORKFLOW_QUEUE_PATH,
} from "./workflow-queue-dispatch.ts";
import { resolveImportSpecifier } from "./workflow-resolve.ts";

/** Distinct temp file per load — Node's module registry caches by URL. */
let moduleSeq = 0;

/**
 * Bare specifiers the step bundle may import, rewritten to this image's copies.
 *
 * Deliberately a fixed list rather than "every bare specifier": the agent's own
 * dependencies are BUNDLED into the step artifact, so anything still bare is the
 * DevKit, which the builder externalized on purpose. Rewriting an unknown
 * specifier would paper over a bundling bug that should surface as a missing
 * module instead.
 */
const REWRITABLE = /^(workflow(\/[\w./-]+)?|@workflow\/[\w./-]+)$/;

/**
 * Rewrite the step bundle's external imports to absolute file URLs.
 *
 * Matches only the specifier position of a static `import … from "x"` /
 * `export … from "x"`, so a matching string anywhere in the agent's own code is
 * left alone.
 *
 * A specifier this image cannot resolve is left AS IS rather than dropped: it
 * then fails at import with Node's own error naming the module, which is a far
 * better report than a silently rewritten path that resolves to nothing.
 *
 * @internal
 */
export function rewriteWorkflowImports(code: string): string {
  return code.replace(
    /(\bfrom\s*|\bimport\s*)(["'])([^"']+)\2/g,
    (whole, prefix: string, quote: string, specifier: string) => {
      if (!REWRITABLE.test(specifier)) return whole;
      // One helper for the whole class — see `workflow-resolve.ts`. It keeps the
      // import/require distinction in one place rather than at each call site,
      // which is where it was got wrong before.
      const resolved = resolveImportSpecifier(specifier);
      return resolved === undefined ? whole : `${prefix}${quote}${resolved}${quote}`;
    },
  );
}

/**
 * Write one of the builder's route modules to a temp file and import it.
 *
 * Both modules matter for their side effects as well as their exports — the
 * step module's top-level `registerStepFunction(...)` calls are what make a step
 * id dispatchable — so this always evaluates, and the caller decides what to
 * read off the result.
 *
 * @internal
 */
export async function loadWorkflowModule(
  code: string,
  label: string,
): Promise<Record<string, unknown>> {
  // `tmpdir()`, not a literal `/tmp`: on Windows that string is drive-relative
  // and resolves to `D:\tmp`, which does not exist — every workflow load failed
  // with ENOENT there. The DIRECTORY is not load-bearing (see "Why they cannot
  // just go in /tmp" above: it is the specifier rewriting that makes the
  // location irrelevant, and `tmpdir()` has no `node_modules` either), so this
  // preserves the reasoning rather than working around it.
  const file = join(tmpdir(), `aai-${label}-${process.pid}-${++moduleSeq}.mjs`);
  await writeFile(file, rewriteWorkflowImports(code), "utf-8");
  try {
    return (await import(pathToFileURL(file).href)) as Record<string, unknown>;
  } finally {
    // Deleted once it is IN the module registry, which is keyed by URL and holds
    // the evaluated module — nothing re-reads the file, and `moduleSeq` exists
    // precisely so a later load cannot want this URL back. Without this, every
    // `createWorkflowSurface` left two files behind: two per `aai dev` save, and
    // in a long studio build→load loop that is the tmpdir filling up with dead
    // bundles nothing ever collects. Best effort — a failed unlink is a stale
    // temp file, not a failed load.
    await rm(file, { force: true }).catch(() => undefined);
  }
}

/** The `POST` export a builder route module owes, or a failure naming which one. */
function routeHandler(mod: Record<string, unknown>, label: string): FetchHandler {
  const post = mod.POST;
  if (typeof post !== "function") {
    // Reachable only if the builder's output shape changes, which is exactly
    // when a bare `undefined is not a function` three layers down would cost
    // the most to diagnose.
    throw new Error(`Workflow ${label} bundle exported no POST handler`);
  }
  return post as FetchHandler;
}

/**
 * The three paths the DevKit's queue calls back on.
 *
 * @internal
 */
export const WORKFLOW_FLOW_PATH = "/.well-known/workflow/v1/flow";
/** @internal */
export const WORKFLOW_STEP_PATH = "/.well-known/workflow/v1/step";
/** @internal */
/**
 * The webhook ROUTE, and the prefix `webhookToken` slices a token off after it.
 *
 * Two names because the platform must register the slash-less path plus a token
 * segment while the parser needs the trailing slash — derived from one another
 * so the two cannot drift, which they did while `aai-server` spelled the
 * slash-less form as its own literal. See `server-routes.ts`.
 *
 * @internal
 */
export const WORKFLOW_WEBHOOK_PATH = "/.well-known/workflow/v1/webhook";
/** @internal */
export const WORKFLOW_WEBHOOK_PREFIX = `${WORKFLOW_WEBHOOK_PATH}/` as const;

/**
 * Is this one of the two QUEUE CALLBACKS — the routes only the guest's own
 * queue may call?
 *
 * The webhook route deliberately is not one: its URL is handed to a third party
 * and has to work from the public internet, which is why the platform proxies
 * it and the DevKit's token in the path is its whole authorization.
 */
function isQueueCallbackPath(url: string): boolean {
  return url === WORKFLOW_FLOW_PATH || url === WORKFLOW_STEP_PATH;
}

/**
 * Is `address` a loopback peer — i.e. did this request originate INSIDE this
 * container?
 *
 * `undefined` is false, and that direction is deliberate: a socket with no peer
 * address is a socket whose position cannot be established, and the one thing
 * this predicate must never do is answer "internal" because it could not tell.
 *
 * Three spellings, all of which a real server produces: `127.0.0.0/8` (the
 * whole block, not just `127.0.0.1` — `localhost` resolves elsewhere in it on
 * some hosts), `::1`, and the IPv4-MAPPED form a dual-stack listener reports
 * for an IPv4 loopback dial. Missing the third would refuse the guest's own
 * queue on any host that binds `::`.
 *
 * @internal
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const bare = address.startsWith("::ffff:") ? address.slice("::ffff:".length) : address;
  if (bare === "::1") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/**
 * The workflow surface one loaded bundle exposes.
 *
 * @internal
 */
export type WorkflowSurface = {
  /** `POST /.well-known/workflow/v1/flow` — replays a run. */
  flow: FetchHandler;
  /** `POST /.well-known/workflow/v1/step` — executes one step. */
  step: FetchHandler;
};

/**
 * Build the workflow surface for a loaded bundle, or `undefined` when the agent
 * declares none.
 *
 * Takes the two code strings rather than the bundle so the caller decides what
 * "has workflows" means — the CLI omits both exports entirely for a project with
 * no `workflows/` directory, and an agent with no workflow surface must mount no
 * routes rather than mount ones that answer 500.
 *
 * @internal
 */
export async function createWorkflowSurface(
  workflowCode: string | undefined,
  stepCode: string | undefined,
): Promise<WorkflowSurface | undefined> {
  if (!(workflowCode && stepCode)) return;

  // Imported lazily, like the two route modules below: `workflow/api` resolves a
  // World from the environment as it loads, and a guest serving an agent with no
  // workflows must not pay that — nor fail on it when no world is configured.
  // `workflow/errors` rides along in the same lazy step so the webhook route can
  // classify its one expected failure without this module importing the DevKit
  // eagerly — see `workflow-wdk.ts`'s module doc for why that matters.
  // Steps first: a flow replay can dispatch a step immediately, and an
  // unregistered step id is a hard failure rather than a retry.
  const steps = await loadWorkflowModule(stepCode, "steps");
  const flows = await loadWorkflowModule(workflowCode, "flows");

  return {
    flow: routeHandler(flows, "flow"),
    step: routeHandler(steps, "step"),
  };
}

/**
 * Serve the three workflow routes, in the shape `createServer`'s `request` hook
 * wants: `true` when this handler claimed the request.
 *
 * A node↔fetch adapter lives here because every DevKit entrypoint is fetch-style
 * while `createServer` is `node:http`. It is small and it is temporary — once
 * the session server is on Hono (`c.req.raw` is already a `Request`) these
 * handlers mount directly and this function goes away.
 *
 * ## `flow` and `step` are refused from off-box, and they were NOT
 *
 * Both are unauthenticated by design — aai-server's `GUEST_ROUTE_EXPOSURE`
 * declares them `guest-internal` and says so outright: "these two are
 * unauthenticated precisely BECAUSE loopback is the whole gate", and
 * `aai-guest/harness-workflow-gate.ts` said they were "loopback-gated". Nothing
 * checked. A deployed agent guest binds `0.0.0.0` (Modal publishes the port as a
 * public HTTPS tunnel) and the PUBLIC `GET /:slug/client-config` hands that
 * tunnel origin to every browser that asks — so on any deployed agent with
 * workflows, `POST <tunnel>/.well-known/workflow/v1/step` executed one of that
 * tenant's registered step functions, with the caller's arguments, for anyone on
 * the internet: their tools, their `ctx.db`, their provider spend. `flow` beside
 * it starts and replays runs. The exposure table's own reasoning was sound; the
 * gate it assumed did not exist, which is the failure mode of a security
 * property held as a comment.
 *
 * A SECRET would be the stronger gate and is not reachable: the caller is the
 * DevKit's own queue, which builds this URL from `WORKFLOW_LOCAL_BASE_URL` and
 * offers no header hook — and undici refuses to construct a `Request` from a URL
 * carrying credentials ("Request cannot be constructed from a URL that includes
 * credentials"), so smuggling one through the base URL breaks the queue outright
 * rather than authenticating it. Network position is what is left, and it is
 * sound for the reason `harness.ts` binds every interface in the first place:
 * tunnel traffic arrives from OUTSIDE the sandbox's network namespace, so it is
 * never a loopback peer. In-container callers are inside the security boundary
 * already — the Modal container is that boundary.
 *
 * It is here, in the module that SERVES the routes, rather than in the deployed
 * guest's request hook beside `gateDirectWorkflowDial`: `aai dev`, host mode,
 * studio mode and a self-hosted `createAgentServer` all reach these two through
 * this function, and a self-hoster who binds `0.0.0.0` has exactly the same hole.
 *
 * The one thing this closes off is a queue running somewhere other than in this
 * process, and that is correct rather than incidental: such a queue needs its own
 * authenticated door — an authenticity check AND a route — not a hole where one
 * should be.
 *
 * @internal
 */
export function handleWorkflowRequest(
  // `null` as well as `undefined`: `HarnessState` uses null for "loaded, has
  // none" (matching its other slots) while `createWorkflowSurface` returns
  // undefined, and making the caller normalize is a conversion with no meaning.
  surface: WorkflowSurface | null | undefined,
  req: IncomingMessage,
  res: ServerResponse,
  url: string,
  method: string,
  opts: {
    /**
     * May this off-box caller reach the PLATFORM's delivery door
     * (`WORKFLOW_QUEUE_PATH`)?
     *
     * Injected because the credential is the platform's and this package is also
     * what a self-hoster runs. Absent means the door is refused — which is
     * right for `aai dev`, host mode and a self-hosted server, none of which
     * have a queue outside the process. It does NOT open `flow`/`step`: those
     * stay loopback-only, and the whole point of the door is that they can.
     */
    allowRemote?: ((req: IncomingMessage) => boolean) | undefined;
    /**
     * Where a failed queue callback is reported.
     *
     * Optional with a console fallback because this is the behaviour it
     * replaced, and every caller here is a composition root that already has a
     * logger — a required field would be a breaking change to three doors for a
     * line that only prints on a fault.
     */
    logger?: Logger | undefined;
    /**
     * Re-walk one run, for a delivery arriving on the PLATFORM's door.
     *
     * `AgentRuntime.deliverWorkflow`. This is what the door is FOR under the
     * replay engine: the platform's queue holds a deployed run's schedule,
     * because that guest's own timers die with a sandbox that self-exits, and a
     * due message boots it and lands here.
     *
     * Optional, and its absence is what a self-hosted server looks like — there
     * the dispatcher is a `setTimeout` in the same process and no delivery ever
     * arrives from outside.
     */
    deliver?: ((runId: string) => Promise<unknown>) | undefined;
  } = {},
): boolean {
  // The PLATFORM's door is served off `deliver` alone, so an agent with no DevKit
  // surface still receives its deliveries — which after the engine replaced the
  // DevKit is every agent. The two queue CALLBACKS below still need a surface,
  // being the DevKit's own.
  if (!(surface || opts.deliver)) return false;

  // The two queue callbacks are GUEST-INTERNAL, and this is what makes that
  // true rather than merely intended. See the block comment above.
  if (isQueueCallbackPath(url) && !isLoopbackAddress(req.socket?.remoteAddress)) {
    res.writeHead(403, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "workflow queue callbacks are guest-internal" }));
    return true;
  }

  // The platform's door, and it is HOST-ONLY: a caller the composition does not
  // vouch for is refused even on loopback. Fails closed when no predicate was
  // supplied, which is every composition that has no platform.
  if (url === WORKFLOW_QUEUE_PATH && !opts.allowRemote?.(req)) {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "unauthorized" }));
    return true;
  }

  const handler = pickWorkflowHandler(surface, url, method, opts.deliver);
  if (!handler) return false;

  void serveFetch(handler, req, res, {
    logger: opts.logger ?? consoleLogger,
    label: "Workflow route",
    // A queue callback: the world RETRIES a 5xx, which is how a transient fault
    // gets another attempt.
    failureStatus: 500,
  });
  return true;
}

/**
 * Which handler serves this request, if any.
 *
 * Only POST reaches flow and step — they are queue callbacks, not a browsable
 * surface — while a webhook takes whatever verb the far side sends, because the
 * URL was handed to a third party that chooses its own.
 */
function pickWorkflowHandler(
  surface: WorkflowSurface | null | undefined,
  url: string,
  method: string,
  deliver: ((runId: string) => Promise<unknown>) | undefined,
): FetchHandler | undefined {
  if (method !== "POST") return;
  // The platform's delivery door. Its gate has already run in
  // `handleWorkflowRequest`.
  //
  // `deliver` FIRST, because it is the engine's path and the surface's is the
  // DevKit's: an agent that has both should re-walk its own journal rather than
  // hand the message to a queue callback that would replay a body the engine
  // already owns.
  if (url === WORKFLOW_QUEUE_PATH) {
    if (deliver) return (request: Request) => deliverQueueMessage(deliver, request);
    return surface ? (request: Request) => dispatchQueueMessage(surface, request) : undefined;
  }
  if (!surface) return;
  if (url === WORKFLOW_FLOW_PATH) return surface.flow;
  if (url === WORKFLOW_STEP_PATH) return surface.step;
}
