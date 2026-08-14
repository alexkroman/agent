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
 * Deliberately NOT on the `/runtime` barrel. A tool calling `ctx.workflows.start`
 * could reasonably want to tell a bad input from a dead database, but publishing
 * a name means a capability contract and an epoch (see "The authoring surface is
 * versioned in epochs"), and no caller has asked for it yet. Both readers are in
 * this package.
 *
 * @internal
 */
export class WorkflowRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowRequestError";
  }
}
