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
 * and `reset`. The API is durable, so the `runId` is the whole state — it
 * survives a reload, a different device, or `curl`.
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
 * catches up rather than starting from whatever arrives next. `lines={1}` is
 * what narrows it to the newest line, because on a page this small that is the
 * whole of what a status wants; `transcription-workflow` renders the full log,
 * where a fan-out makes the history worth seeing.
 */

import { page, useWorkflowSubmit, WorkflowProgress } from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/
// digest.ts` already declares.
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import { useState } from "react";
import type { digest } from "./agent.ts";

/** What a completed run reports, derived from the workflow rather than restated. */
type Digest = WorkflowOutputOf<typeof digest>;

export function App() {
  const [url, setUrl] = useState("");
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. `error` is the agent's own sentence for a
  // rejected input, which is better copy than anything this page could write, and
  // `wake` is bound to whatever run the hook is following — the whole reason this
  // page no longer holds a `createWorkflowApi()` of its own.
  const { submit, run, pending, error, wake } = useWorkflowSubmit<Digest>("digest");

  // `submit()` resolves as soon as the run exists — deliberately not when it
  // finishes. That is the whole mechanism: the digest sleeps for a while, and
  // this page is free to be closed in the meantime.
  const onSubmit = (event: React.FormEvent) => {
    event.preventDefault();
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
          which would otherwise read as "still waiting" forever. */}
      {pending && <p>You can close this tab — the run continues without it.</p>}

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
