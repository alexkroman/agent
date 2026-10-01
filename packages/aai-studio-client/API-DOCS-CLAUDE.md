---
summary: >-
  The studio's API pane and the public `/studio/api/<slug>` page: generated from
  the running agent, gated per agent shape, SDK-first snippets, the upload card,
  the form-field-to-JSON map, and what stays behind sign-in
read_when: >-
  changing `panes/docs.tsx`, `public-api.tsx`, `docs-content.ts`,
  `docs-snippets.ts`, `docs-form-fields.ts`, `docs-field-snippets.ts` or the
  `components/api-docs.tsx` / `docs-*.tsx` cards.
---

# The API pane and the public docs page

`panes/docs.tsx` + `docs-content.ts`, rendered through `components/api-docs.tsx`.
Package rules are in `CLAUDE.md`; the other panes in `src/panes/CLAUDE.md`.

## The pane is GENERATED from the running agent, never written

A deployed agent IS an API — `client-config` and a carrier webhook for a voice
agent, `GET|POST|PUT|DELETE /workflows/*` for a workflow app — and the pane
reads it (`GET /:slug/workflows`, `GET /:slug/client-config`).

- **Request bodies come from the agent's own input schemas.**
  `WorkflowSummary.inputSchema` is the JSON a workflow app's page renders its
  form from, so `sampleInput` builds an example with THIS deployment's field
  names. The property NAME is the placeholder (`"<topic>"`), never `"string"`.
- **Each half is offered only to the agents it is TRUE for:**
  - **No carrier webhook for a workflow app.** `mode: "workflow-app"`
    declines `/websocket` and can declare no carrier (`AgentDef.mode`), so
    `frontDoorEndpoints(page)` drops the `POST /phone` row and the Phone card
    with it; the page and its config stay.
  - **No workflow routes for an agent that declares no workflow** — a question
    about DECLARATIONS, not routes (the platform proxies `/:slug/workflows/*`
    for every agent). What is left is one sentence saying the project declares
    none.
  - **Neither gate DEFAULTS while the answer is outstanding** (both reads are
    one-shot, `staleTime: Infinity`), or cards would flash and vanish on every
    open. The front-door card waits for `client-config`; the workflow half
    shows one line (reading / could not read / declares none). A FAILED
    `client-config` defaults to voice, since `ClientConfigResponse.page` is
    optional.
  - `panes/docs.test.tsx` pins both, each negative beside a positive — a
    `queryByText(…)).toBeNull()` alone passes for a pane that renders nothing.
- **Voice session or page is asked of the AGENT** (`client-config`), never read
  off the project's stored `kind`, which selects the coding agent's prompt and
  can disagree with what is deployed.
- **Whether a snippet carries `Authorization` is read off the project's
  secrets**: the workflow API is open unless the agent's env sets
  `AAI_WORKFLOW_API_TOKEN`; the pane shares the Secrets pane's query key.
- **The endpoint tables cannot import `GUEST_ROUTE_EXPOSURE`** (this package
  may not depend on server code). The tie to what the platform proxies is the
  shared `WORKFLOW_API_PREFIX` plus aai-server's parity test;
  `docs-content.test.ts` asserts all four methods are documented.
- **The STUDIO pane carries no `/workflows/*` route table; the public page
  does** (`AgentApiDocsProps.workflowRoutes`, `false` from `panes/docs.tsx`).
  Every route is still shown being CALLED in the snippets, and the openness
  sentence (`AAI_WORKFLOW_API_TOKEN`) moves into the "Running a workflow" blurb.
- The builders are modules apart from the pane so a mis-spelled field (renders
  fine, 400s when pasted) is asserted directly: `docs-snippets.ts` holds the
  snippet generators, `docs-content.ts` the route tables and schema sampling.

## Every example DEFAULTS to the aai SDK; `curl` is a disclosure

`docs-snippets.ts`, and `Examples` in `components/docs-examples.tsx` (shared by
the pane and the upload card). The SDK call encodes what a shell reader would
re-derive wrong: `startAndWait` is ONE held-open request, an `idle` frame means
re-open (not "ended"), a progress read is tail-bounded so the next read resumes
from an absolute index, and an upload's bytes go in once. `curl` and
`aai workflow` sit behind a `<details>`/`<summary>` (not a language switcher),
and both stay in the DOM so a page search for `curl` finds them.

- **Route rows name their SDK call** (`DocEndpoint.sdk`), except the two that
  are nobody's method: the browser page and the carrier webhook.
- **The pane reads the agent through the client it documents**: one
  `createAgentClient`, `agent.list()` and `agent.config()`.
- **An upload property renders as a CALL**: the SDK snippet shows
  `const recordingUpload = await agent.upload(file, …)` and references
  `recordingUpload.id`, which is why `sampleInput` takes an `upload` renderer.
- **The "Sending a file" card** (`components/docs-uploads.tsx`) documents how to
  DO an upload: SDK first (`agent.upload` / `agent.uploadStream` /
  `agent.uploadInfo`), both ORDERS (upload then start; or mint the id, start,
  and stream the bytes while the run reads the prefix), generated from the
  agent's listing so it names a real workflow and property. It renders only
  when some workflow declares an upload.
- **The shell alternate really uploads**: `curlStart` emits the upload command
  above the run, and the run body EXPANDS the id
  (`"'"$AUDIO_FILE_UPLOAD_ID"'"`). The `curl` example file is a CONCRETE name
  (an angle bracket is a shell redirect), and the bearer reaches the upload
  command too, since closing the workflow API closes the upload routes.

## Every FORM CONTROL is mapped to the JSON that sets it

`components/docs-forms.tsx` ("Every form field, over HTTP"), over
`docs-form-fields.ts` and `docs-field-snippets.ts`. The place inference fails is
the file: an upload property is a plain `string` in the schema.

- **The classification is `<WorkflowFields>`'s, not a second opinion.**
  `classify()` mirrors `SchemaField` in aai-ui's
  `components/workflow-fields.tsx`, ORDER included — declared upload, then
  `enum`, `boolean`, `number`/`integer`, `string`, else no control.
  `docs-form-fields.test.ts` pins the order.
- **Every control is listed, even ones this agent declares nothing of** (the
  vocabulary is the answer to "what can I send"); the EXAMPLE on each row is
  generated from this agent's property via `sampleInput`, and each row says
  which it shows. `<TextAreaField>` is never matched (one property would appear
  as two controls).
- **The annotated snippet is written against ONE REAL workflow** — the one with
  the most fields (`fieldsWorkflow`) — since a synthesized body would 400. One
  entry point (`fieldSnippets`) because both halves are present together or not
  at all. The body is one property per line with an ALIGNED comment column and
  the upload as the expression reading the id.

## The same docs are served PUBLICLY at `/studio/api/<slug>`

`public-api.tsx`, the shared body in `components/api-docs.tsx`, the path pair in
`project-route.ts`; the API pane links to it so "send me your API docs" has an
answer that is not a sign-in screen.

- **It discloses nothing new**: both reads are the agent's already-public routes,
  so the server route needs no ownership check (the response is the app shell).
- **Two things stay behind the studio**, and `AgentApiDocs` splits along that
  line: the project's SECRETS (`token={false}` publicly — a closed workflow API
  refuses the listing and the card quotes the agent's 401) and the carrier
  webhook CARD (it reads those secrets). The `POST /:slug/phone` route ROW stays
  on both.
- **The page is chosen before the auth gate, in `main.tsx`'s render call**, not
  by an early return in `Root`: `Root` calls `useStudioAuth` unconditionally,
  and returning above it breaks the hook rules while returning below it can
  flash a sign-in screen.
- **The link names whichever agent the pane documents**, so before a first
  publish it is the PREVIEW, and the card says it is replaced on every edit.
