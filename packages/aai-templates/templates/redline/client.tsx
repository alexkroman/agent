/**
 * The redline desk's page: a form, the loop turning, and the piece it produced.
 *
 * `link-digest` shows the workflow primitives raw and `transcription-workflow` shows
 * the form layer over them; this page is the MIXED case, which is what most real
 * schemas need and what neither of those has.
 *
 * ## Half of this form is declared and half is written
 *
 * `<WorkflowFields>` renders one control per SCALAR property of the workflow's
 * own input schema, read from `GET /workflows` — so the brief, the audience
 * picker (a `<SelectField>`, because `agent.ts` declares a `z.enum`) and the
 * rounds spinner exist here because of what the schema says, and adding a fourth
 * scalar adds a fourth control with no edit to this file.
 *
 * It renders nothing for `mustCover`, deliberately: that property is an ARRAY,
 * and there is no honest generic control for one. So this page writes that field
 * itself — a plain `<TextAreaField>` in the same `<Form>`, one point per line —
 * and maps it on submit. Every field in `@alexkroman1/aai-ui` is a plain named
 * control, which is what lets the declared and the hand-written ones sit
 * together and arrive as one object.
 *
 * The mapping is the other half of that: `<Form>` collects what the DOM holds,
 * and a textarea holds a string where the workflow's schema wants `string[]`.
 * `toInput` is where the two meet — and it is the only place, so the split lives
 * in one function rather than in the field, the submit handler and the workflow.
 *
 * ## A reload used to lose the loop, which is minutes of model calls
 *
 * A `runId` names a run for as long as something holds it, and this page held it
 * in React state — so a refresh lost it while the loop carried on writing,
 * grading and revising without anywhere to report to. On a desk whose whole
 * subject is a loop that runs several long-form model calls, that is the one
 * failure the hook now covers on its own: `useWorkflowSubmit` records every run
 * under a correlation KEY it mints for this page and asks for that key's newest
 * run as it mounts, so the draft, the critique trail and the Clear button are
 * all there again with nothing written here.
 *
 * **The key it mints is opaque and lives in `sessionStorage`, and the brief is
 * why this page wants exactly that one.** A
 * `?key=` parameter in the page's own URL would survive more — a new tab, a
 * bookmark, a link sent to the person who asked for the piece — and that is
 * exactly what it must not do here. There is no per-user filtering behind
 * `find`, so the key IS the scoping mechanism, and a brief is the most private
 * thing on this page: it is what somebody typed about their own product, their
 * own incident or their own customers, and the critique trail beside it is
 * working material nobody writes expecting an audience. The thing worth sending
 * a colleague is the DRAFT, which is text on the page and travels by being
 * copied; sending a run means sending the brief that produced it.
 *
 * Deriving the key from the brief is worse again: two people briefing the same
 * thing would recover each other's runs, and the key would then carry what they
 * typed into a lookup token the platform deliberately stopped logging. Both are
 * things a page could still ask for by passing its own `key`, and this one has
 * no reason to.
 */

import "@alexkroman1/aai-ui/styles.css";
import { plural } from "@alexkroman1/aai/utils";
import type { WorkflowInputOf, WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import {
  BulletList,
  Facts,
  Form,
  type FormValues,
  mountPage,
  SubmitButton,
  TextAreaField,
  useWorkflowSubmit,
  WORKFLOW_STATUS_LABELS,
  WorkflowFields,
  WorkflowProgress,
  type WorkflowRun,
} from "@alexkroman1/aai-ui";
import type { redline } from "./agent.ts";

/**
 * What a finished run reports.
 *
 * Derived from the workflow declaration rather than restated — `import type` is
 * erased, so naming `redline` here bundles none of the agent, the SDK, or the
 * workflow body into this page.
 */
type Redline = WorkflowOutputOf<typeof redline>;

/** The workflow this page drives. Matches the key in `workflowApp({ workflows })`. */
const WORKFLOW = "redline";

/**
 * What the desk says while the loop is turning — three situations, one line
 * each.
 *
 * The reload case gets its own words deliberately: somebody who did not press
 * the button is owed an explanation for a draft appearing in front of them, and
 * the sentence a page reaches for instead ("you can close this tab") is the one
 * that was true about the RUN and false about the page.
 */
function pendingNote(startedHere: boolean, found: boolean): string {
  if (startedHere) return "Reloading is safe — this page will find the draft again.";
  if (!found) return "Looking for a draft this tab started earlier…";
  return "Still working on a draft this tab started earlier.";
}

/**
 * The submitted form as the workflow's input schema wants it.
 *
 * One function, because the textarea-to-array split is exactly the kind of
 * thing that otherwise gets half-done in three places. Blank lines go, so a
 * trailing newline is not a requirement to cover "".
 */
export function toInput(values: FormValues): WorkflowInputOf<typeof redline> {
  const raw = typeof values.mustCover === "string" ? values.mustCover : "";
  // The scalars ride through as the form collected them — strings from the DOM,
  // which the WORKFLOW's schema coerces and validates server-side. Only
  // `mustCover` is reshaped here, because no control renders a `string[]`.
  // The assertion is on the scalars alone and is what `submitForm` exists to
  // avoid needing anywhere a page is not doing this reshaping deliberately.
  return {
    ...(values as Omit<WorkflowInputOf<typeof redline>, "mustCover">),
    mustCover: raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

function RedlineDesk() {
  // The reload is covered by the hook's own key — see the module doc for why
  // this desk wants the tab-scoped one it mints rather than a key of its own.
  const { submit, run, pending, error, reset, startedHere } =
    useWorkflowSubmit<typeof redline>(WORKFLOW);

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Redline</h1>
        <p className="text-sm opacity-70">
          Give it a brief. It writes a draft, grades the draft against the brief, revises, and goes
          round again until the critic would ship it or the rounds run out.
        </p>
      </header>

      <Form onSubmit={(values) => submit(toInput(values))} error={error}>
        {/* The scalars: brief, audience, rounds. Declared, not written. */}
        <WorkflowFields workflow={WORKFLOW} />
        {/* The array the schema declares and no generic control can render. */}
        <TextAreaField
          name="mustCover"
          label="Must cover"
          hint="One point per line. Leave empty if nothing is required."
          rows={3}
        />
        <SubmitButton pending={pending}>Write it</SubmitButton>
      </Form>

      {/* `pending` covers the RUN rather than the request, and on a reload it is
          also true while the run is being looked up by key — the stretch where a
          form offering Submit would be inviting a second loop over the same
          brief, which here is several long-form model calls of somebody's
          money. */}
      {pending && (
        <p className="text-sm opacity-70">{pendingNote(startedHere, run !== undefined)}</p>
      )}

      {run && (
        <RunPanel
          run={run}
          onClear={() => {
            // The recovered run is dismissed as deliberately as one this load
            // started: `reset()` is not undone by a second lookup (the lookup
            // is a mount-time act), so Clear really does clear.
            reset();
          }}
        />
      )}
    </main>
  );
}

/** The critique trail: what each round objected to, and what the score was. */
function Rounds({ rounds }: { rounds: Redline["rounds"] }) {
  if (rounds.length === 0) return null;
  return (
    <ol className="flex flex-col gap-3">
      {rounds.map((entry) => (
        <li key={entry.round} className="flex flex-col gap-1 border-l pl-4">
          <Facts
            size="xs"
            className="uppercase tracking-[1.2px]"
            items={[
              `Round ${entry.round}`,
              `${entry.critique.score}/10`,
              entry.critique.verdict === "ship" ? "ship it" : "revise",
            ]}
          />
          <BulletList items={entry.critique.notes} size="sm" />
        </li>
      ))}
    </ol>
  );
}

/** The run's status, its narration, its critique trail, and the piece. */
function RunPanel({ run, onClear }: { run: WorkflowRun<Redline>; onClear: () => void }) {
  return (
    <section className="flex flex-col gap-4 rounded-md border p-5">
      <div className="flex items-baseline justify-between gap-4">
        <h2 className="text-sm font-medium uppercase tracking-[1.2px]">
          {STATUS_LINE[run.status]}
        </h2>
        <button type="button" onClick={onClear} className="text-xs underline opacity-60">
          Clear
        </button>
      </div>

      {/* The run's own narration — the complement of the status line, which is
          `running` for a run's whole life, so a one-round redline and a
          three-round one look identical while they happen. These lines come from
          the run itself (`stepReport()` in `workflows/redline.ts`), and they REPLAY,
          so a reload mid-run catches up rather than starting from whatever
          arrives next. */}
      <WorkflowProgress runId={run.runId} />

      {/* Discriminated on `status`, so `output` and `error` are reachable
          without a cast. */}
      {run.status === "completed" && (
        <>
          {/* Which of the two stop conditions ended the loop is the one thing a
              reader cannot infer from the round count alone, so it is a fact of
              its own rather than something left to the round count. */}
          <Facts
            size="xs"
            items={[
              `${run.output.words} words`,
              `${run.output.roundsRun} ${plural(run.output.roundsRun, "round")}`,
              run.output.shipped ? "the critic stopped it" : "the round budget stopped it",
            ]}
          />
          <Rounds rounds={run.output.rounds} />
          <article className="whitespace-pre-wrap text-sm leading-relaxed">
            {run.output.draft}
          </article>
        </>
      )}
      {/* `role="alert"`, the same contract `<Form>` gives the submit error: this
          is the outcome the reader waited minutes for. */}
      {run.status === "failed" && (
        <p role="alert" className="text-red-600">
          {run.error}
        </p>
      )}
    </section>
  );
}

/**
 * One line describing where a run has got to.
 *
 * The SDK's map with the one label this desk wants differently: `running` is
 * "Writing…" here because that is what the run is doing. Spreading a COMPLETE
 * `Record<WorkflowRunStatus, string>` cannot drop a key, so the exhaustiveness
 * the hand-written copy was written for survives — and now lives at the SDK
 * boundary, where a status added upstream is one compile error rather than one
 * per page.
 */
const STATUS_LINE = { ...WORKFLOW_STATUS_LABELS, running: "Writing…" };

mountPage({ name: "Redline", component: RedlineDesk });
