// Copyright 2026 the AAI authors. MIT license.
/**
 * The Supabase MANAGEMENT API — the platform's control-plane channel into its
 * own Supabase project, over HTTPS rather than over a Postgres connection.
 *
 * **The client is the SDK's, not ours.** `supabase-management-js` is generated
 * from Supabase's own OpenAPI spec (`api.supabase.com/api/v1-json`), so the path,
 * the request body and the response shape of every endpoint come from the source
 * of truth rather than from a hand-written `fetch` that drifts the first time the
 * control plane changes. What this module adds is the two things the SDK cannot
 * know about: a **one-statement seam** (`SupabaseManagementApi.query`) so nothing
 * downstream imports a 10,000-line generated surface to run one statement, and
 * **error normalization** — `SupabaseManagementAPIError` carries `status` and an
 * opaque `data`, while every SQLSTATE check in this package reads `code`.
 *
 * **The project ref is DERIVED from the admin URL** (`SUPABASE_PROJECT_REF`
 * overrides it — see `appDbAdmin`). A second setting naming the project a
 * connection string already identifies is a way for the two to disagree, and the
 * failure that produces is control-plane statements landing on somebody else's
 * project. Both Supabase URL shapes carry it: a direct connection is
 * `db.<ref>.supabase.co`, and a Supavisor URL carries the tenant as the username
 * suffix `postgres.<ref>` (the same suffix `withDatabase` reattaches — the pooler
 * hostname is shared across projects, so the username is the only channel).
 *
 * **A SQL failure keeps its SQLSTATE.** The endpoint reports one as a rendered
 * message, so the code is lifted out of the `(SQLSTATE 42P04)` token the server
 * writes into it — a machine-written token, not prose. When there is none the
 * error simply carries no `code`, which fails closed: a caller absorbing `42P04`
 * rethrows rather than mistaking an unrelated failure for a duplicate.
 */

import { isRecord, omitUndefined } from "@alexkroman1/aai/utils";
import { SupabaseManagementAPI } from "supabase-management-js";

/**
 * A `drop database … with (force)` terminates live backends and a `create
 * database` copies a template; both are fast, and neither is worth holding a
 * deploy open for minutes when the control plane is unreachable. Long enough that
 * a slow-but-working call is not turned into a spurious failure.
 */
const MANAGEMENT_TIMEOUT_MS = 30_000;

/** Supabase project refs are 20 lowercase alphanumerics. */
const PROJECT_REF_RE = /^[a-z0-9]{20}$/;

/** Hosts whose labels may name a project ref. */
const SUPABASE_DOMAIN_RE = /(^|\.)supabase\.(co|com|in|net|red)$/;

/** The SQLSTATE token the query endpoint renders into a failed statement's message. */
const SQLSTATE_RE = /\bSQLSTATE\s+([0-9A-Za-z]{5})\b/;

/**
 * One project's query endpoint, narrowed to the one thing the platform asks of
 * it. The seam is what `app-db-admin.ts`'s tests inject, and what keeps the
 * generated SDK surface from leaking into every caller.
 */
export type SupabaseManagementApi = {
  /** The project this client is bound to — named in boot output and errors. */
  readonly ref: string;
  /** Run one statement against the project's `postgres` database, as `postgres`. */
  query(sql: string): Promise<Record<string, unknown>[]>;
};

/** True for a string shaped like a Supabase project ref. */
export function isProjectRef(value: string): boolean {
  return PROJECT_REF_RE.test(value);
}

/**
 * The Supabase project ref an admin Postgres URL names, or `undefined` when it
 * names no Supabase project (the local stack, a plain Postgres, an opaque proxy
 * host — all of which need `SUPABASE_PROJECT_REF` to say it instead).
 *
 * The username suffix is read FIRST because it is the authoritative one: a
 * Supavisor host is shared, so `postgres.<ref>` is the only thing distinguishing
 * one project's connection from another's on the same hostname.
 */
export function projectRefFromDbUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const user = decodeURIComponent(parsed.username);
  const suffix = user.includes(".") ? user.slice(user.indexOf(".") + 1) : "";
  if (isProjectRef(suffix)) return suffix;
  // Only under a Supabase domain: a 20-character label anywhere else is a
  // hostname, and guessing one would aim the control plane at another project.
  if (!SUPABASE_DOMAIN_RE.test(parsed.hostname)) return undefined;
  return parsed.hostname.split(".").find(isProjectRef);
}

export function createSupabaseManagementApi(opts: {
  ref: string;
  /** Personal access token (`sbp_…`) or an OAuth token, sent as a bearer. */
  token: string;
  /** Non-default control plane (staging, a local mock). Undefined = api.supabase.com. */
  baseUrl?: string | undefined;
}): SupabaseManagementApi {
  const api = new SupabaseManagementAPI({
    accessToken: opts.token,
    ...omitUndefined({ baseUrl: opts.baseUrl }),
  });
  return {
    ref: opts.ref,
    query: async (sql) => {
      const result = await api
        .runAQuery(opts.ref, { query: sql }, { signal: AbortSignal.timeout(MANAGEMENT_TIMEOUT_MS) })
        .catch((err: unknown) => {
          throw normalizeError(opts.ref, err);
        });
      return rowsOf(result.data);
    },
  };
}

/**
 * The endpoint answers a `select` with a JSON array. A statement with no result
 * set answers with an empty array — and, depending on the deployment, with an
 * empty body the SDK hands back as `""` — so both read as "no rows" rather than
 * as a parse failure: a `create database` that SUCCEEDED must not fail on the
 * shape of its own silence.
 */
function rowsOf(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data.filter(isRecord);
  // Defensive: an envelope shape (`{ result: [...] }`) reads the same way.
  if (isRecord(data) && Array.isArray(data.result)) return data.result.filter(isRecord);
  return [];
}

/**
 * Re-shape the SDK's error into one this package can read: the project in the
 * message, `status` kept, and the SQLSTATE lifted to `code`.
 *
 * A non-HTTP failure (an aborted timeout, DNS, a TLS error) is passed through
 * untouched — it has no status and no SQLSTATE, and wrapping it would only bury
 * the cause.
 */
function normalizeError(ref: string, err: unknown): unknown {
  if (!isRecord(err) || typeof err.status !== "number") return err;
  const detail = messageOf(err.data) ?? (typeof err.message === "string" ? err.message : "");
  return Object.assign(
    new Error(
      `Supabase Management API (project ${ref}) ${err.status}: ${detail.trim().slice(0, 500) || "no body"}`,
      { cause: err },
    ),
    { status: err.status },
    omitUndefined({ code: sqlStateOf(err.data, detail) }),
  );
}

/** The `message` a JSON error body carries, or the body itself when it is text. */
function messageOf(data: unknown): string | undefined {
  if (typeof data === "string") return data;
  if (isRecord(data) && typeof data.message === "string") return data.message;
  return undefined;
}

/**
 * Only a rendered `SQLSTATE …` token or an explicit five-character `code` field
 * is honoured: the API's own transport codes (`unauthorized`, and friends) are
 * not SQLSTATEs, and a caller absorbing `42P04` must never be handed one.
 */
function sqlStateOf(data: unknown, message: string): string | undefined {
  if (isRecord(data) && typeof data.code === "string" && /^[0-9A-Za-z]{5}$/.test(data.code)) {
    return data.code;
  }
  return SQLSTATE_RE.exec(message)?.[1];
}
