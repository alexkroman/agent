// Copyright 2026 the AAI authors. MIT license.
/**
 * A LOCAL stand-in for the one Supabase Management API endpoint this platform
 * calls, so `pnpm dev:aai-server` can create and drop per-app databases on the
 * local stack — which has no control plane of its own.
 *
 * **This is a test double at the BOUNDARY, not a fallback inside the platform.**
 * The distinction is the whole design. `app-db-admin.ts` deliberately has one
 * implementation of `create database` / `drop database`, because a second one
 * chosen by config is a path production never takes. Nothing here changes that:
 * the server still resolves a Management API channel, still builds the statement
 * text, still sends it through `supabase-management-js` over HTTP with a bearer,
 * and still reads the SQLSTATE back out of the response. Only the far end differs
 * — and in production the far end also just runs the statement as `postgres`.
 * Same reasoning as the mock verdaccio the e2e suite publishes into, and as the
 * `subprocess` sandbox backend: stand the COLLABORATOR in, never the code.
 *
 * **It runs in its own process, bound to loopback.** An endpoint that executes
 * DDL as `postgres` must not exist inside the server: a route gated on
 * `AAI_LOCAL_DEV` is one bad boot flag away from being reachable in production,
 * and this way there is no such route to reach. `scripts/dev-server.mjs` starts
 * it, hands the server its URL, a per-run random token and a dev project ref, and
 * kills it on exit; `pnpm --filter aai-server dev:management-api` runs it alone.
 *
 * Three refusals keep it honest:
 *
 * - **`AAI_LOCAL_DEV=1` or it does not start.** The sentinel that already
 *   authorizes the isolation-free sandbox backend authorizes this too, and for
 *   the same reason: it must never follow from a variable somebody forgot.
 * - **A loopback admin URL or it does not start.** Pointed at a real cluster
 *   this would be a credential-free way to drop tenant databases; a real project
 *   has a real control plane and needs no stand-in.
 * - **Only the two statements the platform sends**, matched by rebuilding them
 *   from `createDatabaseSql`/`dropDatabaseSql` rather than by a regex of their
 *   own. So it cannot drift from what the platform issues, and a third statement
 *   routed onto this channel fails LOUDLY here in dev instead of silently
 *   diverging from production.
 *
 * A SQL failure is rendered the way the real endpoint renders one — a message
 * carrying `(SQLSTATE …)` — because that token is what `supabase-management.ts`
 * lifts into `code`, and what makes a lost `create database` race absorb as
 * `42P04` locally exactly as it does in production. Getting that wrong here
 * would make the one behaviour hardest to reproduce also the one dev cannot see.
 */

import type { AddressInfo } from "node:net";
import { pathToFileURL } from "node:url";
import { errorMessage } from "@alexkroman1/aai";
import { isRecord } from "@alexkroman1/aai/utils";
import { createPostgresDb } from "@alexkroman1/aai-runtime";
import { serve } from "@hono/node-server";
import { Hono } from "hono";
import { isLocalDev } from "./_boot.ts";
import { sqlState } from "./app-database.ts";
import { createDatabaseSql, dropDatabaseSql } from "./app-db-admin.ts";
import type { SqlExec } from "./secret-store.ts";

/** Hosts this stand-in will serve a database for. See the module doc's refusals. */
const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]", "db"]);

/** The app-database identifier inside one of the two statements. */
const ID_IN_STATEMENT = /"(app_[a-f0-9]{16})"/;

/**
 * Is this exactly one of the statements the platform's channel issues?
 *
 * Rebuilt from the same two builders the platform uses, so the allowlist cannot
 * drift from the statement text: a change to either builder changes this too.
 */
export function isAppDbStatement(statement: string): boolean {
  const id = ID_IN_STATEMENT.exec(statement)?.[1];
  if (id === undefined) return false;
  return statement === createDatabaseSql(id) || statement === dropDatabaseSql(id);
}

/**
 * The stand-in's one route, shaped like `POST /v1/projects/{ref}/database/query`
 * — including the failure shapes, which is the half a caller depends on.
 */
export function devManagementApp(opts: { ref: string; token: string; sql: SqlExec }): Hono {
  const app = new Hono();
  app.post("/v1/projects/:ref/database/query", async (c) => {
    if (c.req.header("authorization") !== `Bearer ${opts.token}`) {
      return c.json({ message: "Unauthorized" }, 401);
    }
    // A wrong ref is the real API's 404, not a 400: the token is valid and the
    // project is simply not one it can see.
    if (c.req.param("ref") !== opts.ref) {
      return c.json({ message: "Project not found" }, 404);
    }
    const query = statementOf(await c.req.json().catch(() => undefined));
    if (query === undefined) return c.json({ message: "query is required" }, 400);
    if (!isAppDbStatement(query)) return c.json({ message: refusal(query) }, 400);
    const result = await runStatement(opts.sql, query);
    return "rows" in result ? c.json(result.rows) : c.json({ message: result.failure }, 400);
  });
  return app;
}

/** The `query` field of a well-formed request body. */
function statementOf(body: unknown): string | undefined {
  return isRecord(body) && typeof body.query === "string" ? body.query : undefined;
}

function refusal(query: string): string {
  return (
    `dev-management-api refuses "${query}": this stand-in serves only the two statements ` +
    "app-db-admin.ts issues. A new one belongs in both places."
  );
}

/**
 * Run one statement, rendering a failure the way the real endpoint renders one:
 * a message carrying the SQLSTATE, which is the token the client lifts into
 * `code` (and what makes a lost create race absorb as `42P04` here too).
 */
async function runStatement(
  sql: SqlExec,
  query: string,
): Promise<{ rows: Record<string, unknown>[] } | { failure: string }> {
  try {
    return { rows: await sql(query) };
  } catch (err) {
    const code = sqlState(err);
    return {
      failure: `failed to run query: ERROR: ${errorMessage(err)}${code ? ` (SQLSTATE ${code})` : ""}`,
    };
  }
}

/** Refuse a non-loopback admin URL, and say which host was refused. */
function assertLoopback(url: string): void {
  const host = new URL(url).hostname;
  if (!LOOPBACK_HOSTS.has(host.toLowerCase())) {
    throw new Error(
      `dev-management-api refuses to serve ${host}: it executes DDL as \`postgres\` with ` +
        "a throwaway token, so it is loopback-only. A real Supabase project has a real " +
        "Management API — set SUPABASE_ACCESS_TOKEN and let the platform call it.",
    );
  }
}

/**
 * Start the stand-in on `port` (0 = an ephemeral one) and resolve its URL. The
 * returned `close` also closes the admin connection it opened.
 */
export async function startDevManagementApi(opts: {
  /** The LOCAL admin connection the statements run on. Loopback only. */
  dbUrl: string;
  ref: string;
  token: string;
  port?: number;
  /** Injectable for tests that would rather not open a real connection. */
  sql?: SqlExec;
}): Promise<{ url: string; close(): Promise<void> }> {
  assertLoopback(opts.dbUrl);
  const admin = adminExecutor(opts.dbUrl, opts.sql);
  const app = devManagementApp({ ref: opts.ref, token: opts.token, sql: admin.sql });
  const server = serve({ fetch: app.fetch, port: opts.port ?? 0 });
  await new Promise((resolve) => server.once("listening", resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await admin.close();
    },
  };
}

/** One admin connection, or the injected executor and nothing to close. */
function adminExecutor(
  dbUrl: string,
  injected: SqlExec | undefined,
): { sql: SqlExec; close(): Promise<void> } {
  if (injected !== undefined) return { sql: injected, close: () => Promise.resolve() };
  const db = createPostgresDb({ url: dbUrl, max: 1 });
  return { sql: (query, params) => db.query(query, params), close: () => db.close() };
}

/**
 * `pnpm --filter aai-server dev:management-api`, and what `dev-server.mjs`
 * spawns. The URL goes to stdout as one parseable line, because that is the
 * handshake: an ephemeral port means the parent cannot guess it, and guessing a
 * fixed one collides with whatever else a developer is running.
 */
async function main(): Promise<void> {
  const env = process.env;
  if (!isLocalDev(env)) {
    throw new Error(
      "dev-management-api requires AAI_LOCAL_DEV=1. It stands in for Supabase's control " +
        "plane with a throwaway token and must never run beside a real deployment.",
    );
  }
  const dbUrl = env.SUPABASE_DB_URL;
  const ref = env.SUPABASE_PROJECT_REF;
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!(dbUrl && ref && token)) {
    throw new Error(
      "dev-management-api needs SUPABASE_DB_URL, SUPABASE_PROJECT_REF and " +
        "SUPABASE_ACCESS_TOKEN (the ref and token are this run's throwaways — " +
        "`pnpm dev:aai-server` generates them and starts this itself).",
    );
  }
  const port = Number(env.AAI_DEV_MANAGEMENT_PORT ?? 0);
  const { url } = await startDevManagementApi({ dbUrl, ref, token, port });
  console.log(`dev-management-api: listening on ${url} (project ${ref})`);
}

// Run only when invoked directly, so importing this for a test starts nothing.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
