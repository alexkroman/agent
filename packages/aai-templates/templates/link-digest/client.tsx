// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half of a workflow app.
 *
 * Mounted with `mountPage()` rather than `mountClient()`: there is no session to build, so
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
 * doing" from what the run wrote itself (`stepReport()` in `workflows/digest.ts`). A
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
 *
 * ## Two things that are only ever true for a MOMENT
 *
 * The Copy button and the reply to "File it now" are both a word that appears
 * and then goes away, and both used to be the sort of thing a page writes with
 * a `useState` and a bare `setTimeout` — which gets two things wrong that only
 * show up on the second click (a second flash has its window cut short by the
 * first one's timer) and on unmount (a `setState` into a torn-down tree). They
 * are `useCopy` and `useFlash` from `@alexkroman1/aai-ui`.
 *
 * Reach for `useCopy` when the moment is a clipboard write — it keys the flash
 * by the copied TEXT, so on a page with several copy buttons only the one
 * clicked lights up, and it reports a REFUSED write as `"Failed"` rather than
 * doing nothing visible (there is no clipboard at all on an insecure origin).
 * Reach for `useFlash` for any other transient word; here it carries what
 * `wake()` answered, which is a number and not a failure at 0.
 */

import {
  BulletList,
  mountPage,
  useCopy,
  useFlash,
  useWorkflowSubmit,
  WorkflowProgress,
} from "@alexkroman1/aai-ui";
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

/** The digest as one pasteable block — a headline and its bullets. */
function asText(headline: string, points: readonly string[]): string {
  return [headline, ...points.map((point) => `- ${point}`)].join("\n");
}

export function App() {
  const [url, setUrl] = useState("");
  // One copier for the page. It would be one per GROUP of copy buttons on a
  // bigger page — the flash is shared, so clicking a second row clears the
  // first row's "Copied", which is what stops two rows both claiming to be on
  // the clipboard.
  const copier = useCopy();
  // `wake()` resolves with how many sleeps it ended, and 0 is an ANSWER (the
  // run had already moved past its wait) rather than a failure — so the button
  // says which happened, for a moment, and then goes back to being a button.
  const woken = useFlash<string>();
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. `error` is the agent's own sentence for a
  // rejected input, which is better copy than anything this page could write, and
  // `wake` is bound to whatever run the hook is following — the whole reason this
  // page no longer holds a `createWorkflowApi()` of its own.
  // No `key` and no `recover`: this tab's handle on its own runs is minted and
  // remembered by the hook, and read back as it mounts. See the module doc for
  // what a page says when it wants a different one.
  const { submit, run, pending, error, wake, startedHere } =
    useWorkflowSubmit<typeof digest>("digest");

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
          // A placeholder is not a name: it disappears the moment anything is
          // typed, and a screen reader reaches an unlabelled box. The declared
          // fields in `@alexkroman1/aai-ui` say the same thing — a `label`, or
          // an `aria-label` where the row has no room for one.
          aria-label="Article URL"
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

      {/* `<Form>` carries `role="alert"` for the templates that declare their
          fields; a hand-written form has to say it itself. */}
      {error !== undefined && (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}

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
          onClick={() => {
            void wake().then((count) =>
              woken.flash(count > 0 ? "Filing it now" : "Already past its wait"),
            );
          }}
          className="self-start rounded-md border px-3 py-1 text-sm"
        >
          {woken.value ?? "File it now"}
        </button>
      )}

      {/* `role="alert"`, like the submit error above: this is the outcome the
          reader has been waiting for, and it can arrive long after they looked
          away. */}
      {run?.status === "failed" && (
        <p role="alert" className="text-red-600">
          That one failed: {run.error}
        </p>
      )}

      {run?.status === "completed" && (
        <article className="flex flex-col gap-3">
          <h2 className="text-xl">{run.output.headline}</h2>
          <BulletList items={run.output.points} />
          <p className="text-sm opacity-70">Filed {run.output.filedAt}</p>
          {/* The whole digest as plain text, which is what somebody pasting it
              into a note wants. `copier.label` is the button's own text: it
              reads "Copy" until it is clicked, then "Copied" — or "Failed",
              which is the case a hand-rolled version silently drops. */}
          <button
            type="button"
            onClick={() => copier.copy(asText(run.output.headline, run.output.points))}
            className="self-start rounded-md border px-3 py-1 text-sm"
          >
            {copier.label(asText(run.output.headline, run.output.points))}
          </button>
        </article>
      )}
    </main>
  );
}

mountPage({ name: "Link Digest", component: App });
