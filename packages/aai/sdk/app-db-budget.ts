// Copyright 2026 the AAI authors. MIT license.
/**
 * How many connections a guest opens against a database it was GIVEN, and why each
 * number is what it is.
 *
 * This used to be an ENTITLEMENT calculation: the platform provisioned a database
 * per app, sized that role's `connection limit` against the sums here, and the
 * arithmetic had to be right or a guest was refused a connection it had been
 * promised. There are no per-app databases now — durable runs, the run journal and
 * session state are the platform's, reached over HTTP — so the two sum functions and
 * the provisioning headroom they needed went with the provisioning.
 *
 * What is left is the half still true wherever a `DATABASE_URL` comes from, which on
 * the surviving paths is the AUTHOR's own secret: a self-hosted `createServer`, or
 * `aai dev` against a project with one. These are pool SIZES, pinned because the
 * library defaults do not fit a database somebody else may also be using — and the
 * reasons below are measurements rather than preferences.
 *
 * ## The `APP_DB_` prefix is now a MISNOMER, deliberately left alone
 *
 * There is no such thing as an app database any more, so every name here reads as
 * vocabulary from a removed feature. They are kept because a rename touches five
 * constants, six consumer modules, two `@internal` barrels and the committed API
 * report, none of which changes behaviour — and because the module this doc sits on
 * is where a reader looks first. Read `APP_DB_` as "the database this guest was
 * given", whoever gave it. Renaming is a good follow-up; doing it inside the change
 * that removed the feature would bury the removal.
 *
 * @module
 */

/**
 * `WORKFLOW_POSTGRES_MAX_POOL_SIZE` — the DevKit world's `pg.Pool`.
 *
 * Pinned because the world's default is node-postgres's, which is 10 — a number
 * that assumes the pool owns the database, where this one is shared with whatever
 * else its owner points at it.
 */
export const APP_DB_WORLD_POOL_MAX = 4;

/**
 * `WORKFLOW_POSTGRES_WORKER_CONCURRENCY` — how many steps one guest runs at once.
 *
 * DERIVED, never declared: one slot of the pool belongs to graphile-worker's
 * `LISTEN` client for the life of the process (see the module doc), so this is
 * what is left for workers and for the world's own storage queries.
 */
export const APP_DB_WORLD_WORKER_CONCURRENCY = APP_DB_WORLD_POOL_MAX - 1;

/**
 * What that costs a FAN-OUT, because the number is invisible from the body.
 *
 * `mapConcurrent(items, 17, …)` reads as seventeen steps at once and executes
 * three. Measured on `aai dev` against a local Postgres, 16 steps each awaiting
 * a 2s loopback response, window 16: 12.3s, an effective 2.6x. The same run with
 * `WORKFLOW_POSTGRES_WORKER_CONCURRENCY=12` and
 * `WORKFLOW_POSTGRES_MAX_POOL_SIZE=13`: 4.4s, 7.3x. So this constant, not the
 * window and not the CPU, is what bounds every durable fan-out on this path —
 * `scripts/loadtest-runs.mjs --workflow=fanout` is the harness.
 *
 * It is still the right DEFAULT, and the reason is which deployments reach it: a
 * deployed guest takes the platform's own queue (`resolvePlatformQueue` wins over
 * a `DATABASE_URL`) and opens no database for workflows at all, so these
 * constants bind `aai dev` and a SELF-HOSTED server. Both are places where the
 * database may be shared with anything else the operator points at it, and
 * neither has a platform to have sized a connection limit for them. An operator
 * who owns their database raises the two variables above in the server's process
 * environment — not the project's `.env`, which is the AGENT env and never
 * reaches `configureWorkflowWorld`.
 */

/**
 * The guest's ONE handle on the database it was given (`aai-runtime/app-db.ts`).
 *
 * `ctx.db`, the session-state backend, workflow uploads and the wake hint all used
 * to lease off it; all four are gone, and what still does is the workflow
 * correlation-key index (`workflow-runtime.ts`) and the queue-lock sweep. Three
 * remains the size because a pool that is full QUEUES the next query
 * (postgres.js), where a role at its limit REFUSES the next connection — so a
 * tight pool costs a few milliseconds of latency and a loose one costs a failure,
 * which is the whole reason this number is small.
 */
export const APP_DB_POOL_MAX = 3;

/** The lock sweep's reserved presence connection — see the module doc. */
export const APP_DB_PRESENCE_LOCK = 1;
