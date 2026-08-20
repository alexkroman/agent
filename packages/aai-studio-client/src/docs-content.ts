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

import type { WorkflowSummary } from "@alexkroman1/aai";
import { CLIENT_CONFIG_PATH } from "@alexkroman1/aai/protocol";
import { isRecord } from "@alexkroman1/aai/utils";
import { WORKFLOW_API_PREFIX } from "@alexkroman1/aai/workflow-api";

/** The workflow API's root path under an agent, with no leading slash. */
const WORKFLOWS = WORKFLOW_API_PREFIX.replace(/^\//, "");

/** Methods the documented routes use. Mirrors the platform's own registrations. */
export type DocMethod = "GET" | "POST" | "PUT" | "DELETE";

/** One documented route, relative to an agent's base URL. */
export type DocEndpoint = {
  method: DocMethod;
  /** Path under the agent base — no leading slash, `:param` for a segment. */
  path: string;
  summary: string;
};

/**
 * The voice agent's public surface.
 *
 * Short because it genuinely is: a browser reads `client-config` once and then
 * talks WebSocket, and the socket is not an HTTP route a reader could call by
 * hand — so it is described in the pane's prose rather than listed as a row
 * somebody might try to `curl`.
 *
 * `client-config` names its own path from the SDK constant every server that
 * serves it also uses, so a rename cannot leave this table behind.
 */
export const VOICE_ENDPOINTS: readonly DocEndpoint[] = [
  { method: "GET", path: "", summary: "The agent's page — the voice client, or a workflow app." },
  {
    method: "GET",
    path: CLIENT_CONFIG_PATH,
    summary: "Name, greeting, page kind, and the WebSocket URL for a live session.",
  },
  {
    method: "POST",
    path: "phone",
    summary: "Carrier webhook — answers with the media-stream document for the call.",
  },
];

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
    path: WORKFLOWS,
    summary: "The workflows this agent declares, each with its input schema.",
  },
  {
    method: "POST",
    path: `${WORKFLOWS}/runs`,
    summary: "Start a run. Body: { workflow, input, key?, wait? } → { runId }.",
  },
  {
    method: "GET",
    path: `${WORKFLOWS}/runs`,
    summary: "Recent runs. Query: workflow, key?, limit?.",
  },
  {
    method: "GET",
    path: `${WORKFLOWS}/runs/:runId`,
    summary: "One run's snapshot. `?wait=ms` holds the request open until it settles.",
  },
  {
    method: "GET",
    path: `${WORKFLOWS}/runs/:runId/events`,
    summary: "Server-sent events for one run's progress.",
  },
  {
    method: "GET",
    path: `${WORKFLOWS}/runs/:runId/stream`,
    summary: "Server-sent events carrying the run's streamed output.",
  },
  {
    method: "POST",
    path: `${WORKFLOWS}/runs/:runId/wake`,
    summary: "Deliver a wake to a parked run.",
  },
  { method: "DELETE", path: `${WORKFLOWS}/runs/:runId`, summary: "Cancel a run." },
  {
    method: "POST",
    path: `${WORKFLOWS}/uploads`,
    summary: "Reserve an upload id, to pass as an input property.",
  },
  { method: "PUT", path: `${WORKFLOWS}/uploads/:id`, summary: "Stream an upload's bytes." },
  {
    method: "POST",
    path: `${WORKFLOWS}/uploads/:id/parts`,
    summary: "Begin a parallel, resumable upload; PUT each window to the same path.",
  },
  {
    method: "GET",
    path: `${WORKFLOWS}/uploads/:id/info`,
    summary: "How much of an upload landed.",
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

/** The absolute URL of one documented route. */
export function endpointUrl(base: string, endpoint: DocEndpoint): string {
  return endpoint.path === "" ? `${base}/` : `${base}/${endpoint.path}`;
}

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
function sampleValue(
  name: string,
  schema: unknown,
  uploads: readonly string[],
  depth: number,
): unknown {
  if (!isRecord(schema)) return `<${name}>`;
  const { enum: choices } = schema;
  if (Array.isArray(choices) && choices.length > 0) return choices[0];
  if (uploads.includes(name)) return "<upload id from POST /workflows/uploads>";
  switch (schema.type) {
    case "number":
    case "integer":
      return 0;
    case "boolean":
      return false;
    case "array":
      return depth >= MAX_SAMPLE_DEPTH ? [] : [sampleValue(name, schema.items, uploads, depth + 1)];
    case "object":
      return depth >= MAX_SAMPLE_DEPTH ? {} : sampleObject(schema, uploads, depth + 1);
    default:
      return `<${name}>`;
  }
}

/** Every declared property of an object schema, in declaration order. */
function sampleObject(
  schema: Record<string, unknown>,
  uploads: readonly string[],
  depth: number,
): Record<string, unknown> {
  const { properties } = schema;
  if (!isRecord(properties)) return {};
  return Object.fromEntries(
    Object.entries(properties).map(([name, property]) => [
      name,
      sampleValue(name, property, uploads, depth),
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
export function sampleInput(workflow: WorkflowSummary): Record<string, unknown> | undefined {
  if (!isRecord(workflow.inputSchema)) return undefined;
  return sampleObject(workflow.inputSchema, workflow.uploads ?? [], 0);
}

/** The `POST /workflows/runs` body for one workflow, example input included. */
export function startBody(workflow: WorkflowSummary): Record<string, unknown> {
  const input = sampleInput(workflow);
  return input === undefined ? { workflow: workflow.name } : { workflow: workflow.name, input };
}

/**
 * The `Authorization` header line a caller needs, or nothing.
 *
 * The workflow API is OPEN unless the agent's env sets
 * `AAI_WORKFLOW_API_TOKEN` — so whether a snippet should carry a bearer is a
 * fact about this project's secrets, not a caveat to leave in prose for the
 * reader to work out. See `WORKFLOW_API_TOKEN_SECRET`.
 */
function authLine(token: boolean): string {
  return token ? `\n  -H "Authorization: Bearer $AAI_WORKFLOW_API_TOKEN" \\` : "";
}

/** The secret whose presence closes the workflow API. */
export const WORKFLOW_API_TOKEN_SECRET = "AAI_WORKFLOW_API_TOKEN";

/**
 * `curl` that starts a run of one workflow.
 *
 * The body is compact rather than pretty-printed: it sits inside single quotes
 * on one shell line, and a multi-line `-d` is the version that breaks when
 * somebody copies half of it.
 */
export function curlStart(base: string, workflow: WorkflowSummary, token: boolean): string {
  return [
    `curl -X POST ${base}/${WORKFLOWS}/runs \\${authLine(token)}`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(startBody(workflow))}'`,
  ].join("\n");
}

/** `curl` that reads a run back, waiting up to 30s for it to settle. */
export function curlPoll(base: string, token: boolean): string {
  return `curl "${base}/${WORKFLOWS}/runs/$RUN_ID?wait=30000"${
    token ? ` \\\n  -H "Authorization: Bearer $AAI_WORKFLOW_API_TOKEN"` : ""
  }`;
}

/**
 * The same call in TypeScript, through the SDK's own client.
 *
 * Worth showing beside the `curl` because `startAndWait` is not a convenience
 * over the two requests above — it is the one call that holds the connection
 * open across the run, so the naive "start then poll in a loop" a reader would
 * otherwise write is strictly worse than what the SDK already does.
 */
export function tsStart(base: string, workflow: WorkflowSummary, token: boolean): string {
  const input = sampleInput(workflow);
  const args =
    input === undefined
      ? JSON.stringify(workflow.name)
      : `${JSON.stringify(workflow.name)}, ${JSON.stringify(input)}`;
  const options = token
    ? `{ baseUrl: "${base}", token: process.env.${WORKFLOW_API_TOKEN_SECRET} }`
    : `{ baseUrl: "${base}" }`;
  return [
    `import { createWorkflowApiClient } from "@alexkroman1/aai/workflow-api";`,
    "",
    `const api = createWorkflowApiClient(${options});`,
    `const run = await api.startAndWait(${args});`,
    `console.log(run.status, run.status === "completed" ? run.output : run);`,
  ].join("\n");
}

/** The `aai` CLI equivalents, so a reader who has the CLI does not build a curl. */
export function cliCommands(workflow: WorkflowSummary): string[] {
  return ["aai workflow list", `aai workflow runs ${workflow.name}`, "aai workflow show $RUN_ID"];
}
