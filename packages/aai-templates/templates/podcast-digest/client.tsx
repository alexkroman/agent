// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half — a form that starts a run, and a panel that watches one
 * that may outlive the browser by a week.
 *
 * Mounted with `page()` rather than `client()`: there is no session to build, so
 * no socket, no audio graph, no microphone request. `useWorkflowSubmit()` starts
 * the run, follows its STATUS, and hands back the controls bound to it.
 *
 * ## The `runId` is durable; the PAGE holding it was not
 *
 * This doc used to say the run id "survives a reload, another device, or
 * `curl`", and every word of that is true of the id and none of it was true of
 * this page: the id lived in React state, so a refresh dropped it while a
 * schedule that may run for a month carried on posting. That is the worst case
 * in `templates/` for losing a handle — the other workflow apps lose a wait of
 * minutes, this one loses the only Stop button a thirty-digest commitment has,
 * and the run is invisible from then on to everything but `curl`.
 *
 * A correlation KEY is the handle that survives, and `useWorkflowSubmit` looks
 * that key's newest run up as it mounts, so a later load lands on the same
 * count, the same newest line, and the same Wake and Cancel buttons bound to
 * the same run.
 *
 * **This is the one workflow app that passes a `key` of its own, and it is
 * `useRunKey({ storage: "local" })`.** Its siblings let the hook mint one into
 * `sessionStorage`, which dies with the tab and covers exactly the interruption
 * they have — a reload, a same-tab navigation, a crashed tab. A schedule
 * outlives all of that by design: closing the browser on Tuesday and coming
 * back on Friday to stop it is the ordinary case here, not an edge one, and a
 * tab-scoped key would answer that with an empty form beside a run still
 * posting to somebody's Slack. So the handle is scoped to the BROWSER, which is
 * as far as it can go without a login (`find` has no per-user filtering; the
 * key is the whole scoping mechanism) — and no further:
 *
 * - **Not the page's own URL.** A `?key=` parameter is pasted into chats,
 *   copied into referrers and kept in history, and what a leaked one buys here
 *   is not just reading the digest: it is `cancel()` on somebody's schedule,
 *   and a completed run's output NAMES the delivery target it has been posting
 *   to.
 * - **Not derived from the feeds or the webhook.** Two people watching the same
 *   show would recover each other's schedules, and a key derived from a webhook
 *   URL would carry a credential into a lookup token — which is why the
 *   platform stopped writing keys to the operator's log.
 *
 * A real app with accounts passes the account's own id as `key` instead, and
 * then the schedule follows the person to a new device — a promise only a login
 * can keep.
 *
 * ## The form is DECLARED, not written
 *
 * Every property of this workflow's input schema is a scalar, so
 * `<WorkflowFields>` renders the whole form from what `GET /workflows` serves —
 * a `<SelectField>` for the `z.enum`, number spinners for the counts, the
 * `.describe()` text as each hint, and the `.default()` as each control's
 * starting value. Adding an eighth field to `agent.ts` adds an eighth control
 * here with no edit to this file, and the defaults are stated once, in the
 * schema, rather than here AND in the schema AND in the workflow body.
 *
 * `link-digest` is the page that writes its one control by hand, deliberately,
 * so a reader can see what this layer stands on. `redline` is the MIXED case —
 * declared scalars beside one hand-written array field.
 *
 * ## What a SCHEDULED run adds to `link-digest`'s page
 *
 * Two controls that only make sense when a run spends most of its life asleep,
 * and both are the point of copying this file rather than that one:
 *
 * - **Wake.** A sleeping run's next digest is hours or days out. `wake()` cuts
 *   the wait short and sends it now. Without it the only handle on a sleeping
 *   run is `cancel`, so "send it now" and "throw it away" would be the same
 *   button. `wake` answering 0 means the run had already moved past its sleep,
 *   which is why nothing here treats that as a failure.
 * - **Cancel.** A run scheduled for thirty digests is a standing commitment, and
 *   the page that started it is the obvious place to end it. Cancelling is why
 *   `daysToRun` can be generous.
 *
 * Both are bound to the run the submission is following, which is the whole
 * reason this page no longer holds a `createWorkflowApi()` of its own.
 *
 * ## Why the status panel reads `digestsSent` and not a progress bar
 *
 * There is nothing to fill. A run posts digest 3 of 7 and then sleeps for a day
 * — a bar would sit at 43% looking stalled for most of the run's life. The
 * honest display is the count plus the run's own newest line.
 */

import {
  BulletList,
  Form,
  page,
  SubmitButton,
  useRunKey,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
} from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/
// digest.ts` already declares.
import type { dailyDigest } from "./agent.ts";

/** The workflow this page drives. Matches the key in `workflowApp({ workflows })`. */
const WORKFLOW = "dailyDigest";

/**
 * What the page says while a schedule is live — three situations, one line
 * each, and none of them the sentence this page used to print.
 *
 * That one was "You can close this tab — the run continues without it": true
 * about the run and false about the page, which is the worst shape a
 * reassurance can have. The run did continue, for up to a month, and nothing
 * could name it again. Now the promise can be stronger AND narrower — this
 * browser, not any tab anywhere — and the load that did not press the button
 * gets its own words, because a schedule appearing in front of somebody is owed
 * an explanation.
 */
function pendingNote(startedHere: boolean, found: boolean): string {
  if (startedHere)
    return "You can close this tab — the digest keeps posting, and this browser will find it again.";
  if (!found) return "Looking for a schedule this browser started earlier…";
  return "This is a schedule this browser started earlier. It is still posting.";
}

export function App() {
  // This BROWSER's handle on its schedules — minted once and kept for as long
  // as storage lives for this origin, which is the option this template exists
  // to argue for. See the module doc.
  const key = useRunKey({ storage: "local" });
  // Did THIS load start the schedule? A later load cannot have, and that is the
  // only way the page can tell "scheduled just now" from "still running from
  // Tuesday" — the hook reports the run, not who asked for it.
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. `error` is the agent's own sentence for a
  // rejected input — better copy than anything this page could write, and the
  // reason there is no `try`/`catch` here.
  // The key REPLACES the tab-scoped one the hook would mint; the lookup that
  // reads it back on the next load happens either way.
  const { submitForm, run, pending, error, wake, cancel, startedHere } = useWorkflowSubmit<
    typeof dailyDigest
  >(WORKFLOW, { key });

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-medium">Podcast Digest</h1>

      {/* `submit()` resolves as soon as the run EXISTS — deliberately not when it
          finishes, which here could be a month away. */}
      <Form onSubmit={(values) => submitForm(values)} error={error}>
        <WorkflowFields workflow={WORKFLOW} />
        <SubmitButton pending={pending}>
          {pending ? "Digest scheduled" : "Start digest"}
        </SubmitButton>
      </Form>

      {/* A run that has not settled says so. `pending` is not derivable from the
          snapshot alone — an id the agent never knew leaves `run` undefined,
          which would otherwise read as "still waiting" forever, and on a later
          load it is also true while the schedule is being looked up by key. */}
      {pending && <p>{pendingNote(startedHere, run !== undefined)}</p>}

      {/* The run's own narration, newest line only. `lines={1}` is the window;
          everything else — the replay, and the "serves no stream" case that is
          otherwise indistinguishable from "wrote nothing yet" — belongs to the
          component. */}
      <WorkflowProgress runId={run?.runId} lines={1} className="text-sm opacity-70" />

      {pending && (
        <div className="flex gap-2">
          {/* The counterpart of the `sleep` in `workflows/digest.ts` — see the
              module doc on why a scheduled run needs this AND cancel. */}
          <button
            type="button"
            onClick={() => void wake()}
            className="rounded-md border px-3 py-1 text-sm"
          >
            Send the next digest now
          </button>
          <button
            type="button"
            onClick={() => void cancel()}
            className="rounded-md border px-3 py-1 text-sm text-red-600"
          >
            Stop the schedule
          </button>
        </div>
      )}

      {/* `role="alert"`, the same contract `<Form>` gives the submit error
          above: a digest that fails does so days later, with nobody watching. */}
      {run?.status === "failed" && (
        <p role="alert" className="text-red-600">
          That run failed: {run.error}
        </p>
      )}
      {run?.status === "cancelled" && <p>Cancelled — no further digests will be posted.</p>}

      {run?.status === "completed" && (
        <article className="flex flex-col gap-4">
          <p className="text-sm opacity-70">
            Posted {run.output.digestsSent} of {run.output.digestsScheduled} digests to{" "}
            {run.output.deliveryTarget}, every {run.output.scheduleInterval}.
          </p>
          {run.output.lastDigest?.episodes.map((episode) => (
            <section key={episode.id} className="flex flex-col gap-1 border-t pt-3">
              <p className="text-sm opacity-70">{episode.podcastTitle}</p>
              <h2 className="text-lg">
                <a href={episode.url} className="underline">
                  {episode.title}
                </a>
              </h2>
              <p>{episode.summary}</p>
              <BulletList items={episode.keyPoints} size="sm" />
            </section>
          ))}
        </article>
      )}
    </main>
  );
}

page({ name: "Podcast Digest", component: App });
