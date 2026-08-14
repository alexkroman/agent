/**
 * The redline desk's page: a form, the loop turning, and the piece it produced.
 *
 * `link-digest` shows the workflow primitives raw and `transcription-desk` shows
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
 */

import "@alexkroman1/aai-ui/styles.css";
import type { WorkflowOutputOf } from "@alexkroman1/aai";
import {
  Form,
  type FormValues,
  page,
  SubmitButton,
  TextAreaField,
  useWorkflowSubmit,
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
 * The submitted form as the workflow's input schema wants it.
 *
 * One function, because the textarea-to-array split is exactly the kind of
 * thing that otherwise gets half-done in three places. Blank lines go, so a
 * trailing newline is not a requirement to cover "".
 */
export function toInput(values: FormValues): FormValues {
  const raw = typeof values.mustCover === "string" ? values.mustCover : "";
  return {
    ...values,
    mustCover: raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
  };
}

function RedlineDesk() {
  const { submit, run, pending, error, reset } = useWorkflowSubmit<Redline>(WORKFLOW);

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

      {run && <RunPanel run={run} onClear={reset} />}
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
          <p className="text-xs uppercase tracking-[1.2px] opacity-60">
            Round {entry.round} · {entry.critique.score}/10 ·{" "}
            {entry.critique.verdict === "ship" ? "ship it" : "revise"}
          </p>
          <ul className="flex list-disc flex-col gap-1 pl-5 text-sm">
            {entry.critique.notes.map((note) => (
              <li key={note}>{note}</li>
            ))}
          </ul>
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
          the run itself (`report()` in `workflows/redline.ts`), and they REPLAY,
          so a reload mid-run catches up rather than starting from whatever
          arrives next. */}
      <WorkflowProgress runId={run.runId} />

      {/* Discriminated on `status`, so `output` and `error` are reachable
          without a cast. */}
      {run.status === "completed" && (
        <>
          <p className="text-xs opacity-60">
            {run.output.words} words · {run.output.roundsRun} round
            {run.output.roundsRun === 1 ? "" : "s"} ·{" "}
            {/* Which of the two stop conditions ended the loop is the one thing
                a reader cannot infer from the round count alone. */}
            {run.output.shipped ? "the critic stopped it" : "the round budget stopped it"}
          </p>
          <Rounds rounds={run.output.rounds} />
          <article className="whitespace-pre-wrap text-sm leading-relaxed">
            {run.output.draft}
          </article>
        </>
      )}
      {run.status === "failed" && <p className="text-red-600">{run.error}</p>}
    </section>
  );
}

/**
 * One line describing where a run has got to.
 *
 * A `Record` keyed by the status union rather than a switch, so a status added
 * to the SDK is a compile error here instead of falling through a `default:`.
 */
const STATUS_LINE: Record<WorkflowRun["status"], string> = {
  pending: "Queued",
  running: "Writing…",
  completed: "Done",
  failed: "Failed",
  cancelled: "Cancelled",
};

page({ name: "Redline", component: RedlineDesk });
