// Copyright 2026 the AAI authors. MIT license.
// Per-request deadlines for the studio's REST layer.
//
// Its own module because `api.ts` is at the 500-line cap and this is the
// natural seam: every one of these is a NUMBER with a paragraph of hazard
// behind it, and the paragraphs are the point — a browser `fetch` has no
// timeout of its own, so each of these records which screen a hung request
// strands and why this many milliseconds is the right answer for it. They are
// re-exported from `api.ts`, so a caller still has one import.

/**
 * Per-attempt deadline for the session broker call. A broker request issued
 * while the server is restarting can HANG rather than fail — the proxy holds
 * the socket, or the platform queues the request against a container that
 * never answers — and a browser fetch has no timeout of its own, so without
 * this the chat panel showed "Starting sandbox…" forever, long after the
 * server was back. Sized above the cold path's real work: a Modal sandbox
 * spawn, the guest dial (30s cap server-side), and the session install
 * (60s cap). A timed-out attempt is retried (see isTransientError);
 * the server keeps brokering after the abort, so the retry usually reuses
 * the sandbox the aborted attempt booted.
 */
export const CHAT_SESSION_ATTEMPT_TIMEOUT_MS = 120_000;

/**
 * Per-attempt deadline for one log poll.
 *
 * Short on purpose. The platform's own read is bounded well under this
 * (`LOGS_READY_TIMEOUT_MS` plus one manage request), so anything slower than
 * this is a stall rather than work in progress — and the pane polls, so
 * abandoning and re-asking a second later is strictly better than holding a
 * socket open for the default deadline.
 */
export const AGENT_LOGS_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Per-attempt deadline for the account read that gates the whole app.
 *
 * Same hazard as the broker call above, with a worse symptom: a request
 * issued while the server is restarting or saturated can HANG rather than
 * fail — the proxy holds the socket open — and a browser fetch has no
 * timeout of its own, so the studio sat on "Loading…" forever with no way
 * out but a reload. The deadline is also what makes a Try again button
 * possible at all rather than merely sooner: TanStack Query folds a
 * `refetch` into the in-flight promise, so while the fetch never settles the
 * button cannot start a new attempt.
 *
 * Sized well above the real work (verify the session token, read one row)
 * and well under a user's patience.
 */
export const ACCOUNT_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Per-attempt deadline for the public auth-config read, which runs before
 * anything is rendered. It hangs for the same reasons and strands the page
 * on an empty screen — a worse place to sit than the loading card, since
 * there is nothing on it to explain the wait.
 */
export const AUTH_CONFIG_ATTEMPT_TIMEOUT_MS = 10_000;

/**
 * Per-attempt deadline for the Preview pane's agent-page probe. The same
 * hang as above, with a failure mode the others don't have: the probe is a
 * POLL that re-arms its timer from the SETTLED promise, so a request that
 * never settles doesn't miss one tick — it ends the loop, leaving the pane
 * on "Starting your preview" forever. Short, because a timeout already means
 * "not ready yet" (the rejection path), which is what re-arms the poll.
 */
export const AGENT_PAGE_PROBE_TIMEOUT_MS = 5000;

/**
 * Per-request deadline for the two reads aimed at a deployed AGENT's own
 * workflow API — the API pane's listing and the Workflows card's runs.
 *
 * Generous because the first read may be waiting out a container boot, which
 * is what brokering does. It lives in this table even though neither call goes
 * through `fetchJson` (both hand it to the SDK's own client as `timeoutMs`):
 * the table is about the DEADLINE, not the transport, and the two panes had
 * declared this same number with this same reasoning twice, so whoever
 * retuned the boot deadline would have found one of them. The one deadline
 * that deliberately stays out of this table is `auth-methods.ts`'s GoTrue
 * read, which is a THIRD-PARTY origin rather than a route of ours — argued
 * in place.
 */
export const AGENT_READ_TIMEOUT_MS = 20_000;

/**
 * The deadline every request carries unless it names its own.
 *
 * A browser `fetch` has NO timeout of its own, and a hung request is not a
 * failure — it never settles, so no error path, no retry and no backoff ever
 * runs. That is not a per-call hazard to remember at the four call sites that
 * happened to think of it: it is what `fetch` does, so it belongs in the one
 * place every request goes through. Four of ~18 requests carried a deadline,
 * and `GET /studio/status` — which gates the home hero's Send button AND the
 * project composer — was not one of them, so a single hung read left both
 * screens dead behind "Checking the server's chat status…" with no way out but
 * a reload.
 *
 * Sized well above the slowest thing a studio route does that is not already
 * deadlined explicitly (a deploy through the sandbox is the long one, and it
 * has {@link CHAT_SESSION_ATTEMPT_TIMEOUT_MS}'s reasoning applied to it below),
 * and well under a user's patience for a screen that says nothing.
 */
export const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;

/**
 * Per-attempt deadline for `GET /studio/status`.
 *
 * It answers from memory (which LLM the chat runs on), so it is only ever slow
 * when the server is — and it is read before anything is submittable, so the
 * shortest useful deadline is the right one: a timed-out attempt is what lets
 * the query layer retry at all.
 */
export const STATUS_ATTEMPT_TIMEOUT_MS = 10_000;
