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

import { CLIENT_CONFIG_PATH } from "@alexkroman1/aai/protocol";
import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import {
  sampleInput,
  startBody,
  UPLOADS_PATH,
  WORKFLOW_API_TOKEN_SECRET,
  WORKFLOWS_PATH,
} from "./docs-content.ts";

/** The package a reader installs to run any of the SDK snippets below. */
export const SDK_INSTALL = "npm i @alexkroman1/aai";

/** The run id every read-it-back snippet leaves for the reader to fill in. */
const RUN_ID = "<run id>";

/**
 * The file every upload snippet sends, and the type it declares.
 *
 * A CONCRETE name rather than a `<path to your file>` placeholder, because these
 * are shell commands: an angle bracket is a redirect, so the placeholder spelling
 * every other snippet here uses would turn a paste into a truncated file. The
 * name and the type are also not decoration — `?name=` and `Content-Type` are
 * what a step sees when it reads the upload back, so the snippet has to show both
 * being set rather than leaving them to a default.
 */
const UPLOAD_FILE = "recording.wav";
const UPLOAD_TYPE = "audio/wav";

/** The shell variable a `curl` snippet leaves an upload's id in. */
function shellUploadVar(property: string): string {
  const upper = property.replace(/[^A-Za-z0-9]+/g, "_").toUpperCase();
  // A property may legally start with a digit; a shell variable may not.
  return `${/^[A-Z_]/.test(upper) ? upper : `_${upper}`}_UPLOAD_ID`;
}

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
export function uploadVar(property: string): string {
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
function sdkInputLiteral(
  workflow: WorkflowSummary,
  render: (property: string) => string = (property) => `${uploadVar(property)}.id`,
): string | undefined {
  const input = sampleInput(workflow, { upload: uploadSentinel });
  if (input === undefined) return undefined;
  let literal = JSON.stringify(input);
  for (const property of workflow.uploads ?? []) {
    literal = literal.replaceAll(JSON.stringify(uploadSentinel(property)), render(property));
  }
  return literal;
}

/**
 * The variable a caller-chosen upload ID is held in, for the start-first shape.
 *
 * Distinct from {@link uploadVar} because the two hold different things — a
 * `UploadRef` the agent answered with, against an id the caller minted — and a
 * snippet that named both `…Upload` would be teaching that they are the same
 * object, which is exactly the distinction the second shape exists to make.
 */
function uploadIdVar(property: string): string {
  return `${uploadVar(property).replace(/Upload$/, "")}UploadId`;
}

/** The `agent.upload(...)` lines a workflow's declared uploads need, if any. */
export function uploadLines(workflow: WorkflowSummary): string[] {
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
 * The arguments a `start`/`startAndWait` call takes: the workflow name, and the
 * input literal when the workflow declares a schema.
 *
 * Shared by {@link sdkStart} and {@link sdkUploadStream}, which differ only in
 * how an upload property renders — hence the optional `render`, which is the
 * argument {@link sdkInputLiteral} already takes.
 */
function startArgs(workflow: WorkflowSummary, render?: (property: string) => string): string {
  const input = sdkInputLiteral(workflow, render);
  const name = JSON.stringify(workflow.name);
  return input === undefined ? name : `${name}, ${input}`;
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
  const args = startArgs(workflow);
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
 * The header itself, in one place: the two helpers below differ only in which
 * side the shell's line-continuation backslash falls on, and two spellings of
 * one header is how they drift.
 */
const AUTH_HEADER = `-H "Authorization: Bearer $${WORKFLOW_API_TOKEN_SECRET}"`;

/**
 * The `Authorization` header line a `curl` needs, or nothing.
 *
 * The workflow API is OPEN unless the agent's env sets
 * `AAI_WORKFLOW_API_TOKEN` — so whether a snippet should carry a bearer is a
 * fact about this project's secrets, not a caveat to leave in prose for the
 * reader to work out.
 */
function authLine(token: boolean): string {
  return token ? `\n  ${AUTH_HEADER} \\` : "";
}

/** The `Authorization` line a GET carries, as a trailing continuation. */
function getAuth(token: boolean): string {
  return token ? ` \\\n  ${AUTH_HEADER}` : "";
}

/**
 * The `POST /workflows/runs` body, with every upload property expanded from the
 * shell variable the upload command above it left the id in.
 *
 * The substitution goes through the same sentinel the SDK literal uses, and for
 * the same reason: the value has to end up as an EXPANSION rather than as data,
 * and JSON.stringify would quote a `$VAR` into a literal. `"'"$X"'"` is the
 * shell's own spelling for it — the JSON quotes stay, the single-quoted `-d`
 * argument closes and reopens around the variable — so the body is still one
 * pastable line.
 */
function curlStartBody(workflow: WorkflowSummary): string {
  let body = JSON.stringify(startBody(workflow, { upload: uploadSentinel }));
  for (const property of workflow.uploads ?? []) {
    body = body.replaceAll(
      JSON.stringify(uploadSentinel(property)),
      `"'"$${shellUploadVar(property)}"'"`,
    );
  }
  return body;
}

/**
 * `curl` that starts a run of one workflow.
 *
 * The body is compact rather than pretty-printed: it sits inside single quotes
 * on one shell line, and a multi-line `-d` is the version that breaks when
 * somebody copies half of it.
 */
function curlStartCommand(base: string, workflow: WorkflowSummary, token: boolean): string[] {
  return [
    `curl -X POST ${base}/${WORKFLOWS_PATH}/runs \\${authLine(token)}`,
    `  -H "Content-Type: application/json" \\`,
    `  -d '${curlStartBody(workflow)}'`,
  ];
}

/**
 * `curl` that sends one file and leaves its id in a shell variable.
 *
 * The shell half of `agent.upload(file)`, and the reason this page needed one:
 * the run body next to it carries an upload id, and until this existed the only
 * documented way to obtain one was to be in TypeScript. The body is the FILE —
 * raw bytes, not a multipart envelope — with the name in `?name=` and the type in
 * `Content-Type`, which is the one thing about these routes a reader cannot guess
 * from the other POSTs on the page.
 *
 * `jq` reads the id out. A reader without it can run the command bare and copy
 * the `id` from the answer, which is why the comment says what the pipe is for.
 */
function curlUploadCommand(base: string, property: string, token: boolean): string[] {
  return [
    `${shellUploadVar(property)}=$(curl -s -X POST "${base}/${UPLOADS_PATH}?name=${UPLOAD_FILE}" \\${authLine(token)}`,
    `  -H "Content-Type: ${UPLOAD_TYPE}" \\`,
    // The answer is `{ id, name, type, size, complete, url }`; `jq` picks the id.
    `  --data-binary @${UPLOAD_FILE} | jq -r .id)`,
  ];
}

/** The upload commands one workflow's declared properties need, if any. */
function curlUploadLines(base: string, workflow: WorkflowSummary, token: boolean): string[] {
  const uploads = workflow.uploads ?? [];
  if (uploads.length === 0) return [];
  return [
    `# The bytes go in once; the run below carries the id. Swap ${UPLOAD_FILE} for your file.`,
    ...uploads.flatMap((property) => curlUploadCommand(base, property, token)),
    "",
  ];
}

export function curlStart(base: string, workflow: WorkflowSummary, token: boolean): string {
  return [
    ...curlUploadLines(base, workflow, token),
    ...curlStartCommand(base, workflow, token),
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

/**
 * Sending a file, and getting back the handle a run input carries.
 *
 * The call the upload card leads with, and the one that answers "how do I
 * actually do the upload" for the 90% case: one call, the bytes go in, the id
 * comes back. `onProgress` is in the snippet rather than in prose because this
 * is the one call on the surface slow enough to need a bar, and a reader who
 * discovers that later has already written the version without one.
 */
export function sdkUpload(base: string, token: boolean): string {
  return sdkSnippet(
    base,
    token,
    '// `file` is a File from an <input type="file">, a Blob, or a Uint8Array.',
    "const stored = await agent.upload(file, {",
    `  name: "${UPLOAD_FILE}",`,
    "  onProgress: ({ fraction }) => console.log(fraction),",
    "});",
    "// `stored.id` is what an upload-carrying input property takes.",
    "console.log(stored.id, stored.size, stored.complete);",
  );
}

/** The same upload from a shell, id and all. */
export function curlUpload(base: string, token: boolean): string {
  return [
    `curl -X POST "${base}/${UPLOADS_PATH}?name=${UPLOAD_FILE}" \\${authLine(token)}`,
    `  -H "Content-Type: ${UPLOAD_TYPE}" \\`,
    `  --data-binary @${UPLOAD_FILE}`,
    `# → {"id":"…","name":"${UPLOAD_FILE}","type":"${UPLOAD_TYPE}","size":1048576,"complete":true}`,
  ].join("\n");
}

/**
 * Starting the run FIRST, and sending the bytes into an id the caller chose.
 *
 * The other order, and the reason `PUT /uploads/:id` exists beside the `POST`: a
 * `POST` can only answer with an id once the last byte is stored, so a run that
 * needs the id in its input waits out the whole upload. Here the id exists before
 * the bytes leave — the run starts immediately and its steps read the prefix that
 * has arrived. Worth a snippet of its own rather than a sentence, because the
 * difference is entirely in the ORDER of three lines.
 */
export function sdkUploadStream(base: string, workflow: WorkflowSummary, token: boolean): string {
  const uploads = workflow.uploads ?? [];
  const args = startArgs(workflow, uploadIdVar);
  return sdkSnippet(
    base,
    token,
    "// An upload id is a capability, so mint it the way the SDK does.",
    ...uploads.map(
      (property) => `const ${uploadIdVar(property)} = crypto.randomUUID().replaceAll("-", "");`,
    ),
    "",
    `const runId = await agent.start(${args});`,
    "// The run is already going; these bytes are what its steps read.",
    ...uploads.map(
      (property) =>
        `await agent.uploadStream(${uploadIdVar(property)}, file, { name: "${UPLOAD_FILE}" });`,
    ),
    "console.log(runId);",
  );
}

/** The same order from a shell: mint an id, start the run, then send the file. */
export function curlUploadStream(base: string, workflow: WorkflowSummary, token: boolean): string {
  const uploads = workflow.uploads ?? [];
  return [
    // `uuidgen` is on macOS and every Linux with util-linux; the tr strips the
    // hyphens the upload token grammar does not accept.
    ...uploads.map(
      (property) => `${shellUploadVar(property)}=$(uuidgen | tr -d - | tr 'A-Z' 'a-z')`,
    ),
    ...curlStartCommand(base, workflow, token),
    ...uploads.flatMap((property) => [
      `curl -X PUT "${base}/${UPLOADS_PATH}/$${shellUploadVar(property)}?name=${UPLOAD_FILE}" \\${authLine(token)}`,
      `  -H "Content-Type: ${UPLOAD_TYPE}" \\`,
      `  --data-binary @${UPLOAD_FILE}`,
    ]),
  ].join("\n");
}

/**
 * Watching an upload fill in.
 *
 * `size` is the CONTIGUOUS prefix that has landed rather than the bytes received,
 * which is the field a caller branches on — parts arrive out of order, and a
 * count of bytes stored would say an upload is further along than a step can
 * actually read.
 */
export function sdkUploadInfo(base: string, token: boolean): string {
  return sdkSnippet(
    base,
    token,
    `const info = await agent.uploadInfo("<upload id>");`,
    "console.log(info.size, info.complete);",
  );
}

/** The same read from a shell. */
export function curlUploadInfo(base: string, token: boolean): string {
  return `curl "${base}/${UPLOADS_PATH}/$UPLOAD_ID/info"${getAuth(token)}`;
}

/** The `aai` CLI equivalents, so a reader who has the CLI does not build a curl. */
export function cliCommands(workflow: WorkflowSummary): string[] {
  return ["aai workflow list", `aai workflow runs ${workflow.name}`, "aai workflow show $RUN_ID"];
}
