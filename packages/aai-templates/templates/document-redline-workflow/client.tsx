/**
 * The redline desk's page: a form, the loop turning, and the piece it produced.
 *
 * `link-digest-workflow` shows the workflow primitives raw and `transcription-workflow` shows
 * the form layer over a schema of scalars; this page is the MIXED case, which is
 * what most real schemas need.
 *
 * ## The whole form is declared, non-scalars included
 *
 * `<WorkflowFields>` renders one control per property of the workflow's own
 * input schema, read from `GET /workflows` — so the brief, the audience picker
 * (a `<SelectField>`, because `agent.ts` declares a `z.enum`) and the rounds
 * spinner exist here because of what the schema says, and adding a fourth
 * scalar adds a fourth control with no edit to this file.
 *
 * Two of the properties are not scalars, and both still render, because each
 * is one of the two non-scalar shapes with an honest generic control:
 *
 * - `mustCover` is an array of strings → a `<TextAreaField split="lines">`,
 *   one required point per line, contributing a `string[]`.
 * - `source` is an object of exactly `{ name, text }` → a
 *   `<FileField as="namedText">`, which reads the chosen file in the BROWSER
 *   and contributes its name beside its text — no upload, no id, nothing for
 *   the run to fetch. That is the right trade for a draft of a few kilobytes
 *   and the wrong one for a recording; `transcription-workflow` is the other
 *   case (`uploads: [...]` on the declaration, `stepReadUpload` at the far end).
 *
 * So the values `<Form>` collects already match the input schema, and
 * `submitForm` hands them over as they are. A shape outside those two — a
 * nested object, an array of objects — is where a page writes its own control
 * inside the same `<Form>`, since every field in `@alexkroman1/aai-ui` is a
 * plain named control.
 *
 * ## A reload used to lose the loop, which is minutes of model calls
 *
 * A `runId` names a run for as long as something holds it, and this page held it
 * in React state — so a refresh lost it while the loop carried on writing,
 * grading and revising without anywhere to report to. `useWorkflowSubmit`
 * records every run under a correlation KEY it mints for this page and asks for
 * that key's newest run as it mounts, so the draft, the critique trail and the
 * Clear button are all there again with nothing written here.
 *
 * **The key it mints is opaque and lives in `sessionStorage`, and the brief is
 * why this page wants exactly that one.** A `?key=` parameter in the page's own
 * URL would survive more — a new tab, a bookmark, a link sent to the person who
 * asked for the piece — and that is exactly what it must not do here. There is
 * no per-user filtering behind `find`, so the key IS the scoping mechanism, and
 * a brief is the most private thing on this page: it is what somebody typed
 * about their own product, their own incident or their own customers. The thing
 * worth sending a colleague is the DRAFT, which is text on the page and travels
 * by being copied.
 */

import "@alexkroman1/aai-ui/styles.css";
import { plural } from "@alexkroman1/aai/utils";
import type { WorkflowDefOf, WorkflowOutputOf } from "@alexkroman1/aai/workflow-api";
import {
  BulletList,
  Facts,
  Form,
  Markdown,
  mountPage,
  SubmitButton,
  useWorkflowSubmit,
  WorkflowFields,
  WorkflowPendingNote,
  WorkflowRunPanel,
} from "@alexkroman1/aai-ui";
import type agentDef from "./agent.ts";

/**
 * What a finished run reports.
 *
 * Derived from the agent's declaration rather than restated — `import type` is
 * erased, so naming the agent here bundles none of it, the SDK, or the
 * workflow body into this page — and the NAME is checked against its
 * `workflows` map.
 */
type Redline = WorkflowOutputOf<WorkflowDefOf<typeof agentDef, "redline">>;

function RedlineDesk() {
  // The reload is covered by the hook's own key — see the module doc for why
  // this desk wants the tab-scoped one it mints rather than a key of its own.
  const submission = useWorkflowSubmit<typeof agentDef>("redline");
  const { submitForm, run, pending, error, reset } = submission;

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-8 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">Redline</h1>
        <p className="text-sm opacity-70">
          Give it a brief. It writes a draft, grades the draft against the brief, revises, and goes
          round again until the critic would ship it or the rounds run out.
        </p>
      </header>

      <Form onSubmit={(values) => submitForm(values)} error={error}>
        {/* Every control, non-scalars included — see the module doc. */}
        <WorkflowFields<typeof agentDef> workflow="redline" />
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
