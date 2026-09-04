// Copyright 2026 the AAI authors. MIT license.
/**
 * `WorkflowClient` — the surface tool code reaches as `ctx.workflows`.
 *
 * Split out of `workflow.ts`, which is the DECLARATION surface (`workflow()`,
 * `WorkflowDef`, `WorkflowBody`, `WorkflowSummary`) and re-exports this, so an
 * author still imports the whole workflow surface from one module. It sits beside
 * the two type modules it composes — `workflow-options.ts` for the per-call bags,
 * `workflow-run.ts` for the snapshot — rather than in front of them.
 *
 * The IMPLEMENTATION of this type is `host/workflow-client.ts`, which is host-only
 * (it holds the WDK seam and the key store). This file has no runtime content at
 * all, which is what lets the zero-Node half of the SDK name the type without
 * pulling any of that in.
 */

import type { InferSchemaOutput, ToolInputSchema } from "./schema.ts";
import type { AnyWorkflowDef, WorkflowDef, WorkflowSummary } from "./workflow.ts";
import type {
  FindOptions,
  StartOptions,
  StreamOptions,
  WakeUpOptions,
} from "./workflow-options.ts";
import type { WorkflowRunSnapshot } from "./workflow-run.ts";

/**
 * Start and inspect workflow runs. Reaches tool code as `ctx.workflows`.
 *
 * **Prefer passing the workflow itself over its name.** Every method here is
 * overloaded on `WorkflowDef | string`, and the def overload is the one that
 * types the input against the workflow's own schema, types `output` against its
 * return, and turns a misspelled workflow into a compile error instead of a
 * promise rejection the model reads as a tool failure. The string overload stays
 * for a name that genuinely is data — read from config, a database, a request.
 *
 * The def is resolved to its declared name by IDENTITY against
 * `agent({ workflows })`, so that record stays the single source of the name,
 * and to its `workflowId` through its own `run` function.
 *
 * @public
 */
export type WorkflowClient = {
  /**
   * Create a run and return its id without waiting for it to finish — the
   * point of the whole mechanism. A tool that calls this answers the caller
   * in the same turn ("started, I'll text you") while the run continues past
   * the end of the session.
   *
   * Rejects when the workflow is not declared on this agent, when the input
   * fails its schema, or when no workflow backend is configured.
   */
  start<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    /**
     * Required for the definition form, even for a workflow that declares no
     * schema — pass `{}` there. Optional would mean a schema-CARRYING workflow
     * could be started with no input by omission, which is the mistake this
     * overload exists to catch; `{}` is a small cost for that.
     */
    input: InferSchemaOutput<P>,
    options?: StartOptions,
  ): Promise<string>;
  start(workflow: string, input?: unknown, options?: StartOptions): Promise<string>;
  /**
   * Look up a run by id. Resolves `undefined` when no such run exists.
   *
   * Pass the workflow as the second argument to type `output` on a completed
   * run; with the id alone there is nothing to infer it from, so it is
   * `unknown`. The argument is used ONLY for that — the run's own record says
   * which workflow it belongs to.
   */
  get<R>(runId: string, workflow: AnyWorkflowDef<R>): Promise<WorkflowRunSnapshot<R> | undefined>;
  get(runId: string): Promise<WorkflowRunSnapshot | undefined>;
  /**
   * Runs of `workflow` started with this correlation key, newest first.
   *
   * The read half of {@link StartOptions.key} — see there for why a voice agent
   * needs it. Resolves an empty array when nothing matches.
   */
  find<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    key: string,
    options?: FindOptions,
  ): Promise<WorkflowRunSnapshot<R>[]>;
  find(workflow: string, key: string, options?: FindOptions): Promise<WorkflowRunSnapshot[]>;
  /**
   * Runs of `workflow`, newest first, whatever key they carry.
   *
   * The OPERATOR's read where {@link find} is the agent's. A console — the
   * studio's Settings pane, a `curl` — asking "what has this workflow been doing"
   * holds no correlation key, and most runs carry none at all: a page keeps its
   * own `runId`, so only a voice agent's runs are keyed.
   *
   * Deliberately its own method rather than `find` with an optional key, because
   * a keyless lookup is not a lookup that matched every key. Sharing one method
   * would let a caller meaning "this session's runs" read every session's the
   * moment its key went `undefined` — a scoping bug with no symptom.
   */
  recent<P extends ToolInputSchema, R>(
    workflow: WorkflowDef<P, R>,
    options?: FindOptions,
  ): Promise<WorkflowRunSnapshot<R>[]>;
  recent(workflow: string, options?: FindOptions): Promise<WorkflowRunSnapshot[]>;
  /**
   * Stop a run. Resolves true when this call is what ended it, false when it
   * was already terminal (or no such run exists).
   *
   * A cancelled run is terminal: it is never resumed, and its event log is kept
   * so what it did before stopping stays readable.
   */
  cancel(runId: string): Promise<boolean>;
  /**
   * Interrupt a run's pending `sleep()` calls, resuming it early. Resolves how
   * many sleeps were interrupted — `0` when the run was not sleeping, had
   * already finished, or does not exist.
   *
   * This is the counterpart of a `sleep()` long enough to be worth shortening,
   * which is most of the ones worth writing: a review delay, a retry backoff, a
   * "follow up tomorrow". Without it the only handle on a sleeping run is
   * {@link cancel}, so "send it now" and "throw it away" were the same button.
   *
   * Pass `correlationIds` to target specific sleeps; omitted, every pending one
   * in the run is interrupted.
   */
  wakeUp(runId: string, options?: WakeUpOptions): Promise<number>;
  /**
   * Deliver a payload to a run parked on `createHook({ token })`, resuming it.
   * Resolves true when a hook was listening on `token`, false when none was.
   *
   * **This is the half of the mechanism a voice agent needs and could not
   * reach.** A run that has to WAIT for a person — an approval, a choice, a
   * "yes, go ahead" — parks on a hook, and until now the only way to feed one
   * was the public webhook URL `createWebhook()` mints, which is for a third
   * party with a callback to make. The caller on the phone is neither: they are
   * right here, mid-turn, and the thing that should resume the run is a tool.
   *
   * {@link wakeUp} is not this. It ends a pending `sleep()`, which is a run
   * waiting for TIME; a hook is a run waiting for an ANSWER, and the answer is
   * the payload. A body that raced a hook against a `sleep` — the shape a
   * decision-with-a-deadline takes — needs both, and they mean different things.
   *
   * **The token is the contract, and it has to be derivable on both sides.** A
   * hook's token is chosen by the BODY and typed in by the tool, so it must be
   * something each can compute from what it already has:
   * `` `retention:${input.requestedBy}` `` in the body against
   * `` `retention:${ctx.sessionId}` `` in the tool. Put that expression in one
   * exported helper both import, rather than writing the template literal twice.
   *
   * Two properties come with it. A token is claimed by ONE live hook, so two
   * runs that would derive the same token collide — the body detects that with
   * `hook.getConflict()`, and the ordinary fix is the one a voice agent wants
   * anyway: at most one live run per caller. And a token is a capability: it
   * addresses a run, so derive it from something session-scoped rather than from
   * anything a caller could name.
   *
   * **`false` is an answer.** Nobody listening is the normal case, not a
   * failure — the run has moved past its hook, or finished, or was never
   * started. Same shape as
   * {@link cancel} resolving false and {@link wakeUp} resolving `0`, and a voice
   * tool should say so out loud ("that one had already gone ahead") rather than
   * treat it as an error.
   */
  signal(token: string, payload?: unknown): Promise<boolean>;
  /**
   * Read what a run has WRITTEN while running, as a stream.
   *
   * The gap this fills: a snapshot carries a status and, once terminal, an
   * output — so a run that takes ten minutes is `running` for ten minutes and
   * then done, with nothing in between. A workflow that wants to report progress
   * writes to `getWritable()` (imported from `workflow`, like `sleep`), and this
   * is the read side.
   *
   * Chunks are RETAINED with the run, not live-only, so this is equally a replay:
   * a page that reloads mid-run reads the whole stream from the start by default,
   * and `startIndex` is for a reader that knows where it got to.
   *
   * The stream is lazy — a run that does not exist surfaces when it is read, not
   * here — so a caller wanting a clean "no such run" answer should {@link get} it
   * first, which is what the HTTP route does.
   */
  stream(runId: string, options?: StreamOptions): Promise<ReadableStream<unknown>>;
  /**
   * How far the run's stream currently goes: the index of the last chunk
   * written, or `-1` for a stream nothing has written to.
   *
   * **This is what makes reading a progress stream terminate.** A workflow stream
   * reports its end only once it has been CLOSED, and a progress channel written
   * by one step after another is never closed — no step knows it is the last one.
   * So {@link stream} on a finished run yields every chunk and then waits
   * forever. A reader bounds itself by this instead, which is also what a
   * reconnecting reader needs in order to ask for what it has not seen.
   */
  streamTail(runId: string, options?: StreamOptions): Promise<number>;
  /**
   * The NEWEST chunk a run has written, or `undefined` when it has written
   * nothing.
   *
   * **Reach for this instead of composing {@link streamTail} and
   * {@link stream} — the composition is the one a tool gets wrong, and getting
   * it wrong HANGS.** A progress channel is never closed (no step knows it is
   * the last one), so `stream` on a run with nothing in it yields nothing and
   * waits forever rather than ending: a voice agent's tool call stops mid-turn
   * with no error, no timeout of its own, and nothing in a log to read. The
   * bound that prevents it is `streamTail() < 0`, which has to come FIRST and
   * is not an optimization. Two templates carried the same six-line comment
   * saying exactly that, above the same eight lines, which is what a missing
   * front door looks like.
   *
   * This method cannot hang: it asks for the tail before it opens anything, and
   * it opens a stream only once the tail says there is a chunk to read. It
   * reads ONE chunk and cancels, so nothing is left draining behind it.
   *
   * The chunk is `unknown` — whatever the body passed to `getWritable()`, which
   * this SDK does not constrain. A tool narrating progress wants
   * `String(line)`; a body writing structured records should narrow with a
   * guard.
   *
   * {@link streamTail} and {@link stream} stay public and are still the right
   * pair for reading a WHOLE log — a page rendering every line, a reader
   * resuming from where it got to. This is only the "read me the newest thing"
   * case, which is the one with a trap in it.
   *
   * `options.namespace` selects the stream, as everywhere else. A non-negative
   * `options.startIndex` acts as a FLOOR: nothing is resolved until the run has
   * written that far, which is what a reader that has already seen up to an
   * index wants. A negative one asks for the newest chunk, which is what this
   * returns anyway.
   */
  lastLine(runId: string, options?: StreamOptions): Promise<unknown | undefined>;
  /**
   * The PUBLIC URL a third party delivers a webhook to, for a hook holding
   * `token` — this agent's configured public base URL plus the DevKit's webhook
   * route.
   *
   * **Not `hook.url`, and that is the whole reason it exists**: the DevKit
   * composes its own from `getWorkflowMetadata().url`, which is
   * `http://localhost:<port>` off the running process — the inside of a container
   * that has self-exited by the time the callback comes. Treat `hook.url` as
   * guest-local and use this for anything leaving the system.
   *
   * Synchronous, and it THROWS when no public URL is configured, naming the
   * option. The token is the CALLER's, exactly as {@link signal} takes it. See
   * "A callback URL comes from `publicWebhookUrl`" in `packages/aai/CLAUDE.md`.
   */
  publicWebhookUrl(token: string): string;
  /**
   * The workflows this agent declares, name + description + input schema.
   *
   * Synchronous, and on the CLIENT rather than only on the engine, because tool
   * code is a legitimate reader: the `workflow_status` builtin has to ask about
   * every declared workflow when the model named none, and nothing else in
   * `ToolContext` could tell it what those are. Empty when no backend is
   * available, which is the same answer as "this app declares none".
   */
  listing(): WorkflowSummary[];
};
