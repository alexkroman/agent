// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of a workflow app.
 *
 * Mounted with `page()` rather than `client()`: there is no session to build, so
 * there is no socket, no audio graph, and no microphone request. Everything else
 * is the same — the same `client.tsx` filename, React, Tailwind, and the same
 * theme tokens the voice components read.
 *
 * What replaces `useSession()` is `useWorkflowSubmit()`: it starts the run,
 * follows its STATUS, and hands back the controls bound to it — `wake`, `cancel`
 * and `reset`.
 *
 * ## The run survives a reload; the run ID does not
 *
 * A `runId` names a run for as long as anything is holding it, and this page
 * holds it in React state — so a refresh loses it while the run carries on
 * without it. That is the wrong half of durability to leave to the reader: the
 * page used to promise "the run continues without it" and then had no way back
 * to the run it was promising about.
 *
 * A correlation KEY is the handle that survives, and this page writes none of
 * it: `useWorkflowSubmit` mints an opaque per-page key into `sessionStorage`,
 * records every run under it, and asks `find("digest", key)` as it mounts —
 * so a reload lands back on the same headline, the same progress log and the
 * same buttons. Six templates used to write those two options each, which is
 * what made it the default.
 *
 * What the page can still say is which key: `useRunKey({ storage: "local" })`
 * for a run meant to outlive the tab (`podcast-digest`), an ACCOUNT's own id
 * for an app with logins, `recover: false` for a form that must always open
 * empty. `use-run-key.ts` argues what a key may not be — derived from the URL
 * being digested, or carried in a `?key=` parameter.
 *
 * Deployed, this needs the correlation-key index, which is a `DATABASE_URL`
 * away — `agent.ts` says what happens without one (the runs are still durable;
 * the index that finds them by key is in memory).
 *
 * ## The FORM here is still written by hand, deliberately
 *
 * This is the template that shows the primitives raw. `redline` and
 * `transcription-workflow` declare their forms — `<Form>` + `<WorkflowFields>`
 * renders one control per scalar the schema declares — and that is what most
 * pages should do. This one writes its single `<input>` itself, so a reader can
 * see what the declared layer is standing on: an ordinary `onSubmit` handing an
 * object to `submit()`.
 *
 * ## Status and progress are different questions
 *
 * `useWorkflowSubmit` answers "where has this got to" from the world's own
 * record — pending, running, completed. `<WorkflowProgress>` answers "what is it
 * doing" from what the run wrote itself (`report()` in `workflows/digest.ts`). A
 * page with only the first shows "Working…" for the length of the run; a page
 * with only the second cannot tell a finished run from a quiet one. Both are
 * cheap: one stream each, ended by the agent when there is nothing left to say.
 *
 * Progress also REPLAYS — chunks are retained with the run — so a reload mid-run
 * catches up rather than starting from whatever arrives next. That only pays off
 * because the reload can name its run again: `<WorkflowProgress runId>` is handed
 * `run?.runId`, so before the recovery a refresh replayed a log for nobody.
 * `lines={1}` is
 * what narrows it to the newest line, because on a page this small that is the
 * whole of what a status wants; `transcription-workflow` renders the full log,
 * where a fan-out makes the history worth seeing.
 */

import { page, useWorkflowSubmit, WorkflowProgress } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/
// digest.ts` already declares.
import { useState } from "react";
import type { digest } from "./agent.ts";

/**
 * What the page says while something is in flight — three situations, one line
 * each, and none of them the sentence this page used to print.
 *
 * That one was "You can close this tab — the run continues without it": true
 * about the run and false about the page, which is the worst shape a reassurance
 * can have. The run did continue and the tab could never find it again. Now it
 * can, so the promise gets stronger and the reload case gets its own words —
 * somebody who did not press the button is owed an explanation for the work
 * appearing in front of them.
 */
function pendingNote(startedHere: boolean, found: boolean): string {
  if (startedHere)
    return "You can close this tab or reload it — this page will find the run again.";
  if (!found) return "Looking for a digest this tab started earlier…";
  return "Still working on the digest this tab started earlier. Reloading is safe.";
}

export function App() {
  const [url, setUrl] = useState("");
  // Did THIS load start the run? A reload cannot have, and that is the only way
  // the page can tell "working on what you just submitted" from "picking up
  // where you left off" — the hook reports the run, not who asked for it.
  const [startedHere, setStartedHere] = useState(false);
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. `error` is the agent's own sentence for a
  // rejected input, which is better copy than anything this page could write, and
  // `wake` is bound to whatever run the hook is following — the whole reason this
  // page no longer holds a `createWorkflowApi()` of its own.
  // No `key` and no `recover`: this tab's handle on its own runs is minted and
  // remembered by the hook, and read back as it mounts. See the module doc for
  // what a page says when it wants a different one.
  const { submit, run, pending, error, wake } = useWorkflowSubmit<typeof digest>("digest");

  // `submit()` resolves as soon as the run exists — deliberately not when it
  // finishes. That is the whole mechanism: the digest sleeps for a while, and
  // this page is free to be closed in the meantime.
  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
    setStartedHere(true);
    void submit({ url });
  };

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-medium">Link Digest</h1>

      <form onSubmit={onSubmit} className="flex gap-2">
        <input
          type="url"
          required
          value={url}
          onChange={(e) => setUrl(e.target.value)}
          // A REAL article, because a placeholder is a suggestion and this one
          // gets typed. `https://example.com/article` 404s, and the bare
          // `example.com` a reader trims it to has no prose on it — so the first
          // run of the template failed with the agent's own
          // "returned no readable text — is the page rendered in JS?", which
          // reads as the template being broken rather than the URL being empty.
          placeholder="https://en.wikipedia.org/wiki/Speech_recognition"
          className="flex-1 rounded-md border px-3 py-2"
        />
        <button type="submit" disabled={pending} className="rounded-md border px-4 py-2">
          {pending ? "Working…" : "Digest"}
        </button>
      </form>

      {error !== undefined && <p className="text-red-600">{error}</p>}

      {/* A run that has not settled says so. `pending` is not derivable from the
          snapshot alone — an id the agent never knew leaves `run` undefined,
          which would otherwise read as "still waiting" forever, and on a reload
          it is also true while the run is being looked up by key. */}
      {pending && <p>{pendingNote(startedHere, run !== undefined)}</p>}

      {/* The run's own narration, newest line only. `lines={1}` is the window;
          everything else — the replay, and the "serves no stream" case that is
          otherwise indistinguishable from "wrote nothing yet" — belongs to the
          component. */}
      <WorkflowProgress runId={run?.runId} lines={1} className="text-sm opacity-70" />

      {/* The counterpart of the `sleep` in `workflows/digest.ts`. Without it the
          only handle on a sleeping run is `cancel`, so "file it now" and "throw
          it away" would be the same button. `wake` answering 0 means the run had
          already moved past its wait, which is why nothing here treats that as a
          failure. */}
      {pending && (
        <button
          type="button"
          onClick={() => void wake()}
          className="self-start rounded-md border px-3 py-1 text-sm"
        >
          File it now
        </button>
      )}

      {run?.status === "failed" && <p className="text-red-600">That one failed: {run.error}</p>}

      {run?.status === "completed" && (
        <article className="flex flex-col gap-3">
          <h2 className="text-xl">{run.output.headline}</h2>
          <ul className="flex list-disc flex-col gap-1 pl-5">
            {run.output.points.map((point) => (
              <li key={point}>{point}</li>
            ))}
          </ul>
          <p className="text-sm opacity-70">Filed {run.output.filedAt}</p>
        </article>
      )}
    </main>
  );
}

page({ name: "Link Digest", component: App });
