// Copyright 2026 the AAI authors. MIT license.
/**
 * The failure a workflow caller can FIX — an unknown workflow name, or input
 * that does not match the workflow's own schema.
 *
 * It exists so an HTTP route can tell those apart from everything else, and the
 * reason it has to is measured. `POST /workflows/runs` wrapped the whole of
 * `engine.start()` in one `catch` that answered **400 with the raw message**, on
 * the stated reasoning that `start` rejects an unknown name and a schema failure
 * and "everything else is ours; the router's catch has it". The `try` covered the
 * world call too, so everything else never reached that catch: with Postgres
 * killed for six seconds, a form submission answered
 *
 *     400 {"error":"connect ECONNREFUSED 127.0.0.1:54399"}
 *
 * and `GET /workflows/runs` answered 400 carrying the full SQL statement. Both
 * are wrong twice over — a 400 tells a client its request was bad, so nothing
 * retries a transient outage, and the workflow API is unauthenticated unless the
 * operator sets `AAI_WORKFLOW_API_TOKEN`, so the database's host and port and the
 * shape of its tables went to anyone holding the page's URL.
 *
 * Distinguishing them by TYPE rather than by inspecting messages is what makes
 * that checkable: `resolve` and `validate` throw this, nothing else does, and a
 * route that sees anything else rethrows to the router — where
 * `answerHandlerFailure` already logs the cause and answers an opaque 500, which
 * is the behaviour this restores rather than invents.
 *
 * **The type test is {@link isWorkflowRequestError}, never `instanceof`**, and
 * that distinction cost the 400s it was written to produce: a guest runs two
 * copies of this SDK on purpose, so the copy that throws and the copy that
 * catches are different classes and `instanceof` was false across them. See the
 * brand field for the measurement.
 *
 * Deliberately NOT on the `/runtime` barrel. A tool calling `ctx.workflows.start`
 * could reasonably want to tell a bad input from a dead database, but publishing
 * a name means a capability contract and an epoch (see "The authoring surface is
 * versioned in epochs"), and no caller has asked for it yet. Both readers are in
 * this package.
 *
 * @internal
 */
/**
 * The brand key. `Symbol.for`, so two copies of this module agree — see the
 * field's own doc for why they exist at all.
 */
const WORKFLOW_REQUEST_ERROR: unique symbol = Symbol.for(
  "aai.workflowRequestError",
) as typeof WORKFLOW_REQUEST_ERROR;

export class WorkflowRequestError extends Error {
  /**
   * The brand {@link isWorkflowRequestError} reads, and the reason the guard is
   * not `instanceof`.
   *
   * A guest runs TWO copies of this SDK, by design: the harness bundles its own
   * (`aai-guest/harness.mjs`), and the agent's runtime comes from the BUNDLE —
   * "so a deployed agent runs exactly the SDK version it was built and tested
   * against; the harness embeds no runtime" (`harness-bundle.ts`). Two copies of
   * a class are two identities, so an `instanceof` spanning them is false for a
   * value that is, in every sense the code cares about, the thing being tested
   * for.
   *
   * Measured: `POST /workflows/runs` answered **500** to a schema failure in
   * production on five occasions and 400 to none, while the identical case
   * answers 400 in-process — the route rethrew a caller mistake to the router,
   * which logged it and answered an opaque 500. So a page could not show the user
   * which field it got wrong, and a client was told to retry a request that can
   * never succeed.
   *
   * A registered symbol is what crosses the seam: `Symbol.for` resolves through a
   * process-wide registry, so every copy computes the same key. It is also a
   * SYMBOL rather than a string field, which keeps it off `JSON.stringify` and
   * out of `Object.keys` — this value is serialized into HTTP responses.
   *
   * This is not the message-inspection the module doc rules out. The brand is set
   * by the constructor and by nothing else, so it still answers "was this thrown
   * as a caller mistake" rather than "does this text look like one".
   */
  readonly [WORKFLOW_REQUEST_ERROR]: true = true;

  constructor(message: string) {
    super(message);
    this.name = "WorkflowRequestError";
  }
}

/**
 * Whether `err` is a {@link WorkflowRequestError} — the failure a workflow caller
 * can FIX, and therefore a 400 rather than a 500.
 *
 * Use this at every catch site instead of `instanceof`. The two are the same
 * question and only one of them survives a guest, where the throwing copy of the
 * SDK and the catching copy are different modules.
 *
 * @internal
 */
export function isWorkflowRequestError(err: unknown): err is WorkflowRequestError {
  // A property read rather than `in`, so a null prototype or an exotic object
  // cannot throw inside a catch block whose whole job is to classify a throw.
  return (
    typeof err === "object" &&
    err !== null &&
    (err as Record<PropertyKey, unknown>)[WORKFLOW_REQUEST_ERROR] === true
  );
}
