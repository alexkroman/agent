// Copyright 2026 the AAI authors. MIT license.
/**
 * "You do not need this page" — the HTTP API, on the page.
 *
 * A workflow app's whole surface is `GET|POST /workflows/*`, and the page is one
 * caller of it. That is the most useful thing about the shape and the least
 * discoverable: nothing in a form suggests that the same work is three `curl`
 * calls, that a run id is the entire handle (no session, no cookie), or that a
 * transcript can be collected days later from another machine. So the recipes are
 * rendered where somebody is already looking, rather than left in a README they
 * would have to know exists.
 *
 * ## It links to the LIVE listing
 *
 * `GET /workflows` serves each workflow's name, description and input schema — the
 * same JSON `<WorkflowFields>` renders this form from. So the link is not
 * documentation about the API, it is the API answering for itself, on this
 * deployment, at this version. A reader who wants the schema gets the real one;
 * a reader whose agent is behind `AAI_WORKFLOW_API_TOKEN` gets a 401, which is
 * also the truth.
 *
 * ## The three recipes are the three flows
 *
 * The first two differ only in who names the upload — which is the whole of what
 * lets one of them start before the bytes are in — and the third does none of that
 * work at all. Showing them side by side is the clearest statement of the trade
 * available, and cheaper than the prose that would otherwise have to make it.
 *
 * They are also KEPT HONEST by being runnable: every one of these was executed
 * against a real dev server, which is how two bugs in the streaming path were
 * found (a missing wake after the upload, and a poll that slept on a stale view).
 */

/** @jsxImportSource react */

import type { ReactNode } from "react";

/** The API root, relative to wherever this page is served from. */
const API = "workflows";

/**
 * One shell recipe, with a heading and a note.
 *
 * Rendered in a `<pre>` rather than assembled from styled spans: it exists to be
 * SELECTED and pasted, and any markup inside the block is markup a copy picks up.
 */
function Recipe({
  title,
  note,
  script,
}: {
  title: string;
  note: string;
  script: string;
}): ReactNode {
  return (
    <section className="flex flex-col gap-2">
      <h4 className="text-xs font-medium uppercase tracking-[1.2px]">{title}</h4>
      <p className="text-xs opacity-70">{note}</p>
      <pre className="overflow-x-auto rounded-md border p-3 text-xs leading-relaxed">{script}</pre>
    </section>
  );
}

/** Store the whole file, then start a run on its id. */
const CLASSIC = `# 1. store the recording. Answers 201 once the LAST byte is in, which is why
#    this shape cannot start the run any earlier.
ID=$(curl -s -X POST "$AGENT/workflows/uploads?name=standup.wav" \
  -H 'content-type: audio/wav' --data-binary @standup.wav | jq -r .id)

# 2. run it. \`wait\` holds the request open for up to 60s; drop it to get
#    { runId } straight back and poll instead.
curl -s -X POST "$AGENT/workflows/runs" \
  -H 'content-type: application/json' \
  -d "{\\"workflow\\":\\"transcribe\\",\\"wait\\":60000,
       \\"input\\":{\\"recording\\":\\"$ID\\"}}" | jq -r '.run.output.transcript'`;

/** Start the run first, then stream the file to the id it is watching. */
const STREAMING = `# No splitting, no ffmpeg — the file goes in ONE request. The only difference
# from the recipe above is that YOU pick the upload id, so it is already valid
# when the run starts and the run reads the bytes as they land.

# 1. pick an id and start the run on it. Nothing has been uploaded yet.
ID=$(openssl rand -hex 16)
RUN=$(curl -s -X POST "$AGENT/workflows/runs" \
  -H 'content-type: application/json' \
  -d "{\\"workflow\\":\\"transcribeStream\\",
       \\"input\\":{\\"recording\\":\\"$ID\\"}}" | jq -r .runId)

# 2. PUT the whole file. The upload record exists from the first byte with
#    complete:false, and its size grows — which is what the run polls.
curl -s -X PUT "$AGENT/workflows/uploads/$ID?name=standup.wav" \
  -H 'content-type: audio/wav' --data-binary @standup.wav | jq -c '{size, complete}'

# 3. wake it. The run sleeps between polls, so without this it notices the file
#    is finished up to one poll interval late — every time.
curl -s -X POST "$AGENT/workflows/runs/$RUN/wake" > /dev/null

# 4. collect it whenever — a run id is the whole handle.
curl -s "$AGENT/workflows/runs/$RUN?wait=60000" | jq -r '.run.output.transcript'

# While it runs, from any other shell:
#   curl -s "$AGENT/workflows/uploads/$ID/info"        # how much has arrived
#   curl -sN "$AGENT/workflows/runs/$RUN/stream"       # what the run is saying`;

/** Hand the whole thing to the async API. */
const BATCH = `# The same two requests as the first recipe — only the workflow name differs.
# No cutting happens anywhere: the run uploads your file to the async API,
# polls the job, and reads the text. It also accepts mp3 and m4a, which the
# two sync flows refuse.
ID=$(curl -s -X POST "$AGENT/workflows/uploads?name=standup.m4a" \
  -H 'content-type: audio/mp4' --data-binary @standup.m4a | jq -r .id)

# No \`wait\` here: an async job takes minutes, well past the 60s ceiling a
# synchronous read can hold. Start it, then follow the run.
RUN=$(curl -s -X POST "$AGENT/workflows/runs" \
  -H 'content-type: application/json' \
  -d "{\\"workflow\\":\\"transcribeBatch\\",
       \\"input\\":{\\"recording\\":\\"$ID\\"}}" | jq -r .runId)

curl -sN "$AGENT/workflows/runs/$RUN/events"          # status, as it changes
curl -s "$AGENT/workflows/runs/$RUN" | jq -r '.output.transcript // .status'`;

/** Every route this app answers, and what each is for. */
const ROUTES: readonly { route: string; does: string }[] = [
  { route: "GET  /workflows", does: "the three workflows and their input schemas" },
  { route: "POST /workflows/runs", does: "start a run · body names workflow and input" },
  { route: "GET  /workflows/runs", does: "runs so far · filter by workflow, key, limit" },
  { route: "GET  /workflows/runs/:id", does: "one run · add wait=<ms> to block on it" },
  { route: "GET  /workflows/runs/:id/events", does: "SSE, status transitions" },
  { route: "GET  /workflows/runs/:id/stream", does: "SSE, what the run has written" },
  { route: "POST /workflows/runs/:id/wake", does: "end a pending sleep early" },
  { route: "DELETE /workflows/runs/:id", does: "cancel it" },
  { route: "POST /workflows/uploads", does: "store a file, id minted by the store" },
  {
    route: "PUT  /workflows/uploads/:id",
    does: "store a file under YOUR id, readable as it arrives",
  },
  {
    route: "POST /workflows/uploads/:id/parts",
    does: "declare an upload its parts fill in · ?total=<bytes>",
  },
  {
    route: "PUT  /workflows/uploads/:id/parts",
    does: "one window of it · ?offset=<byte>, sent concurrently",
  },
  { route: "GET  /workflows/uploads/:id", does: "read the bytes back · Range honoured" },
  { route: "GET  /workflows/uploads/:id/info", does: "name, bytes stored so far, and complete" },
];

/**
 * The whole API, collapsed by default.
 *
 * `<details>` rather than a state hook: the browser owns disclosure, it is
 * keyboard-accessible and findable by in-page search without anyone wiring either,
 * and a page that renders a transcript should not re-render because somebody
 * expanded a help panel.
 */
export function ApiHelp(): ReactNode {
  return (
    <details className="rounded-md border">
      <summary className="cursor-pointer p-4 text-sm font-medium">
        Use the API without this page
      </summary>
      <div className="flex flex-col gap-6 border-t p-4">
        <p className="text-sm opacity-70">
          This page is one caller. Everything it does is plain HTTP on this agent's own origin,
          unauthenticated unless the deployment sets{" "}
          <code className="text-xs">AAI_WORKFLOW_API_TOKEN</code> (then every route wants{" "}
          <code className="text-xs">Authorization: Bearer …</code>). A run id is the whole handle —
          no session, no cookie — so a transcript can be collected from another machine, days later.
        </p>
        <p className="text-sm">
          {/* The API answering for itself: same JSON this form was rendered from. */}
          <a className="underline" href={API} target="_blank" rel="noreferrer">
            {`GET ${API}`}
          </a>{" "}
          <span className="opacity-70">
            — the live listing, including each workflow's input schema. Set{" "}
            <code className="text-xs">AGENT</code> to this page's origin for the recipes below.
          </span>
        </p>

        <Recipe
          title="Store it, then transcribe"
          note="Sync API. One request per phase, and the upload has to finish before there is a run."
          script={CLASSIC}
        />
        <Recipe
          title="Transcribe while it uploads"
          note="Sync API, one upload request, no splitting. The run starts on an id you chose and reads the bytes as they land."
          script={STREAMING}
        />
        <Recipe
          title="Let the provider do it"
          note="Async API. No cutting and no seams, it accepts compressed audio, and the wait belongs to the provider's queue."
          script={BATCH}
        />

        <section className="flex flex-col gap-2">
          <h4 className="text-xs font-medium uppercase tracking-[1.2px]">Every route</h4>
          <ul className="flex flex-col gap-1">
            {ROUTES.map((entry) => (
              <li key={entry.route} className="flex flex-col gap-0.5 text-xs sm:flex-row sm:gap-3">
                <code className="shrink-0 sm:w-72">{entry.route}</code>
                <span className="opacity-70">{entry.does}</span>
              </li>
            ))}
          </ul>
        </section>
      </div>
    </details>
  );
}
