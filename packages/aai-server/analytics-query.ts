// Copyright 2026 the AAI authors. MIT license.
/**
 * The guard around model-authored SQL, and the aggregation behind the
 * studio's default Analytics view.
 *
 * ## The threat, stated precisely
 *
 * `query_analytics` hands an LLM a SQL prompt against the platform's own
 * Postgres, over the connection that OWNS every control-plane table. The
 * statement is untrusted in the strict sense — a prompt-injected coding agent
 * is a realistic author of it — so "the model probably won't" is not part of
 * the design. Three independent things have to hold, and none of them is a
 * keyword blocklist on its own:
 *
 * 1. **The user's statement can only NAME one relation.** Everything runs
 *    wrapped in a CTE called `events`, already filtered to the caller's own
 *    slugs. Reaching a platform table needs a schema qualifier, because
 *    `aai_platform` is not on the connection's `search_path` — every store in
 *    this package writes `aai_platform.x` in full, and that is why. So
 *    `select * from studio_workspaces` does not resolve to anything; it
 *    errors. {@link validateAnalyticsSql} then rejects the qualified spelling.
 * 2. **`pg_catalog` IS always on the search path**, which is the real hole a
 *    CTE wrapper leaves open: `pg_authid`, `pg_read_file`, `pg_settings` are
 *    all reachable unqualified. Every `pg_`-prefixed identifier is rejected
 *    for that reason, not as generic hygiene.
 * 3. **Only one statement, and only a reading one.** A trailing `;` plus a
 *    second statement would escape the wrapper entirely, and a data-modifying
 *    CTE (`with x as (delete from …)`) is legal SQL inside a `with`.
 *
 * The validator is deliberately a REJECT-list over a tokenized statement
 * rather than a parser: a SQL parser here would be a bigger thing to trust
 * than the surface it guards, and every rejection is recoverable — the model
 * is told what it may not do and writes the query again. What it cannot be is
 * ADVISORY, so the wrapper is applied unconditionally and the validator runs
 * before it, never instead of it.
 *
 * What this does NOT claim: it is not a substitute for a read-only role. The
 * statement runs on the platform's own connection, so a hole in these rules
 * is a hole in the control plane, not merely in analytics. A dedicated
 * `aai_analytics_reader` login role with `select` on exactly this table is
 * the structural fix, and it is the follow-up recorded in
 * `packages/aai-server/CLAUDE.md`.
 */

import { ANALYTICS_QUERY_ROW_CAP } from "./analytics-store.ts";

/** Schemas and identifier prefixes a scoped query may never name. */
const FORBIDDEN_IDENTIFIERS = [
  "aai_platform",
  "information_schema",
  "vault",
  "cron",
  "pgmq",
  "storage",
  "auth",
  "extensions",
  "realtime",
];

/**
 * Statement kinds that may not appear ANYWHERE — including inside a `with`,
 * where Postgres happily accepts a data-modifying CTE.
 */
const FORBIDDEN_KEYWORDS = [
  "insert",
  "update",
  "delete",
  "drop",
  "alter",
  "create",
  "truncate",
  "grant",
  "revoke",
  "copy",
  "call",
  "do",
  "execute",
  "vacuum",
  "analyze",
  "set",
  "reset",
  "listen",
  "notify",
  "lock",
  "begin",
  "commit",
  "rollback",
  "prepare",
  "refresh",
  "comment",
  "security",
];

/** Max characters of SQL accepted — a bound on what the parser has to chew. */
const MAX_SQL_CHARS = 4000;

/**
 * Blank out string literals and comments so the keyword and identifier scans
 * below see only SQL a caller can execute.
 *
 * Masking exists for the false positive: a transcript filter
 * (`where body ilike '%delete my account%'`) is a legitimate query and must
 * not be rejected for a word inside the quotes — that rejection is exactly
 * what would push someone to weaken the real rules.
 *
 * **It is ONE left-to-right pass, and it has to be.** This was a chain of
 * independent `replace`s, and no ORDER of those is correct — each order breaks
 * the other construct, in the direction that matters:
 *
 * - comments first (what shipped): a `--` inside a literal blanked the rest of
 *   the line for the scanner while Postgres read it as data, so
 *   `where body = 'x--' union all select rolname from pg_roles` validated
 *   clean and returned `pg_roles`;
 * - literals first: an apostrophe inside a comment (`-- don't`) opens a
 *   literal that swallows everything to the next quote.
 *
 * Only a scanner that consumes each construct **in source order** sees what
 * Postgres sees.
 *
 * **An ambiguity is a REFUSAL, never a guess.** Every case this cannot parse —
 * an unterminated literal or comment, an escape-string prefix (`E'…'`, `U&'…'`)
 * whose backslash rules change where the literal ends — returns an error
 * instead of masking. Guessing long is a bypass (real SQL hidden from the
 * scanner) and guessing short is a false positive; a message the model can act
 * on is neither, and nothing that belongs in an analytics query needs those
 * forms.
 */
/**
 * What one construct's scanner did: the text to emit in its place and where
 * to resume, or the refusal that ends the whole scan. `null` means "not this
 * construct" — the next scanner gets a turn.
 */
type Scan = { emit: string; next: number } | { error: string } | null;

/** Consume a quoted run ending at the next unescaped `quote`; `''` doubles. */
function closeQuoted(sql: string, start: number, quote: string): number {
  let j = start + 1;
  while (j < sql.length) {
    if (sql[j] !== quote) {
      j += 1;
    } else if (sql[j + 1] === quote) {
      j += 2;
    } else {
      return j + 1;
    }
  }
  return -1;
}

function scanLineComment(sql: string, i: number): Scan {
  if (!(sql[i] === "-" && sql[i + 1] === "-")) return null;
  const end = sql.indexOf("\n", i);
  // The newline itself is left in place: it is what ends the comment, and
  // dropping it would join two lines into one token.
  return { emit: " ", next: end === -1 ? sql.length : end };
}

/** Block comments NEST in Postgres, unlike C. */
function scanBlockComment(sql: string, i: number): Scan {
  if (!(sql[i] === "/" && sql[i + 1] === "*")) return null;
  let depth = 1;
  let j = i + 2;
  while (j < sql.length && depth > 0) {
    if (sql[j] === "/" && sql[j + 1] === "*") {
      depth += 1;
      j += 2;
    } else if (sql[j] === "*" && sql[j + 1] === "/") {
      depth -= 1;
      j += 2;
    } else {
      j += 1;
    }
  }
  if (depth > 0) return { error: "Unterminated block comment (`/*`)." };
  return { emit: " ", next: j };
}

function scanDollarQuoted(sql: string, i: number): Scan {
  if (sql[i] !== "$") return null;
  const tag = /^\$(?:[A-Za-z_][A-Za-z0-9_]*)?\$/.exec(sql.slice(i))?.[0];
  if (tag === undefined) return null;
  const end = sql.indexOf(tag, i + tag.length);
  if (end === -1) return { error: "Unterminated dollar-quoted string." };
  return { emit: "''", next: end + tag.length };
}

function scanSingleQuoted(sql: string, i: number): Scan {
  if (sql[i] !== "'") return null;
  // A letter or `&` fused to the quote is a literal PREFIX (`E'…'`, `U&'…'`,
  // `B'…'`), and `E` changes what a backslash means — i.e. where the literal
  // ends. Refused rather than parsed two ways.
  const before = sql[i - 1];
  if (before !== undefined && /[A-Za-z&]/.test(before)) {
    return { error: "Escape-string literals (`E'…'`, `U&'…'`) are not allowed." };
  }
  const end = closeQuoted(sql, i, "'");
  if (end === -1) return { error: "Unterminated string literal (`'`)." };
  return { emit: "''", next: end };
}

function scanDoubleQuoted(sql: string, i: number): Scan {
  if (sql[i] !== '"') return null;
  const end = closeQuoted(sql, i, '"');
  if (end === -1) return { error: 'Unterminated quoted identifier (`"`).' };
  return { emit: '""', next: end };
}

/**
 * In source order, which is the whole point — see {@link maskLiterals}. Two
 * scanners never both match at one position, so the order within this array
 * is arbitrary; the order they run in RELATIVE TO THE INPUT is not.
 */
const SCANNERS = [
  scanLineComment,
  scanBlockComment,
  scanDollarQuoted,
  scanSingleQuoted,
  scanDoubleQuoted,
];

function maskLiterals(sql: string): { masked: string } | { error: string } {
  let out = "";
  let i = 0;
  outer: while (i < sql.length) {
    for (const scan of SCANNERS) {
      const result = scan(sql, i);
      if (result === null) continue;
      if ("error" in result) return result;
      out += result.emit;
      i = result.next;
      continue outer;
    }
    out += sql[i];
    i += 1;
  }
  return { masked: out };
}

/**
 * Validate one model-authored statement. Returns an error MESSAGE (addressed
 * to the model, so it can fix and retry) or null when the statement is
 * acceptable.
 */
export function validateAnalyticsSql(sql: string): string | null {
  const trimmed = sql.trim();
  if (trimmed.length === 0) return "Empty query.";
  if (trimmed.length > MAX_SQL_CHARS) {
    return `Query too long (${trimmed.length} chars; max ${MAX_SQL_CHARS}).`;
  }

  const scan = maskLiterals(trimmed);
  if ("error" in scan) return scan.error;
  const masked = scan.masked;

  // One statement. A trailing semicolon is idiomatic and harmless; anything
  // after it is a second statement outside the scoping wrapper.
  const withoutTrailing = masked.replace(/;\s*$/, "");
  if (withoutTrailing.includes(";")) {
    return "Only one statement per query — remove the extra `;`.";
  }

  if (!/^\s*(select|with)\b/i.test(withoutTrailing)) {
    return "Only SELECT (or WITH … SELECT) queries are allowed.";
  }

  const lowered = withoutTrailing.toLowerCase();
  for (const keyword of FORBIDDEN_KEYWORDS) {
    if (new RegExp(`\\b${keyword}\\b`).test(lowered)) {
      return `\`${keyword}\` is not allowed — analytics queries are read-only.`;
    }
  }

  // `pg_` covers pg_catalog's tables AND its functions (pg_read_file,
  // pg_sleep), which is the whole reason it is a prefix rule.
  if (/\bpg_\w*/.test(lowered)) {
    return "Identifiers starting with `pg_` are not allowed.";
  }
  for (const identifier of FORBIDDEN_IDENTIFIERS) {
    if (new RegExp(`\\b${identifier}\\b`).test(lowered)) {
      return `\`${identifier}\` is not queryable here — select from \`events\` instead.`;
    }
  }
  return null;
}

/**
 * The column list the `events` CTE exposes, and the ONE description of the
 * schema. The tool description, the pane's help text, and this wrapper all
 * read it, so a column added to the table cannot be advertised to a model
 * without also being selectable.
 */
export const ANALYTICS_COLUMNS = [
  "slug",
  "agent_version",
  "session_id",
  "ts",
  "kind",
  "turn",
  "duration_ms",
  "level",
  "name",
  "body",
  "ok",
  "data",
] as const;

/** The CTE's select list, joined once rather than per query. */
const ANALYTICS_COLUMN_LIST = ANALYTICS_COLUMNS.join(", ");

export type ScopedAnalyticsQuery = {
  sql: string;
  params: unknown[];
  /**
   * The row cap actually compiled into {@link ScopedAnalyticsQuery.sql} — the
   * caller's `limit` clamped to {@link ANALYTICS_QUERY_ROW_CAP}.
   *
   * Carried rather than re-derived because the store is what decides
   * `truncated`, and it has no other way to know: reading the module cap
   * instead means a caller-supplied limit can never report truncation. Every
   * `query_analytics` call sends `limit: 100`, so the statement ran
   * `limit 101`, 101 rows came back, and the model was told `truncated: false`
   * every time.
   */
  limit: number;
};

/**
 * Wrap a validated statement so it can only see this caller's rows.
 *
 * The user's SQL becomes a subquery of a `select … limit`, under a CTE that
 * is already filtered by slug and retention window. Both the slug list and
 * the window are BOUND PARAMETERS — nothing a caller controls is ever
 * interpolated into SQL text, so the wrapper itself cannot be escaped by a
 * crafted project name.
 */
export function buildScopedAnalyticsQuery(opts: {
  sql: string;
  slugs: readonly string[];
  retentionDays: number;
  limit?: number;
}): ScopedAnalyticsQuery {
  const limit = Math.min(opts.limit ?? ANALYTICS_QUERY_ROW_CAP, ANALYTICS_QUERY_ROW_CAP);
  return {
    // `limit + 1` so the store can tell "exactly at the cap" from "truncated"
    // without a second count query.
    sql: `with events as (
  select ${ANALYTICS_COLUMN_LIST}
    from aai_platform.agent_events
   where slug = any($1) and received_at >= now() - ($2 || ' days')::interval
)
select * from (
${opts.sql.trim().replace(/;\s*$/, "")}
) as _scoped limit ${limit + 1}`,
    params: [[...opts.slugs], String(opts.retentionDays)],
    limit,
  };
}
