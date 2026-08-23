// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser half — a form that starts a run, and a panel that watches one
 * that may outlive the browser by a week.
 *
 * Mounted with `page()` rather than `client()`: there is no session to build, so
 * no socket, no audio graph, no microphone request. `useWorkflowSubmit()` starts
 * the run, follows its STATUS, and hands back the controls bound to it. The API
 * is durable, so the `runId` is the whole state — it survives a reload, another
 * device, or `curl`.
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
  Form,
  page,
  SubmitButton,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowProgress,
} from "@alexkroman1/aai-ui";
import "@alexkroman1/aai-ui/styles.css";
// ERASED at build time, so naming the agent's own type costs the browser bundle
// nothing — and it is what stops this file restating a shape `workflows/
// digest.ts` already declares.
import type { WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import type { dailyDigest } from "./agent.ts";

/** What a completed run reports, derived from the workflow rather than restated. */
type Digest = WorkflowOutputOf<typeof dailyDigest>;

/** The workflow this page drives. Matches the key in `workflowApp({ workflows })`. */
const WORKFLOW = "dailyDigest";

export function App() {
  // The generic is what makes `run.status === "completed"` narrow to a TYPED
  // `run.output` instead of `unknown`. `error` is the agent's own sentence for a
  // rejected input — better copy than anything this page could write, and the
  // reason there is no `try`/`catch` here.
  const { submit, run, pending, error, wake, cancel } = useWorkflowSubmit<Digest>(WORKFLOW);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <h1 className="text-2xl font-medium">Podcast Digest</h1>

      {/* `submit()` resolves as soon as the run EXISTS — deliberately not when it
          finishes, which here could be a month away. */}
      <Form onSubmit={(values) => submit(values)} error={error}>
        <WorkflowFields workflow={WORKFLOW} />
        <SubmitButton pending={pending}>
          {pending ? "Digest scheduled" : "Start digest"}
        </SubmitButton>
      </Form>

      {/* A run that has not settled says so. `pending` is not derivable from the
          snapshot alone — an id the agent never knew leaves `run` undefined,
          which would otherwise read as "still waiting" forever. */}
      {pending && <p>You can close this tab — the run continues without it.</p>}

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

      {run?.status === "failed" && <p className="text-red-600">That run failed: {run.error}</p>}
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
              <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
                {episode.keyPoints.map((point) => (
                  <li key={point}>{point}</li>
                ))}
              </ul>
            </section>
          ))}
        </article>
      )}
    </main>
  );
}

page({ name: "Podcast Digest", component: App });
