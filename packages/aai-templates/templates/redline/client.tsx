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
 * It renders nothing for `mustCover` or `source`, deliberately: one is an ARRAY
 * and the other an OBJECT, and there is no honest generic control for either. So
 * this page writes those two itself — a `<TextAreaField>` taking one required
 * point per line, and a `<FileField read="text">` taking a draft to mark up —
 * in the same `<Form>`, and maps them on submit. Every field in
 * `@alexkroman1/aai-ui` is a plain named control, which is what lets the declared
 * and the hand-written ones sit together and arrive as one object.
 *
 * The mapping is the other half of that: `<Form>` collects what the DOM holds,
 * and a textarea holds a string where the workflow's schema wants `string[]`,
 * while a file input holds a `FileValue` where it wants `{ name, text }`.
 * `toInput` is where all of that meets — and it is the only place, so the split
 * lives in one function rather than in the field, the submit handler and the
 * workflow.
 *
 * **A `<FileField>` does not imply an upload, and choosing wrong is the trap.**
 * `read="text"` reads the chosen file in the browser and contributes its text
 * with the rest of the form, so a draft is journaled with the run's input and
 * there is nothing to fetch, nothing to expire and nothing to clean up. The
 * upload path (`uploads: [...]` on the declaration, a `File` contributed unread,
 * `stepReadUpload` at the far end) exists because a two-hour recording cannot go
 * in a run's input at all — see `transcription-workflow`. A few kilobytes of
 * prose is the case that does not need it.
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
  FileField,
  type FileValue,
  Form,
  type FormValues,
  Markdown,
  mountPage,
  SubmitButton,
  TextAreaField,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowPendingNote,
  WorkflowRunPanel,
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
export function toInput(values: FormValues): WorkflowInputOf<typeof redline> {
  const raw = typeof values.mustCover === "string" ? values.mustCover : "";
  // The scalars ride through as the form collected them — strings from the DOM,
  // which the WORKFLOW's schema coerces and validates server-side. Only the two
  // NON-scalars are reshaped here, because they are exactly the two no generic
  // control renders. The assertion is on the scalars alone and is what
  // `submitForm` exists to avoid needing anywhere a page is not doing this
  // reshaping deliberately.
  const source = attachedDraft(values.source);
  return {
    ...(values as Omit<WorkflowInputOf<typeof redline>, "mustCover" | "source">),
    mustCover: raw
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0),
    // Spread rather than `source: source` — the schema's `.optional()` means
    // ABSENT, and an explicit `undefined` is a different thing to both
    // `exactOptionalPropertyTypes` and a validator.
    ...(source ? { source } : {}),
  };
}

/**
 * The chosen file as the schema's `source`, or nothing at all.
 *
 * `<FileField read="text">` contributes a {@link FileValue} — the file's
 * metadata plus its text, read in the BROWSER — and contributes no key at all
 * when nothing was chosen, which is why this takes `unknown` and why the absent
 * case is the ordinary one rather than an error. Nothing is uploaded: a draft is
 * a few kilobytes of prose that belongs in the run's input, where it is
 * journaled and replayed with everything else. A RECORDING is the other case,
 * and `transcription-workflow` is where it is answered.
 */
export function attachedDraft(value: unknown): { name: string; text: string } | undefined {
  const file = value as FileValue | undefined;
  if (file === undefined || typeof file.content !== "string") return undefined;
  // Passed through UNTRIMMED, deliberately: a file somebody chose is a file they
  // meant to redline, so an empty one has to come back as the schema refusing it
  // by name rather than as a draft written from scratch that they did not ask
  // for. It is the same layering as `brief` — the schema counts characters, and
  // `acceptDraft` catches what that cannot see.
  return { name: file.name, text: file.content };
}

function RedlineDesk() {
  // The reload is covered by the hook's own key — see the module doc for why
  // this desk wants the tab-scoped one it mints rather than a key of its own.
  const submission = useWorkflowSubmit<typeof redline>(WORKFLOW);
  const { submit, run, pending, error, reset } = submission;

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
        {/* The two the schema declares and no generic control can render: an
            array, and an object. Written here, mapped in `toInput`. */}
        <TextAreaField
          name="mustCover"
          label="Must cover"
          hint="One point per line. Leave empty if nothing is required."
          rows={3}
        />
        {/* `read="text"` reads the file in the BROWSER and contributes its text
            with the rest of the form — no upload, no id, nothing for the run to
            fetch. That is the right trade for a draft and the wrong one for a
            recording; `transcription-workflow` is the other case. */}
        <FileField
          name="source"
          label="Start from a draft"
          hint="Optional. A .md or .txt file to redline instead of writing one from the brief."
          read="text"
          accept=".md,.markdown,.txt,text/plain,text/markdown"
        />
        <SubmitButton pending={pending}>Write it</SubmitButton>
      </Form>

      {/* `pending` covers the RUN rather than the request, and on a reload it is
          also true while the run is being looked up by key — the stretch where a
          form offering Submit would be inviting a second loop over the same
          brief, which here is several long-form model calls of somebody's
          money. */}
      <WorkflowPendingNote submission={submission} subject="draft" />

      {/* The SDK's run panel: the status line, Clear, the run's own narration
          (the complement of the status line — `running` for a run's whole life,
          so a one-round redline and a three-round one look identical without
          the `stepReport()` lines from `workflows/redline.ts`, which REPLAY on a
          reload), the piece once there is one, and the announced error. The
          one word this desk wants differently is `running`: "Writing…" is what
          the run is doing, and the SDK does not know that. */}
      {run && (
        <WorkflowRunPanel
          run={run}
          statusLabels={{ running: "Writing…" }}
          onClear={() => {
            // The recovered run is dismissed as deliberately as one this load
            // started: `reset()` is not undone by a second lookup (the lookup
            // is a mount-time act), so Clear really does clear.
            reset();
          }}
        >
          {(output) => (
            <>
              {/* Which of the two stop conditions ended the loop is the one thing
                  a reader cannot infer from the round count alone, so it is a
                  fact of its own rather than something left to the round count. */}
              <Facts
                size="xs"
                items={[
                  `${output.words} words`,
                  `${output.roundsRun} ${plural(output.roundsRun, "round")}`,
                  output.shipped ? "the critic stopped it" : "the round budget stopped it",
                  // A false entry is dropped, so this row says which way in the
                  // run took only when there is something to say.
                  output.source !== undefined && `redlined from ${output.source}`,
                ]}
              />
              <Rounds rounds={output.rounds} />
              {/* `<Markdown>` rather than a `whitespace-pre-wrap` block, which is
                  what stood here and rendered a `**` as two asterisks. The writer
                  is told to return prose and no headings unless the brief asks
                  for them — "unless" is the operative word, and an attached draft
                  is somebody's own file and obeys nothing at all. */}
              <Markdown text={output.draft} />
            </>
          )}
        </WorkflowRunPanel>
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

mountPage({ name: "Redline", component: RedlineDesk });
