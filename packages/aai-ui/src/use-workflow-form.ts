// Copyright 2026 the AAI authors. MIT license.
/**
 * The hook a FORM needs, as against the one a status view does.
 *
 * `useWorkflowRun` (`workflow-client.ts`) watches a run you already have.
 * This is what comes before it: `useWorkflowSubmit` starts a run and hands the
 * id straight to `useWorkflowRun`. Its sibling `useWorkflows` — the listing
 * `<WorkflowFields>` renders a form from — is `use-workflows.ts`. What it hands
 * back is `WorkflowSubmission` (`workflow-submission.ts`).
 *
 * ## `useWorkflowSubmit` — a form's two halves in one hook
 *
 * A page that submits a workflow always needs the same four pieces of state:
 * the run id, whether a submit is in flight, whether the RUN is still going, and
 * whichever of the two failed. `link-digest-workflow` writes them out by hand, which is
 * the right shape for a template teaching the primitives and the wrong shape to
 * write a third time — and it is easy to get subtly wrong: dropping the previous
 * run id before the new `POST` returns is what stops a finished result sitting
 * under a form that is already submitting again.
 *
 * So this is `api.start` plus {@link useWorkflowRun}, with the state between
 * them. It adds no transport of its own and holds no run state of its own; the
 * watching (stream first, poll as its fallback, terminal stops) is entirely
 * `useWorkflowRun`'s, and `run` here IS its run.
 *
 * ## Why it starts ASYNCHRONOUSLY even though a synchronous call exists
 *
 * `api.startAndWait` would collapse this to one request, and it is the wrong
 * default for a page: it holds a socket open for up to a minute, answers nothing
 * until it settles, and a page has `useWorkflowRun` — which survives a reload,
 * shows progress, and costs one stream. The synchronous call is for callers with
 * nowhere to put a watch (a script, a cron, a form POST from a server). Pass
 * `wait` here when the page really does want one request, and the run is
 * followed from the same id either way.
 */

import { omitUndefined } from "@alexkroman1/aai/utils";
import type {
  AnyWorkflowDef,
  UploadParallelOption,
  WorkflowOutputOf,
} from "@alexkroman1/aai/workflow-api";
import { useCallback } from "react";
import { type BeginSubmission, useSubmission } from "./_submission.ts";
import { useWorkflowApiRef } from "./_workflow-api-ref.ts";
import { coalesceUploadReports, createUploadSession, uploadFiles } from "./upload/index.ts";
import { useDefaultRunKey } from "./use-run-key.ts";
import type { WorkflowApi } from "./workflow-client.ts";
import type {
  SubmitInputOf,
  WorkflowAppLike,
  WorkflowDefOf,
  WorkflowNameOf,
} from "./workflow-def-types.ts";
import type { WorkflowSubmission, WorkflowSubmissionScope } from "./workflow-submission.ts";

// The submission's own types moved to `workflow-submission.ts` at this file's
// source-length cap; re-exported so every importer keeps its path.
export type { UploadStatus, WorkflowSubmission } from "./workflow-submission.ts";

/**
 * Options for {@link useWorkflowSubmit}.
 *
 * @input
 */
export type UseWorkflowSubmitOptions = {
  /** The client to start runs with. Defaults to one for the page's own agent. */
  api?: WorkflowApi;
  /**
   * Correlation key recorded with the run, for finding it again without the id.
   *
   * **Defaulted**, to an opaque per-page key in `sessionStorage` that the next
   * load produces again — `useRunKey()`'s, minted by the hook. Pass one to
   * scope runs to something the page knows better: an ACCOUNT's own id, which
   * is what makes a run follow the person to a new device, or
   * `{ storage: "local" }` — `useRunKey({ storage: "local" })`'s key, minted
   * here — for a run that outlives the tab by design. The key is a lookup
   * CAPABILITY (there is no per-user filtering behind `find`), it must fit the
   * route's 256-character bound, and anything derived from a person's own
   * input both collides and carries what they typed — `use-run-key.ts` argues
   * every alternative. What was chosen is reported back as
   * `WorkflowSubmission.scope`.
   *
   * **An empty or whitespace key THROWS** at the hook (and the route answers
   * 400): `""` is not "no key" but one key shared by every visitor whose key
   * computed to it — `user?.id ?? ""` before login. Pass `undefined` until the
   * key is known.
   */
  key?: string | { readonly storage?: "session" | "local" | undefined };
  /**
   * On mount, adopt the newest run this `key` already has.
   *
   * **This is what makes a reload survivable, and it is ON.** The run id is
   * this hook's own state, so a refresh loses it while the run carries on — and
   * a page that cannot name a run cannot show it, cancel it or wake it. The
   * hook asks `find(workflow, key)` once as it mounts and follows whatever
   * comes back, so the answer, the progress and the controls are all there
   * again.
   *
   * It used to be opt-in, on the argument that a `key` alone means only "record
   * this with the run" — true of `ctx.workflows.start({ key })`, where there is
   * no page to put a run back on, and not of a form: six of six page templates
   * passed `useRunKey()` and `recover: true` together, which is a default in
   * the wrong place. `false` is the opt-out, and what it buys is a form that
   * always opens empty — no lookup on mount, and a live run reachable only by
   * an id the page has already lost.
   */
  recover?: boolean;
  /**
   * Hold the `POST` open until the run settles, up to this many ms — the
   * synchronous mode. Omitted (the default) returns as soon as the run exists.
   */
  wait?: number;
  /** How often the fallback poll re-reads a live run. */
  intervalMs?: number;
  /**
   * Send each chosen file as concurrent parts instead of in one request.
   *
   * **On by default.** `false` opts out, `{ partBytes, concurrency }` tunes it.
   * This is the wait a form with a recording in it actually spends: the run does
   * not exist until its input is stored, so until the last byte lands there is no
   * run to watch and nothing for `<WorkflowProgress>` to say. Splitting the file
   * across connections is what makes that stretch shorter, and it degrades to the
   * single request wherever it would not help — a small file, an older agent — so
   * the default costs nothing where it would not have paid. See
   * `UploadOptions.parallel`.
   */
  parallel?: UploadParallelOption;
};

/**
 * Who can find the run again, from the two options that decide it — see
 * `WorkflowSubmissionScope`. A page-supplied string key is read as
 * `"browser"`: it is at least that wide (an account id is wider still), and
 * "close this tab" is true of it.
 */
function scopeOf(key: UseWorkflowSubmitOptions["key"], recover: boolean): WorkflowSubmissionScope {
  if (!recover) return "none";
  if (typeof key === "string") return "browser";
  return key?.storage === "local" ? "browser" : "tab";
}

/**
 * Start a workflow from a form, and follow the run it creates.
 *
 * @typeParam D - The workflow DEFINITION, which types both halves of the
 *   submission: `submit(input)` takes what the workflow's schema parses to, and
 *   `run.status === "completed"` narrows to a typed `run.output`.
 *
 *   It used to be the OUTPUT type alone, and the asymmetry was the bug: a page
 *   already wrote `WorkflowOutputOf<typeof digest>` to get the output, while
 *   `submit` took `unknown`, so `submit({ ur1: 42 })` compiled and arrived as a
 *   400 in the browser. Naming the def instead types the input from the same
 *   declaration — and `import type` is ERASED, so it costs the bundle nothing.
 *   Passing an output type where a def belongs is now a compile error rather
 *   than a silent loss of typing, which is the point.
 *
 *   **Or the AGENT.** `useWorkflowSubmit<typeof agentDef>("digest")` reads the
 *   def off the agent's own `workflows` map, and the NAME is then a literal the
 *   compiler checks — a typo is an error naming the keys the agent declares,
 *   where the def form accepts any string and 404s. See `WorkflowNameOf`; an
 *   app with several workflows names the one it means as a second type
 *   argument.
 *
 * @example
 * ```tsx
 * // file: agent.ts
 * import { agent, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export const digest = workflow({
 *   input: z.object({ url: z.string() }),
 *   output: z.object({ title: z.string() }),
 *   run: async ({ url }) => ({ title: url }),
 * });
 *
 * export default agent({ name: "Digest", workflows: { digest } });
 *
 * // file: client.tsx
 * import { Form, SubmitButton, TextField, useWorkflowSubmit } from "@alexkroman1/aai-ui";
 * import type { digest } from "./agent.ts";
 *
 * function DigestForm() {
 *   const { submitForm, run, pending, error } = useWorkflowSubmit<typeof digest>("digest");
 *   return (
 *     <Form onSubmit={(values) => submitForm(values)} error={error}>
 *       <TextField name="url" label="Link" type="url" required />
 *       <SubmitButton pending={pending}>Digest</SubmitButton>
 *       {run?.status === "completed" && <p>{run.output.title}</p>}
 *     </Form>
 *   );
 * }
 * ```
 *
 * @example Named through the agent, so the name is checked
 * ```tsx
 * // file: agent.ts
 * import { agent, workflow } from "@alexkroman1/aai";
 * import { z } from "zod";
 *
 * export const digest = workflow({
 *   input: z.object({ url: z.string() }),
 *   output: z.object({ title: z.string() }),
 *   run: async ({ url }) => ({ title: url }),
 * });
 *
 * export default agent({ name: "Digest", workflows: { digest } });
 *
 * // file: client.tsx
 * import { useWorkflowSubmit } from "@alexkroman1/aai-ui";
 * import type agentDef from "./agent.ts";
 *
 * export function DigestForm() {
 *   const { submit } = useWorkflowSubmit<typeof agentDef>("digest"); // "digset" would not compile
 *   return (
 *     <button type="button" onClick={() => submit({ url: "https://example.com/a" })}>
 *       Digest
 *     </button>
 *   );
 * }
 * ```
 *
 * @public
 */
export function useWorkflowSubmit<
  App extends WorkflowAppLike = never,
  Name extends WorkflowNameOf<App> = WorkflowNameOf<App>,
>(
  workflow: Name,
  options?: UseWorkflowSubmitOptions,
): WorkflowSubmission<
  WorkflowOutputOf<WorkflowDefOf<App, Name>>,
  SubmitInputOf<WorkflowDefOf<App, Name>>
>;
// The def form. `App = never` above declines an un-parameterized call, so it
// lands here; an app type is refused by the constraint (no `run`), so a name
// the app does not declare is an error rather than a string that 404s.
export function useWorkflowSubmit<D extends AnyWorkflowDef>(
  workflow: string,
  options?: UseWorkflowSubmitOptions,
): WorkflowSubmission<WorkflowOutputOf<D>, SubmitInputOf<D>>;
export function useWorkflowSubmit(
  workflow: string,
  options: UseWorkflowSubmitOptions = {},
): WorkflowSubmission<unknown, never> {
  const { api, recover = true, wait, intervalMs, parallel } = options;
  // The key the runs are recorded under: the caller's, or the per-page one this
  // hook mints and stores for itself. Minted even when `recover` is off, so
  // opting out of the LOOKUP still leaves the run findable — by the next load
  // that turns recovery back on, and by anything else holding the key.
  const key = useDefaultRunKey(options.key);
  const scope = scopeOf(options.key, recover);

  // The caller's client through a ref — see `_workflow-api-ref.ts`.
  const getClient = useWorkflowApiRef(api);

  // What this hook IS, as against its sibling: the files are stored first and
  // the run started over their ids. Everything after the body — the watch,
  // the controls, the stopwatch, the return — is `useSubmission`'s.
  const begin = useCallback<BeginSubmission>(
    (input, client) => {
      const session = createUploadSession(workflow);
      return {
        gate: session.gate,
        work: async ({ progress, started }) => {
          const options = omitUndefined({ key });
          // Files first: a run input carries an upload ID, never bytes, and this
          // is the one place that knows both the chosen file and the client that
          // can store it. A form using `<FileField upload>` (which is what
          // `<WorkflowFields>` renders for a declared upload property) therefore
          // needs no upload code of its own.
          // Coalesced: the parts uploader reports per XHR progress event across
          // eight concurrent requests, which is far more often than the bar can
          // render. See `upload/report.ts`.
          const report = coalesceUploadReports(progress);
          const stored = await uploadFiles(client, input, report, parallel, session);
          // Both paths end in a run id — the difference is only whether the agent
          // held the request open — so the watch is identical either way.
          // A failure simply rejects; an abandoned submission (`reset()`, the
          // next `submit()`) reaches nobody, because leaving it stopped it.
          started(
            wait === undefined
              ? await client.start(workflow, stored, options)
              : (await client.startAndWait(workflow, stored, { ...options, wait })).runId,
          );
        },
      };
    },
    [workflow, key, wait, parallel],
  );

  // The other half of "a run outlives the page" rides on the lookup: `key`
  // records the handle, and `recover` reads it back once per mount — see
  // `_recover-run.ts` for why, and why the answer can never displace a run
  // the person has already started.
  return useSubmission({
    getClient,
    api,
    intervalMs,
    recover: { workflow, key, enabled: recover, getClient },
    scope,
    begin,
  });
}
