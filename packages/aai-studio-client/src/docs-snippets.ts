// Copyright 2026 the AAI authors. MIT license.
// Every snippet the API pane shows, in the three languages it can offer:
// the aai SDK (the DEFAULT, and what each section leads with), `curl`, and the
// `aai` CLI.
//
// **The SDK is the default because it is the surface these routes were built
// for.** Every example here used to open with `curl`, which taught the shape of
// the HTTP API and left the reader to re-derive everything the client already
// knows: that `startAndWait` holds one connection open across a run rather than
// polling in a loop, that an `idle` frame on the event stream means re-open
// rather than "the run ended", that a progress read is bounded by the tail so a
// live run needs the next read to resume from an absolute index, and that an
// upload's bytes go in once and the run carries the id. A reader who pastes the
// shell version writes a worse client than the one they already have in their
// dependencies — so the SDK leads, and `curl` stays one disclosure away for the
// reader who is not in TypeScript at all.
//
// **Every SDK snippet is self-contained**, import and client construction
// included, because the unit of use is a copy-paste — a snippet that starts at
// the interesting line reads as a fragment of a file the reader does not have.
//
// Split from `docs-content.ts` when that became true: the tables and the
// schema sampling there are one subject, and the code generation is another.
// Both are pure functions, which is why they are tested directly rather than
// through a render — a snippet spelling a field differently than the workflow
// declared it renders perfectly and 400s when somebody pastes it.

import type { WorkflowSummary } from "@alexkroman1/aai";
import { CLIENT_CONFIG_PATH } from "@alexkroman1/aai/protocol";
import {
  sampleInput,
  startBody,
  WORKFLOW_API_TOKEN_SECRET,
  WORKFLOWS_PATH,
} from "./docs-content.ts";

/** The package a reader installs to run any of the SDK snippets below. */
export const SDK_INSTALL = "npm i @alexkroman1/aai";

/** The run id every read-it-back snippet leaves for the reader to fill in. */
const RUN_ID = "<run id>";

/**
 * The import and the client, which every SDK snippet opens with.
 *
 * One client for the whole agent — `createAgentClient` covers the front door
 * (`config()`) as well as every workflow route, so the page can be documented
 * as one object rather than as two clients a reader has to know to build.
 */
export function sdkClient(base: string, token: boolean): string {
  const options = token
    ? `{\n  baseUrl: "${base}",\n  token: process.env.${WORKFLOW_API_TOKEN_SECRET},\n}`
    : `{ baseUrl: "${base}" }`;
  return [
    `import { createAgentClient } from "@alexkroman1/aai/workflow-api";`,
    "",
    `const agent = createAgentClient(${options});`,
  ].join("\n");
}

/** An SDK snippet: the client, then the call. */
function sdkSnippet(base: string, token: boolean, ...lines: string[]): string {
  return [sdkClient(base, token), "", ...lines].join("\n");
}

/**
 * Reading what the agent IS.
 *
 * The one call that works on every agent whatever shape it is, and the one a
 * caller starts from: `page` says whether there is a session to open at all,
 * and `sessionUrl` names the current one.
 */
export function sdkConfig(base: string, token: boolean): string {
  return sdkSnippet(
    base,
    token,
    "const { name, greeting, page, sessionUrl } = await agent.config();",
    `console.log(name, page ?? "voice", sessionUrl);`,
  );
}

/** `curl` for the same read — the shell alternative, for a reader who is not in TS. */
export function curlConfig(base: string): string {
  return `curl ${base}/${CLIENT_CONFIG_PATH}`;
}

/**
 * The variable an upload's id is read off in an SDK snippet.
 *
 * A named `const` rather than an inline `await` inside the input object, because
 * the point of showing it is that the bytes go in ONCE and the run carries the
 * handle — two properties fed by one file is the shape that makes that visible.
 */
function uploadVar(property: string): string {
  const camel = property.replace(/[-_\s]+(.)/g, (_, c: string) => c.toUpperCase());
  return `${camel.replace(/^(.)/, (c) => c.toLowerCase())}Upload`;
}

/** The sentinel a sampled upload value carries, so it can become an EXPRESSION. */
function uploadSentinel(property: string): string {
  return `@@upload:${property}@@`;
}

/**
 * The example `input` for one workflow, as a JavaScript object literal.
 *
 * The difference from the `curl` body is the upload properties: JSON can only
 * describe one as a string ("get an id from this route"), where the SDK snippet
 * shows the call that produces it and references its result. Rendering therefore
 * goes through a sentinel — the value is sampled as a string and the quoted
 * sentinel is replaced by the identifier — because the literal has to end up as
 * code rather than as data.
 */
function sdkInputLiteral(workflow: WorkflowSummary): string | undefined {
  const input = sampleInput(workflow, { upload: uploadSentinel });
  if (input === undefined) return undefined;
  let literal = JSON.stringify(input);
  for (const property of workflow.uploads ?? []) {
    literal = literal.replaceAll(
      JSON.stringify(uploadSentinel(property)),
      `${uploadVar(property)}.id`,
    );
  }
  return literal;
}

/** The `agent.upload(...)` lines a workflow's declared uploads need, if any. */
function uploadLines(workflow: WorkflowSummary): string[] {
  const uploads = workflow.uploads ?? [];
  if (uploads.length === 0) return [];
  return [
    '// `file` is a File from an <input type="file">, a Blob, or a Uint8Array.',
    "// The bytes go in once; the run carries the id.",
    ...uploads.map(
      (property) =>
        `const ${uploadVar(property)} = await agent.upload(file, { name: "${property}" });`,
    ),
    "",
  ];
}

/**
 * Starting a run and waiting for it, through the SDK.
 *
 * `startAndWait` is the default rather than `start`, and it is not a
 * convenience over the two `curl` calls beside it: it is ONE request that the
 * agent holds open across the run, so the "start, then poll in a loop" a reader
 * would otherwise write is strictly worse than what they already have. A run
 * that outlives the agent's own budget comes back non-terminal, which is what
 * the read-it-back snippet is for.
 */
export function sdkStart(base: string, workflow: WorkflowSummary, token: boolean): string {
  const input = sdkInputLiteral(workflow);
  const args =
    input === undefined
      ? JSON.stringify(workflow.name)
      : `${JSON.stringify(workflow.name)}, ${input}`;
  return sdkSnippet(
    base,
    token,
    ...uploadLines(workflow),
    `const run = await agent.startAndWait(${args});`,
    `console.log(run.status, run.status === "completed" ? run.output : run);`,
  );
}

/**
 * Reading a run back later — the id is the whole handle.
 *
 * `undefined` is an ANSWER here rather than a failure (no such run), which is
 * the one thing about this call a reader cannot guess, so the snippet branches
 * on it.
 */
export function sdkRead(base: string, token: boolean): string {
  return sdkSnippet(
    base,
    token,
    `const run = await agent.get("${RUN_ID}", { wait: 30_000 });`,
    `if (run === undefined) console.log("no such run");`,
    `else console.log(run.status, run.status === "completed" ? run.output : run);`,
  );
}

/**
 * Following a run's state as it goes.
 *
 * The two protocol rules a hand-written SSE loop gets wrong — the stream hands
 * the client back with an `idle` frame after its own duration cap, and an end
 * with the run unsettled is a dropped connection rather than a finish — are
 * inside `follow`, which is the argument for showing this rather than the raw
 * event stream.
 */
export function sdkFollow(base: string, token: boolean): string {
  return sdkSnippet(
    base,
    token,
    `// Ends on the terminal snapshot, re-opening across the stream's own cap.`,
    `for await (const run of agent.follow("${RUN_ID}")) {`,
    "  console.log(run.status);",
    "}",
  );
}

/** Reading everything a run WRITES, in order, until it settles. */
export function sdkFollowOutput(base: string, token: boolean): string {
  return sdkSnippet(
    base,
    token,
    "// Chunks are retained with the run, so this replays from the start.",
    `for await (const chunk of agent.followOutput("${RUN_ID}")) {`,
    "  console.log(chunk);",
    "}",
  );
}

/**
 * The `Authorization` header line a `curl` needs, or nothing.
 *
 * The workflow API is OPEN unless the agent's env sets
 * `AAI_WORKFLOW_API_TOKEN` — so whether a snippet should carry a bearer is a
 * fact about this project's secrets, not a caveat to leave in prose for the
 * reader to work out.
 */
function authLine(token: boolean): string {
  return token ? `\n  -H "Authorization: Bearer $${WORKFLOW_API_TOKEN_SECRET}" \\` : "";
}

/** The `Authorization` line a GET carries, as a trailing continuation. */
function getAuth(token: boolean): string {
  return token ? ` \\\n  -H "Authorization: Bearer $${WORKFLOW_API_TOKEN_SECRET}"` : "";
}

/**
 * `curl` that starts a run of one workflow.
 *
 * The body is compact rather than pretty-printed: it sits inside single quotes
 * on one shell line, and a multi-line `-d` is the version that breaks when
 * somebody copies half of it.
 */
export function curlStart(base: string, workflow: WorkflowSummary, token: boolean): string {
  return [
    `curl -X POST ${base}/${WORKFLOWS_PATH}/runs \\${authLine(token)}`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${JSON.stringify(startBody(workflow))}'`,
  ].join("\n");
}

/** `curl` that reads a run back, waiting up to 30s for it to settle. */
export function curlPoll(base: string, token: boolean): string {
  return `curl "${base}/${WORKFLOWS_PATH}/runs/$RUN_ID?wait=30000"${getAuth(token)}`;
}

/** `curl` that tails a run's event stream. `-N` is what stops it buffering. */
export function curlFollow(base: string, token: boolean): string {
  return `curl -N "${base}/${WORKFLOWS_PATH}/runs/$RUN_ID/events"${getAuth(token)}`;
}

/** The `aai` CLI equivalents, so a reader who has the CLI does not build a curl. */
export function cliCommands(workflow: WorkflowSummary): string[] {
  return ["aai workflow list", `aai workflow runs ${workflow.name}`, "aai workflow show $RUN_ID"];
}
