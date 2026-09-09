// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * The shell `mountPage()` renders for a workflow app that declares no
 * `component` — the page you get for free, the way a voice agent gets
 * `DefaultShell`.
 *
 * `mountPage()`'s `component` was REQUIRED, on the argument that "a workflow app
 * has no default shell to fall back to, because there is no session for one to
 * render". That was true of a SESSION and false of the page: every piece such a
 * shell needs was already published, and the six shipped workflow templates each
 * wrote 220-511 lines composing them in the same order — `useWorkflows` for the
 * listing (which carries each workflow's `inputSchema`), `<WorkflowFields>` for
 * the controls, `useWorkflowSubmit` for the run, `<WorkflowProgress>` and
 * `<WorkflowRunError>` for what happens next. So the promise the docs made about
 * a voice agent ("you do not need a `client.tsx`") is now true of a workflow app
 * too, and a `component` is what it is for `mountClient()`: how you replace the
 * default, not how you get a page at all.
 *
 * ## It is FUNCTIONAL, not designed
 *
 * Deliberately: this is the page that proves an agent's workflows work, from
 * `aai dev` on the first run to a deployed app nobody has styled yet. It renders
 * the agent's own name and greeting, a form per the workflow's declared schema,
 * the run's narration, its failure, and its output as JSON. It does not lay out
 * a result — a completed run's shape is the author's, and
 * `WorkflowSummary.outputSchema` is the seam a page that wants labels reads. A
 * page that wants any of that passes `component`.
 *
 * Nothing here is exported from the package. It is the default's implementation,
 * not a component to compose with: everything it is built from is already
 * public, so a page that wants a piece takes the piece.
 */

import type { WorkflowSummary } from "@alexkroman1/aai/workflow-api";
import { type ReactNode, useEffect, useState } from "react";
import { type ClientConfigResponse, fetchClientConfig } from "./client-config.ts";
import { Form, SubmitButton } from "./components/form.tsx";
import { UploadProgressBar } from "./components/upload-progress.tsx";
import { WorkflowFields } from "./components/workflow-fields.tsx";
import { WorkflowProgress } from "./components/workflow-progress.tsx";
import { WorkflowRunError } from "./components/workflow-run-error.tsx";
import { useWorkflowSubmit } from "./use-workflow-form.ts";
import { useWorkflows } from "./use-workflows.ts";

/**
 * The agent's own `name` and `greeting`, once the lookup lands.
 *
 * **Not skipped when the mount named the agent**, which is where this differs
 * from `mountClient()`'s `DefaultRoot`: there the response's only consumer is
 * the name fallback, so an explicit `name` made the request pure waste. Here the
 * GREETING is rendered too, and no argument to `mountPage()` supplies it.
 *
 * Every failure path already degrades to "the agent declared nothing" —
 * `fetchClientConfig` owns that — so there is nothing to report and nothing to
 * catch.
 */
function useAgentConfig(): ClientConfigResponse | undefined {
  // `undefined` until the lookup lands rather than an empty literal: `page` is
  // required on the response (absent on the wire reads as `"voice"`), and this
  // shell has no business claiming a front door it has not been told about.
  const [config, setConfig] = useState<ClientConfigResponse>();
  useEffect(() => {
    let cancelled = false;
    void fetchClientConfig().then((answer) => {
      if (!cancelled) setConfig(answer);
    });
    return () => {
      cancelled = true;
    };
  }, []);
  return config;
}

/**
 * One workflow's form, its run, and what the run said.
 *
 * Its own component because `useWorkflowSubmit` is per WORKFLOW: the hook holds
 * the run id, so switching workflows has to start over rather than show one
 * workflow's run under another's form. The shell below mounts this with
 * `key={name}`, which is what makes that reset happen.
 */
function WorkflowRunner({ workflow }: { workflow: WorkflowSummary }): ReactNode {
  const submission = useWorkflowSubmit(workflow.name);
  const { submitForm, run, pending, upload, pauseUpload, resumeUpload, error } = submission;

  return (
    <section className="flex flex-col gap-4">
      {workflow.description === undefined ? null : (
        <p className="text-sm opacity-70">{workflow.description}</p>
      )}

      {/* Every control from the workflow's own input schema — so this form
          matches the agent by construction, and a field added in `agent.ts`
          appears here with no edit. `<Form>` carries the announced submit
          error. */}
      <Form onSubmit={(values) => submitForm(values)} error={error} className="flex flex-col gap-4">
        <WorkflowFields workflow={workflow} />
        <SubmitButton pending={pending}>Start</SubmitButton>
      </Form>

      {/* The wait nothing else can describe: a run does not EXIST until its
          input is stored, so a form with a file in it has no run to watch until
          the last byte lands. */}
      <UploadProgressBar upload={upload} onPause={pauseUpload} onResume={resumeUpload} />

      {/* What the run itself wrote, from `stepReport()`. Renders nothing until
          there is something to render. */}
      <WorkflowProgress runId={run?.runId} />

      {/* Announced, because a run fails minutes after the reader looked away. */}
      <WorkflowRunError run={run} />

      {run?.status === "completed" && (
        // The output as it is, not as a layout: what a completed run answers
        // with is the author's own shape, and guessing at a rendering of it is
        // what `component` is for. `overflow-x-auto` because JSON of a
        // transcript is wider than a page.
        <pre className="overflow-x-auto rounded-md border p-4 text-xs">
          {JSON.stringify(run.output, null, 2)}
        </pre>
      )}
    </section>
  );
}

/**
 * The default page: the agent, its workflows, and one form.
 *
 * A picker appears only when there is more than one workflow — an agent with a
 * single workflow is the common case and a select with one option is chrome
 * about nothing.
 */
export function DefaultPageShell({ name }: { name?: string | undefined }): ReactNode {
  const config = useAgentConfig();
  const { workflows, loading, error } = useWorkflows();
  const [picked, setPicked] = useState<string>();
  // The picked one while it still exists (the listing can arrive after a
  // selection is impossible to have made, but a re-listing may not carry it),
  // otherwise the first — so a single-workflow agent needs no interaction.
  const selected = workflows.find((entry) => entry.name === picked) ?? workflows[0];

  return (
    <main className="mx-auto flex max-w-2xl flex-col gap-6 p-8">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-medium">{name ?? config?.name ?? "Workflows"}</h1>
        {config?.greeting === undefined ? null : (
          <p className="text-sm opacity-70">{config.greeting}</p>
        )}
      </header>

      {/* The listing's failure is reported rather than swallowed, for
          `useWorkflows`' own reason: an empty list reads as "this agent declares
          no workflows" about an agent that was merely unreachable. */}
      {error === undefined ? null : (
        <p role="alert" className="text-red-600">
          {error}
        </p>
      )}

      {loading && <p className="text-sm opacity-70">Loading workflows…</p>}

      {!loading && error === undefined && workflows.length === 0 && (
        <p className="text-sm opacity-70">This agent declares no workflows.</p>
      )}

      {workflows.length > 1 && (
        <label className="flex flex-col gap-1 text-sm">
          Workflow
          <select
            value={selected?.name ?? ""}
            onChange={(event) => setPicked(event.target.value)}
            className="rounded-md border px-3 py-2"
          >
            {workflows.map((entry) => (
              <option key={entry.name} value={entry.name}>
                {entry.name}
              </option>
            ))}
          </select>
        </label>
      )}

      {/* Keyed by name — see `WorkflowRunner`: the run state belongs to the
          workflow, so a different one starts empty. */}
      {selected && <WorkflowRunner key={selected.name} workflow={selected} />}
    </main>
  );
}
