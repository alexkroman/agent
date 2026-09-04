// Copyright 2026 the AAI authors. MIT license.
// What the Docs pane says, as data and pure builders — the pane itself only
// renders it.
//
// Split from `docs.tsx` for the reason every extracted-logic module in this
// package is: a pane is browser-shaped and its assertions have to go through a
// render, while the interesting part here is a pure function of a JSON Schema.
// The snippet builders are also the half most likely to be WRONG in a way a
// screenshot cannot show — a request body with the field spelled differently
// than the workflow declared it looks perfect and 400s — so they are worth
// testing directly.
//
// **Nothing here is hand-maintained prose about a specific project.** The
// endpoint tables are the platform's, and every request body is derived from
// the agent's own `GET /workflows` listing, which serves each workflow's input
// schema (`WorkflowSummary.inputSchema`). That is what makes this pane current
// by construction rather than documentation somebody has to remember to update:
// a workflow that gains a field gains it here on the next read.

import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/internal";
import { CLIENT_CONFIG_PATH } from "@alexkroman1/aai/protocol";
import { isRecord } from "@alexkroman1/aai/utils";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";

/**
 * The workflow API's root path under an agent, with no leading slash.
 *
 * Exported because the `curl` builders next door spell the same paths, and a
 * second literal there is how one of the two comes to name a prefix the
 * platform no longer routes.
 */
export const WORKFLOWS_PATH = WORKFLOW_API_PREFIX.replace(/^\//, "");

/**
 * The upload routes' root, with no leading slash.
 *
 * Derived from {@link WORKFLOWS_PATH} rather than spelled, for the reason that
 * one is derived from the SDK constant: the route table, the SDK snippets and
 * the shell snippets all name this path, and three literals is how one of them
 * comes to name a prefix the platform no longer routes.
 */
export const UPLOADS_PATH = `${WORKFLOWS_PATH}/uploads`;

/** Methods the documented routes use. Mirrors the platform's own registrations. */
export type DocMethod = "GET" | "POST" | "PUT" | "DELETE";

/** One documented route, relative to an agent's base URL. */
export type DocEndpoint = {
  method: DocMethod;
  /** Path under the agent base — no leading slash, `:param` for a segment. */
  path: string;
  summary: string;
  /**
   * The SDK call that makes this request, as a reader would write it.
   *
   * Present on every route a client HAS a call for, which is what turns the
   * table from a list of URLs into an index into the client every example on the
   * page uses. Absent for the two that are nobody's method to call — the page
   * itself, which a browser fetches, and the carrier webhook, which a phone
   * company posts to.
   */
  sdk?: string;
};

/**
 * The front door EVERY agent has, whichever shape it is: the page it serves and
 * the config that says what that page is.
 *
 * `client-config` names its own path from the SDK constant every server that
 * serves it also uses, so a rename cannot leave this table behind.
 */
export const PAGE_ENDPOINTS: readonly DocEndpoint[] = [
  { method: "GET", path: "", summary: "The agent's page — the voice client, or a workflow app." },
  {
    method: "GET",
    path: CLIENT_CONFIG_PATH,
    summary:
      "Name, greeting, page kind, and — for a voice agent — the live session's WebSocket URL.",
  },
];

/**
 * What a VOICE agent answers on top of that.
 *
 * Short because it genuinely is: a browser reads `client-config` once and then
 * talks WebSocket, and the socket is not an HTTP route a reader could call by
 * hand — so it is described in the pane's prose rather than listed as a row
 * somebody might try to `curl`. That leaves the carrier webhook as the only
 * voice-only ROUTE, which is why this table has one row rather than being
 * folded into the one above.
 */
export const VOICE_ENDPOINTS: readonly DocEndpoint[] = [
  {
    method: "POST",
    path: "phone",
    summary: "Carrier webhook — answers with the media-stream document for the call.",
  },
];

/**
 * The routes to document for one agent's front door, given what the agent says
 * it IS (`ClientConfigResponse.page`, absent reading as `"voice"`).
 *
 * **A workflow app is not offered the carrier webhook.** `page: "static"`
 * declines `/websocket` with a reason and cannot declare a carrier at all (see
 * `AgentDef.page`), so a phone number pointed at one answers and hangs up —
 * documenting the route would be an invitation to spend an afternoon in a
 * carrier console over a call that cannot connect. The page and its config
 * stay: they are how a caller discovers the shape in the first place.
 */
export function frontDoorEndpoints(page: "voice" | "static"): readonly DocEndpoint[] {
  return page === "static" ? PAGE_ENDPOINTS : [...PAGE_ENDPOINTS, ...VOICE_ENDPOINTS];
}

/**
 * The durable-workflow API, in the order a caller meets it: list, start, read,
 * watch, steer, upload.
 *
 * Every row here is a route the PLATFORM proxies under `/:slug` — the same set
 * `GUEST_ROUTE_EXPOSURE` declares for `workflows` in aai-server, including the
 * methods, which is the part that has been got wrong before (a `DELETE` that
 * worked under `aai dev` and 404'd deployed). This table cannot import that one
 * — the studio client may not depend on server code — so the tie is the shared
 * `WORKFLOW_API_PREFIX` and the parity test in aai-server that keeps the
 * platform matching the guest.
 */
export const WORKFLOW_ENDPOINTS: readonly DocEndpoint[] = [
  {
    method: "GET",
    path: WORKFLOWS_PATH,
    summary: "The workflows this agent declares, each with its input schema.",
    sdk: "agent.list()",
  },
  {
    method: "POST",
    path: `${WORKFLOWS_PATH}/runs`,
    summary: "Start a run. Body: { workflow, input, key?, wait? } → { runId }.",
    sdk: "agent.start(name, input) / agent.startAndWait(name, input)",
  },
  {
    method: "GET",
    path: `${WORKFLOWS_PATH}/runs`,
    summary: "Recent runs. Query: workflow, key?, limit?.",
    sdk: "agent.recent(name) / agent.find(name, key)",
  },
  {
    method: "GET",
    path: `${WORKFLOWS_PATH}/runs/:runId`,
    summary: "One run's snapshot. `?wait=ms` holds the request open until it settles.",
    sdk: "agent.get(runId, { wait })",
  },
  {
    method: "GET",
    path: `${WORKFLOWS_PATH}/runs/:runId/events`,
    summary: "Server-sent events for one run's progress.",
    sdk: "agent.follow(runId) — an async iterable of snapshots",
  },
  {
    method: "GET",
    path: `${WORKFLOWS_PATH}/runs/:runId/stream`,
    summary: "Server-sent events carrying the run's streamed output.",
    sdk: "agent.followOutput(runId) — an async iterable of chunks",
  },
  {
    method: "POST",
    path: `${WORKFLOWS_PATH}/runs/:runId/wake`,
    summary: "Deliver a wake to a parked run.",
    sdk: "agent.wake(runId)",
  },
  {
    method: "DELETE",
    path: `${WORKFLOWS_PATH}/runs/:runId`,
    summary: "Cancel a run.",
    sdk: "agent.cancel(runId)",
  },
  {
    method: "POST",
    // The body is the FILE, raw: the name rides in `?name=` and the type in
    // `Content-Type`. Said here because it is the one row on this table a reader
    // would otherwise assume is JSON like every other POST above it.
    path: `${UPLOADS_PATH}?name=`,
    summary: "Send a file — body is the raw bytes. Answers with the id a run input carries.",
    sdk: "agent.upload(file)",
  },
  {
    method: "PUT",
    path: `${UPLOADS_PATH}/:id?name=`,
    summary: "Send a file under an id YOU chose, so a run can start before the bytes are in.",
    sdk: "agent.uploadStream(id, file)",
  },
  {
    method: "POST",
    path: `${UPLOADS_PATH}/:id/parts`,
    summary: "Begin a parallel, resumable upload; PUT each window to the same path.",
    sdk: "agent.upload(file, { parallel: true }) — the default",
  },
  {
    method: "GET",
    path: `${UPLOADS_PATH}/:id/info`,
    summary: "How much of an upload landed.",
    sdk: "agent.uploadInfo(id)",
  },
];

/**
 * An agent's base URL — the prefix every documented path hangs off.
 *
 * No trailing slash, because every caller here appends one and `//workflows`
 * is a 404 on a platform that routes `/:slug/workflows`.
 */
export function agentBase(origin: string, slug: string): string {
  return `${origin}/${slug}`;
}

/**
 * What both the API pane and the Workflows card say when an agent declares no
 * workflow, and when the read itself failed.
 *
 * Shared because the two panes answer the same condition about the same agent:
 * held apart, an edit to one leaves the other saying something else. The
 * failure quotes the agent's OWN sentence — a 503 while a sandbox boots and a
 * 404 from an agent that serves no workflow API read very differently, and
 * that text is the whole difference.
 */
export const NO_WORKFLOWS_DECLARED =
  "This project declares no workflows. A voice agent does not need any — they are for work that has to outlive the call that started it.";

/** @see {@link NO_WORKFLOWS_DECLARED} */
export function workflowReadFailure(detail: string): string {
  return `Could not read the workflows: ${detail}`;
}

/** The absolute URL of one documented route. */
export function endpointUrl(base: string, endpoint: DocEndpoint): string {
  return endpoint.path === "" ? `${base}/` : `${base}/${endpoint.path}`;
}

/**
 * How the example value for an UPLOAD-carrying property is written.
 *
 * The two callers need different things from the same schema, and neither is a
 * formatting preference. A shell reader is told what the field takes and where
 * to get one; an SDK reader is shown the call that produces it, so the value has
 * to come out as an EXPRESSION (`recordingUpload.id`) rather than as a string
 * nobody can paste anywhere. See `docs-snippets.ts`.
 */
export type SampleOptions = {
  upload?: (name: string) => unknown;
};

/** What {@link sampleValue} carries down a nested schema. */
type SampleContext = { uploads: readonly string[]; upload: (name: string) => unknown };

/** How deep {@link sampleInput} will follow a nested object before giving up. */
const MAX_SAMPLE_DEPTH = 3;

/**
 * A placeholder value for one property of a workflow's input schema.
 *
 * The property NAME is the placeholder for a string (`"<topic>"`), which is the
 * whole trick: a reader pasting the snippet sees which field they are filling
 * in, where a generic `"string"` reads as a value somebody meant to keep. An
 * `enum` answers with its first member instead — that IS a real value, and a
 * legal one.
 */
function sampleValue(name: string, schema: unknown, ctx: SampleContext, depth: number): unknown {
  if (!isRecord(schema)) return `<${name}>`;
  const { enum: choices } = schema;
  if (Array.isArray(choices) && choices.length > 0) return choices[0];
  if (ctx.uploads.includes(name)) return ctx.upload(name);
  switch (schema.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return depth >= MAX_SAMPLE_DEPTH ? [] : [sampleValue(name, schema.items, ctx, depth + 1)];
    case "object":
      return depth >= MAX_SAMPLE_DEPTH ? {} : sampleObject(schema, ctx, depth + 1);
    default:
      return `<${name}>`;
  }
}

/** Every declared property of an object schema, in declaration order. */
function sampleObject(
  schema: Record<string, unknown>,
  ctx: SampleContext,
  depth: number,
): Record<string, unknown> {
  const { properties } = schema;
  if (!isRecord(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      sampleValue(name, property, ctx, depth),
    ]),
  );
}

/**
 * An example `input` for one workflow, built from the schema it declared.
 *
 * `undefined` for a workflow that declared none — which is a real shape (input
 * is optional), and the snippets then omit the field rather than sending an
 * empty object that reads as a required-but-unknown body.
 */
export function sampleInput(
  workflow: WorkflowSummary,
  options: SampleOptions = {},
): Record<string, unknown> | undefined {
  if (!isRecord(workflow.inputSchema)) return undefined;
  const upload = options.upload ?? ((name: string) => `<upload id for ${name}>`);
  return sampleObject(workflow.inputSchema, { uploads: workflow.uploads ?? [], upload }, 0);
}

/**
 * The `POST /workflows/runs` body for one workflow, example input included.
 *
 * Takes the same {@link SampleOptions} the input sampler does, because the shell
 * snippets need the upload properties to come out as a SHELL EXPANSION rather
 * than as a placeholder string — a `curl` that uploads the file and then starts
 * the run has the id in a variable, and a body carrying `<upload id for x>`
 * beside it would be the one line the reader has to edit by hand.
 */
export function startBody(
  workflow: WorkflowSummary,
  options: SampleOptions = {},
): Record<string, unknown> {
  const input = sampleInput(workflow, options);
  return input === undefined ? { workflow: workflow.name } : { workflow: workflow.name, input };
}

/**
 * The first declared workflow that takes an upload, and the first property of it
 * that does.
 *
 * What the upload card documents ITSELF with: the routes are the same for every
 * agent, but the worked "start the run, then send the bytes" example needs a real
 * workflow name and a real property to put the id in, and inventing one would put
 * a `400` in front of anyone who pasted it. `undefined` for an agent no workflow
 * of which declares an upload, which is what decides whether the card renders at
 * all — the routes exist for every agent, and documenting a file upload to a
 * project with nothing to upload to is a page teaching a call nobody can make.
 */
export function uploadingWorkflow(
  declared: readonly WorkflowSummary[],
): { workflow: WorkflowSummary; property: string } | undefined {
  for (const workflow of declared) {
    const property = workflow.uploads?.[0];
    if (property !== undefined) return { workflow, property };
  }
  return undefined;
}

/** The secret whose presence closes the workflow API. */
export const WORKFLOW_API_TOKEN_SECRET = "AAI_WORKFLOW_API_TOKEN";

// Every snippet on the pane — the SDK calls it defaults to, and the `curl` and
// CLI equivalents behind them — is built in `docs-snippets.ts`. Split when the
// SDK became the default: the tables and the schema sampling here are one
// subject, and five languages' worth of code generation is another.
