// Copyright 2026 the AAI authors. MIT license.
// The API pane's form card: every control a page can carry, and what an HTTP
// caller sends instead of using it.
//
// **The gap this closes.** A workflow app's front door is a FORM, and the pane
// documented the form's destination — `POST /workflows/runs`, with a generated
// body — while leaving the correspondence to inference: that one control is one
// property of `input`, which control a declared property renders as, and that
// exactly one of them is not a value at all. A reader looking at a page with
// six fields and a run body with six properties could work most of it out, and
// the one place inference reliably fails is the file: an upload property is a
// plain string in the schema, so the generated body reads as "type the
// recording here" for the one field where the caller has two calls to make.
//
// **Every control is listed, even the ones this agent declares nothing of.**
// That is deliberately the opposite of the rule the rest of the pane follows
// (show only what is true for the agent in front of you — no carrier webhook
// for a workflow app, no workflow routes for an agent that declares none). The
// vocabulary IS the answer to "what can I send this thing", and a table that
// dropped `<CheckboxField>` because today's schema has no boolean would teach
// that the API cannot take one. What is generated is the EXAMPLE on each row —
// this agent's own property and its own sampled value where it has one of that
// shape — and each row says which of the two it is showing, because a
// placeholder presented as a real field name is how somebody pastes a 400.

import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { Examples } from "./docs-examples.tsx";
import { fieldSnippets } from "./docs-field-snippets.ts";
import { type FormElementDoc, fieldsWorkflow, formElements } from "./docs-form-fields.ts";
import { Card } from "./settings-card.tsx";

/**
 * One control: what a page renders, what the schema says, and the JSON.
 *
 * The JSON line leads with the property name because that is what a reader is
 * matching against the run body they just read — and it is either this
 * deployment's own property or an example, which the trailing note distinguishes
 * rather than leaving to the reader's assumption.
 */
function ElementRow({ row }: { row: FormElementDoc }) {
  return (
    <li className="flex flex-col gap-0.5">
      <code className="font-mono text-xs text-fg">
        <span className="text-indigo">{row.element}</span>{" "}
        <span className="text-subtle">{row.schema}</span>
      </code>
      <code className="font-mono text-xs break-all text-fg">
        {row.property}: {row.value}
      </code>
      {/* The provenance and the note are ONE text run, deliberately: an element
          whose whole content is the workflow's name is a second thing on the
          page answering to that name, and every reader — a person scanning for
          the section about `digest`, `getByText` in a spec — then has two hits
          for one workflow. */}
      <span className="text-[11px] text-muted">
        {row.declared
          ? `Declared by ${row.workflow}. ${row.note}`
          : `Example — this agent declares none. ${row.note}`}
      </span>
    </li>
  );
}

/**
 * The form card, or nothing.
 *
 * Rendered for any agent that declares a workflow, whether or not that workflow
 * takes a file: the file row is one of seven, and the card's subject is the run
 * INPUT rather than the upload routes (which "Sending a file" below owns, and
 * which really do render only for an agent with somewhere to put an id).
 *
 * There is no `declared.length === 0` guard, because its one caller renders it
 * inside the arm that already established that (`WorkflowApi` in api-docs.tsx)
 * — the same gate the run examples are behind, and for the same reason: with
 * nothing declared there is no run body for a control to be a property of. A
 * guard here would be a branch no test can reach.
 */
export function FormFieldsApi({
  base,
  token,
  declared,
}: {
  base: string;
  token: boolean;
  /** The agent's own listing, as `GET /workflows` served it. */
  declared: readonly WorkflowSummary[];
}) {
  const rows = formElements(declared);
  // The workflow the annotated snippets are written against — a real one, so
  // the body is pastable. Absent when nothing declares a schema, which is a
  // legal shape (input is optional) and means the table stands on its own.
  const example = fieldsWorkflow(declared);
  const snippets = example === undefined ? undefined : fieldSnippets(base, example, token);

  return (
    <Card
      title="Every form field, over HTTP"
      blurb="A page's form is one property of the run input per control. Here is each control, the JSON it contributes, and the one that needs a second call first — generated from this agent's own input schemas, so the field names are the ones it declared."
    >
      <div className="flex flex-col gap-4">
        <ul className="m-0 flex list-none flex-col gap-3 p-0">
          {rows.map((row) => (
            <ElementRow key={row.kind} row={row} />
          ))}
        </ul>
        {example !== undefined && snippets !== undefined && (
          <div className="flex flex-col gap-2 border-t border-line pt-4">
            <span className="text-[11px] text-muted">
              {`Every field of ${example.name} as one call, each property labelled by the control it is.`}
            </span>
            <Examples
              code={snippets.sdk}
              label="set every form field"
              alternates={[{ language: "curl", code: snippets.shell }]}
            />
          </div>
        )}
      </div>
    </Card>
  );
}
