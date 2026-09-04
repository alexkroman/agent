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
 * The two `APP_DB_WORLD_*` sizes went the same way with the Workflow DevKit: they
 * sized the world's own `pg.Pool` and its graphile-worker concurrency, and there is
 * no world to size. The replay engine bounds a body's fan-out from the body
 * (`mapConcurrent`) and its step concurrency from the engine, neither of which is a
 * connection count.
 *
 * What is left is the half still true wherever a `DATABASE_URL` comes from, which on
 * the surviving paths is the AUTHOR's own secret: a self-hosted `createRuntimeServer`, or
 * `aai dev` against a project with one. These are pool SIZES, pinned because the
 * library defaults do not fit a database somebody else may also be using — and the
 * reasons below are measurements rather than preferences.
 *
 * ## The `APP_DB_` prefix is now a MISNOMER, deliberately left alone
 *
 * There is no such thing as an app database any more, so every name here reads as
 * vocabulary from a removed feature. They are kept because a rename touches both
 * constants, their consumers, two `@internal` barrels and the committed API
 * report, none of which changes behaviour — and because the module this doc sits on
 * is where a reader looks first. Read `APP_DB_` as "the database this guest was
 * given", whoever gave it. Renaming is a good follow-up; doing it inside the change
 * that removed the feature would bury the removal.
 *
 * @module
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
