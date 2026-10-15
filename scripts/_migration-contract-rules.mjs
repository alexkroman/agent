// Copyright 2026 the AAI authors. MIT license.
/**
 * What `check-migration-contract.mjs` DECIDES, with no I/O in it.
 *
 * Its own module for the reason `_deploy-changeset-scope.mjs` is one:
 * `packages/aai-gates/src/migration-contract-gate.test.ts` value-imports these,
 * so positive and negative samples are fed to the real lexer, classifier and
 * reference search rather than to a regex scraped out of the gate. The gate
 * script owns every read — git, the migration files, the released tree.
 *
 * Three questions, one section each:
 *
 * 1. **What does a migration statement take from the code ALREADY in
 *    production?** ({@link classifyMigration}) — every statement that removes,
 *    renames or retypes something an old READER could name, tightens what an
 *    old WRITER may send, or drops a unique index an old UPSERT needs.
 * 2. **Does the released code still name it?** ({@link evaluateFinding}) — a
 *    search over the string and template literals of the released tree, which
 *    is where SQL lives in this codebase.
 * 3. **Which commit is "released"?** ({@link bumpedPackages}) — the same
 *    version-line test `ship.yml`'s `changed` job applies.
 *
 * The only import is the deploy-scope module, which is itself import-free, so
 * the property that makes the spec's import legal holds transitively.
 */

import { DEPLOY_CARRIERS, isShippedSource } from "./_deploy-changeset-scope.mjs";

/**
 * The reviewed escape hatch, written as a SQL comment on (or directly above)
 * the statement it excuses: `-- aai:contract-ok <reason>`.
 */
export const CONTRACT_OK_MARKER = "aai:contract-ok";

/**
 * The shortest reason the marker accepts. A marker is a claim a reviewer has to
 * be able to check ("the column has been unread since 0.40.0"), so a bare
 * marker — or one saying "ok" — is refused rather than honoured.
 */
export const MIN_REASON_CHARS = 12;

/**
 * The roles the platform's own server connects as. A `revoke` from anyone else
 * (`anon`, `authenticated`, `public` — the deny-all RLS hardening this tree does
 * routinely) cannot reach the released code, so only these count.
 */
export const SERVER_ROLES = ["postgres", "service_role"];

// ---------------------------------------------------------------------------
// 1. Lexing a migration
// ---------------------------------------------------------------------------

/**
 * @typedef {object} SqlStatement
 * @property {string} code The statement with comments and dollar-quote
 *   delimiters blanked, POSITION-ALIGNED with the source from `start`.
 * @property {number} start Offset of `code[0]` in the source.
 * @property {number} first Offset of the first code character — where the
 *   statement really begins, after the comments and blank lines before it.
 * @property {number} end Offset of the terminating `;` (or end of file).
 */

/**
 * @typedef {object} SqlComment
 * @property {string} text Without the `--` / `/*` delimiters.
 * @property {number} offset
 */

const blank = (text) => text.replace(/[^\n]/g, " ");

/** End offset (exclusive) of a nestable block comment opening at `i`. */
function blockCommentEnd(sql, i) {
  let depth = 0;
  let j = i;
  do {
    if (sql.startsWith("/*", j)) {
      depth++;
      j += 2;
    } else if (sql.startsWith("*/", j)) {
      depth--;
      j += 2;
    } else j++;
  } while (j < sql.length && depth > 0);
  return j;
}

/** End offset (exclusive) of a `'…'` / `"…"` opening at `i`, doubled quotes escaped. */
function quotedEnd(text, i) {
  const quote = text[i];
  let j = i + 1;
  while (j < text.length) {
    if (text[j] === quote && text[j + 1] === quote) j += 2;
    else if (text[j] === quote) return j + 1;
    else j++;
  }
  return text.length;
}

/**
 * The token opening at `i`, when it is not plain code.
 *
 * @returns {{ end: number, comment?: string, keep: boolean } | null} `keep`
 *   says whether its bytes stay in the statement (strings) or are blanked.
 */
function sqlToken(sql, i) {
  if (sql.startsWith("--", i)) {
    const stop = sql.indexOf("\n", i);
    const end = stop === -1 ? sql.length : stop;
    return { end, comment: sql.slice(i + 2, end), keep: false };
  }
  if (sql.startsWith("/*", i)) {
    const end = blockCommentEnd(sql, i);
    return { end, comment: sql.slice(i + 2, Math.max(i + 2, end - 2)), keep: false };
  }
  if (sql[i] === "'" || sql[i] === '"') return { end: quotedEnd(sql, i), keep: true };
  if (sql[i] === "$" && !/[\w$]/.test(sql[i - 1] ?? "")) {
    const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i, i + 64));
    if (tag) return { end: i + tag[0].length, keep: false };
  }
  return null;
}

/**
 * Split a migration into statements and comments.
 *
 * Dollar quotes are TRANSPARENT: their delimiters become spaces and their
 * bodies are lexed as code, so the DDL inside a `do $$ … $$` block — which is
 * where this tree writes every conditional rename and drop — is split on its own
 * `;` and seen like any other statement. Function bodies are split the same
 * way; their pieces are DML, which nothing below classifies.
 *
 * Single-quoted strings and quoted identifiers are kept verbatim and never
 * split on, so `';'` inside a literal does not end a statement.
 *
 * @param {string} sql
 * @returns {{ statements: SqlStatement[], comments: SqlComment[] }}
 */
export function lexSql(sql) {
  /** @type {SqlStatement[]} */
  const statements = [];
  /** @type {SqlComment[]} */
  const comments = [];
  let buffer = "";
  let start = 0;
  const flush = (end) => {
    const lead = buffer.search(/\S/);
    if (lead !== -1) statements.push({ code: buffer, start, first: start + lead, end });
    buffer = "";
    start = end + 1;
  };
  let i = 0;
  while (i < sql.length) {
    const token = sqlToken(sql, i);
    if (token) {
      if (token.comment !== undefined) comments.push({ text: token.comment, offset: i });
      const bytes = sql.slice(i, token.end);
      buffer += token.keep ? bytes : blank(bytes);
      i = token.end;
    } else if (sql[i] === ";") {
      flush(i);
      i++;
    } else {
      buffer += sql[i];
      i++;
    }
  }
  flush(sql.length);
  return { statements, comments };
}

/** Offsets at which each line starts, for {@link lineAt}. */
function lineStarts(text) {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === "\n") starts.push(i + 1);
  return starts;
}

/** The 1-based line holding `offset`. */
function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if ((starts[mid] ?? 0) <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

// ---------------------------------------------------------------------------
// 2. Classifying a statement
// ---------------------------------------------------------------------------

/**
 * @typedef {"relation" | "column" | "schema" | "function" | "type" | "extension" | "index" | "constraint" | "enum-value"} TargetType
 */

/** @typedef {{ schema: string | null, name: string }} QName */

/**
 * @typedef {object} Target
 * @property {TargetType} type
 * @property {string | null} schema
 * @property {string} name
 * @property {QName} [table] For a column, constraint or index: its relation.
 */

/**
 * Which half of the old code a finding can break.
 *
 * - `readers` — the object is GONE under its old name or shape (drop, rename,
 *   retype, move, revoke). Breaks any old code that names it.
 * - `writers-column` — a column now refuses what an old insert sends when it
 *   OMITS the column (`set not null`, `drop default`). Breaks old code that
 *   writes the table and never names the column.
 * - `writers-table` — the table now refuses rows it used to accept (a new
 *   check/unique/foreign key, a unique index, a NOT NULL column with no
 *   default). Breaks old code that writes the table at all; whether its rows
 *   satisfy the new rule is semantic, and only a reviewer can say.
 * - `conflict` — a UNIQUE index or constraint is dropped: a relaxation for
 *   every statement but one, `insert … on conflict (cols)`, which needs a
 *   matching unique index and fails outright without it.
 *
 * @typedef {"readers" | "writers-column" | "writers-table" | "conflict"} Rule
 */

/**
 * @typedef {object} Classified
 * @property {Rule} rule
 * @property {Target} target
 * @property {string} action Human phrasing, e.g. "drops column a.b.c".
 * @property {string[]} [columns] For a constraint or unique index: its columns.
 */

/**
 * @typedef {Classified & { line: number, statement: string, markers: Marker[] }} Finding
 *   `line` is the statement's DDL keyword; `statement` is whitespace-collapsed.
 */

/**
 * @typedef {object} Marker
 * @property {number} line
 * @property {string} reason
 */

const IDENT = "[a-z_][a-z0-9_$]*";
const QNAME = `${IDENT}(?:\\s*\\.\\s*${IDENT}){0,2}`;

/** @type {Map<string, TargetType>} */
const OBJECT_KINDS = new Map([
  ["table", "relation"],
  ["view", "relation"],
  ["materialized view", "relation"],
  ["foreign table", "relation"],
  ["sequence", "relation"],
  ["type", "type"],
  ["domain", "type"],
  ["function", "function"],
  ["procedure", "function"],
  ["routine", "function"],
  ["aggregate", "function"],
  ["schema", "schema"],
  ["extension", "extension"],
  ["index", "index"],
]);
const KINDS = [...OBJECT_KINDS.keys()].sort((a, b) => b.length - a.length).join("|");
const kindOf = (word) => OBJECT_KINDS.get(word) ?? "relation";

/** `schema.name` (or `a.b.c`, or `f(args)`) as its last two parts. @returns {QName} */
function qualified(raw) {
  const parts = raw
    .replace(/\(.*$/s, "")
    .split(".")
    .map((part) => part.trim())
    .filter(Boolean);
  return { schema: parts.length > 1 ? (parts.at(-2) ?? null) : null, name: parts.at(-1) ?? "" };
}

/** Split on commas at paren depth zero, outside single-quoted strings. */
function splitTopLevel(text) {
  const parts = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (const c of text) {
    if (c === "'") quoted = !quoted;
    else if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")") depth--;
    if (!quoted && depth === 0 && c === ",") {
      parts.push(current.trim());
      current = "";
    } else current += c;
  }
  if (current.trim() !== "") parts.push(current.trim());
  return parts;
}

/** Identifiers unquoted and lowercased, whitespace collapsed. */
const normalize = (code) =>
  code
    .replace(/"((?:[^"]|"")*)"/g, (_, ident) => ident.replace(/""/g, '"'))
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();

/** The first parenthesised list in `text`, as bare column names. */
function columnList(text) {
  const open = text.indexOf("(");
  if (open === -1) return [];
  let depth = 0;
  for (let i = open; i < text.length; i++) {
    if (text[i] === "(") depth++;
    if (text[i] === ")") depth--;
    if (depth === 0) {
      return splitTopLevel(text.slice(open + 1, i)).map((col) => col.split(" ")[0] ?? col);
    }
  }
  return [];
}

/** `schema.name`, or `schema.table.column` for a column. */
const display = (target) => {
  const owner =
    target.type === "column" && target.table
      ? `${display({ type: "relation", ...target.table })}.`
      : "";
  return `${owner}${target.schema ? `${target.schema}.` : ""}${target.name}`;
};

/** Postgres's own names for a primary key / unique constraint end like this. */
const isUniqueName = (name, uniqueDefs) => uniqueDefs.has(name) || /_(pkey|key)$/.test(name);

/**
 * @typedef {object} ActionContext
 * @property {QName} table
 * @property {string} tableName
 * @property {Map<string, QName>} uniqueDefs
 */

/** @param {QName} table @param {string} name @returns {Target} */
const columnOf = (table, name) => ({ type: "column", schema: null, name, table });

/**
 * `alter table … <action>` clauses, first match wins. Order matters where one
 * pattern is a prefix of another (`drop constraint` before `drop <column>`,
 * `rename to` before `rename <column>`).
 *
 * @type {[RegExp, (m: RegExpExecArray, ctx: ActionContext) => Classified[]][]}
 */
const TABLE_ACTIONS = [
  [
    new RegExp(`^drop constraint (?:if exists )?(${IDENT})`),
    (m, { table, tableName, uniqueDefs }) => {
      const name = m[1] ?? "";
      const target = { type: /** @type {TargetType} */ ("constraint"), schema: null, name, table };
      return isUniqueName(name, uniqueDefs)
        ? [{ rule: "conflict", target, action: `drops unique constraint ${name} on ${tableName}` }]
        : [{ rule: "readers", target, action: `drops constraint ${name} on ${tableName}` }];
    },
  ],
  [
    new RegExp(`^drop (?:column )?(?:if exists )?(${IDENT})`),
    (m, { table }) => {
      const target = columnOf(table, m[1] ?? "");
      return [{ rule: "readers", target, action: `drops column ${display(target)}` }];
    },
  ],
  [
    new RegExp(`^rename to (${IDENT})`),
    (m, { table, tableName }) => [
      {
        rule: "readers",
        target: { type: "relation", ...table },
        action: `renames ${tableName} to ${m[1]}`,
      },
    ],
  ],
  [
    new RegExp(`^rename constraint (${IDENT}) to`),
    (m, { table, tableName }) => [
      {
        rule: "readers",
        target: { type: "constraint", schema: null, name: m[1] ?? "", table },
        action: `renames constraint ${m[1]} on ${tableName}`,
      },
    ],
  ],
  [
    new RegExp(`^rename (?:column )?(${IDENT}) to (${IDENT})`),
    (m, { table }) => {
      const target = columnOf(table, m[1] ?? "");
      return [{ rule: "readers", target, action: `renames column ${display(target)} to ${m[2]}` }];
    },
  ],
  [
    new RegExp(`^alter (?:column )?(${IDENT}) (?:set data )?type `),
    (m, { table }) => {
      const target = columnOf(table, m[1] ?? "");
      return [{ rule: "readers", target, action: `changes the type of ${display(target)}` }];
    },
  ],
  [
    new RegExp(`^alter (?:column )?(${IDENT}) set not null`),
    (m, { table }) => {
      const target = columnOf(table, m[1] ?? "");
      return [{ rule: "writers-column", target, action: `makes ${display(target)} NOT NULL` }];
    },
  ],
  [
    new RegExp(`^alter (?:column )?(${IDENT}) drop default`),
    (m, { table }) => {
      const target = columnOf(table, m[1] ?? "");
      return [
        { rule: "writers-column", target, action: `drops the default of ${display(target)}` },
      ];
    },
  ],
  [
    /^set schema (\S+)/,
    (m, { table, tableName }) => [
      {
        rule: "readers",
        target: { type: "relation", ...table },
        action: `moves ${tableName} to schema ${m[1]}`,
      },
    ],
  ],
  [
    new RegExp(
      `^add (?:constraint (${IDENT}) )?(check|unique|primary key|foreign key|exclude)\\b(.*)$`,
    ),
    (m, { table, tableName }) => {
      const kind = m[2] ?? "";
      const named = m[1] ? ` ${m[1]}` : "";
      /** @type {Classified} */
      const finding = {
        rule: "writers-table",
        target: { type: "relation", ...table },
        action: `adds a ${kind.toUpperCase()} constraint${named} to ${tableName}`,
      };
      if (kind !== "check" && kind !== "exclude") finding.columns = columnList(m[3] ?? "");
      return [finding];
    },
  ],
  [
    new RegExp(`^add (?:column )?(?:if not exists )?(${IDENT}) (.*)$`),
    (m, { table, tableName }) => {
      const rest = m[2] ?? "";
      if (!/\bnot null\b/.test(rest) || /\b(default|generated)\b/.test(rest)) return [];
      return [
        {
          rule: "writers-table",
          target: { type: "relation", ...table },
          action: `adds ${tableName}.${m[1]} NOT NULL with no default`,
          columns: [m[1] ?? ""],
        },
      ];
    },
  ],
];

/**
 * One `alter table … <action>` clause, classified.
 *
 * @param {string} action Normalized.
 * @param {ActionContext} ctx
 * @returns {Classified[]}
 */
function classifyTableAction(action, ctx) {
  for (const [pattern, build] of TABLE_ACTIONS) {
    const m = pattern.exec(action);
    if (m) return build(m, ctx);
  }
  return [];
}

/** One `drop <kind> a, b` target. @returns {Classified} */
function dropTarget(kind, raw, uniqueDefs) {
  const type = kindOf(kind);
  const { schema, name } = qualified(raw);
  if (type === "index" && isUniqueName(name, uniqueDefs)) {
    const table = uniqueDefs.get(name);
    /** @type {Target} */
    const target = { type, schema, name };
    if (table !== undefined) target.table = table;
    return { rule: "conflict", target, action: `drops unique index ${name}` };
  }
  const target = { type, schema, name };
  return { rule: "readers", target, action: `drops ${kind} ${display(target)}` };
}

/**
 * Statement forms, first match wins.
 *
 * @type {[RegExp, (m: RegExpExecArray, uniqueDefs: Map<string, QName>) => Classified[]][]}
 */
const STATEMENT_FORMS = [
  [
    new RegExp(
      `^alter (?:table|view|materialized view|foreign table) (?:if exists )?(?:only )?(${QNAME}) ?\\*? (.*)$`,
    ),
    (m, uniqueDefs) => {
      const table = qualified(m[1] ?? "");
      const ctx = { table, tableName: display({ type: "relation", ...table }), uniqueDefs };
      return splitTopLevel(m[2] ?? "").flatMap((action) => classifyTableAction(action, ctx));
    },
  ],
  [
    new RegExp(
      `^drop (${KINDS}) (?:concurrently )?(?:if exists )?(.*?)(?: (?:cascade|restrict))?$`,
    ),
    (m, uniqueDefs) =>
      splitTopLevel(m[2] ?? "").map((raw) => dropTarget(m[1] ?? "", raw, uniqueDefs)),
  ],
  [
    new RegExp(`^alter type (${QNAME}) rename value '((?:[^']|'')*)'`),
    (m) => [
      {
        rule: "readers",
        target: { type: "enum-value", schema: null, name: m[2] ?? "" },
        action: `renames value '${m[2]}' of type ${m[1]}`,
      },
    ],
  ],
  [
    new RegExp(
      `^alter (${KINDS}) (?:if exists )?(${QNAME})(?: ?\\([^)]*\\))? (rename to|set schema) (\\S+)`,
    ),
    (m) => {
      const target = { type: kindOf(m[1] ?? ""), ...qualified(m[2] ?? "") };
      const verb = m[3] === "rename to" ? "renames" : "moves";
      const to = m[3] === "rename to" ? "to" : "to schema";
      return [
        { rule: "readers", target, action: `${verb} ${m[1]} ${display(target)} ${to} ${m[4]}` },
      ];
    },
  ],
  [
    new RegExp(
      `^create unique index (?:concurrently )?(?:if not exists )?(?:${IDENT} )?on (?:only )?(${QNAME})(.*)$`,
    ),
    (m) => {
      const target = { type: /** @type {TargetType} */ ("relation"), ...qualified(m[1] ?? "") };
      const columns = columnList(m[2] ?? "");
      return [
        {
          rule: "writers-table",
          target,
          action: `adds a unique index on ${display(target)}`,
          columns,
        },
      ];
    },
  ],
  [
    /^revoke .* on (?:(table|sequence|function|procedure|routine|schema|all tables in schema|all sequences in schema|all functions in schema) )?(.*?) from (.*?)(?: cascade| restrict)?$/,
    (m) => {
      if (!splitTopLevel(m[3] ?? "").some((role) => SERVER_ROLES.includes(role))) return [];
      const scope = m[1] ?? "table";
      const type = scope.includes("schema") ? "schema" : kindOf(scope);
      return splitTopLevel(m[2] ?? "").map((raw) => {
        const target = { type, ...qualified(raw) };
        return {
          rule: /** @type {Rule} */ ("readers"),
          target,
          action: `revokes privileges on ${display(target)}`,
        };
      });
    },
  ],
];

/**
 * Every finding one normalized statement yields.
 *
 * @param {string} s Normalized, starting at its DDL keyword, string literals
 *   intact (only `rename value` reads them).
 * @param {Map<string, QName>} uniqueDefs
 * @returns {Classified[]}
 */
function classifyStatement(s, uniqueDefs) {
  for (const [pattern, build] of STATEMENT_FORMS) {
    const m = pattern.exec(s);
    if (m) return build(m, uniqueDefs);
  }
  return [];
}

/** First DDL keyword in a statement, ignoring string literals. */
const HEAD = /\b(alter|drop|create|revoke)\b/i;

/** The statement from its DDL keyword on, normalized, or null. */
function headOf(statement) {
  const head = HEAD.exec(statement.code.replace(/'(?:[^']|'')*'/g, (q) => " ".repeat(q.length)));
  if (!head) return null;
  return { index: head.index, text: normalize(statement.code.slice(head.index)) };
}

const UNIQUE_INDEX = new RegExp(
  `^create unique index (?:concurrently )?(?:if not exists )?(${IDENT}) on (?:only )?(${QNAME})`,
);
const TABLE_DDL = new RegExp(
  `^(?:create table (?:if not exists )?|alter table (?:if exists )?(?:only )?)(${QNAME})`,
);

/**
 * Every UNIQUE index and constraint the migrations declare, by name.
 *
 * Read over the WHOLE directory, released files included, because a drop in an
 * unreleased migration names an index some earlier file created.
 *
 * @param {readonly string[]} sqls
 * @returns {Map<string, QName>}
 */
export function uniqueDefinitions(sqls) {
  /** @type {Map<string, QName>} */
  const defs = new Map();
  for (const s of headTexts(sqls)) {
    const index = UNIQUE_INDEX.exec(s);
    if (index) defs.set(index[1] ?? "", qualified(index[2] ?? ""));
    else tableConstraints(s, defs);
  }
  return defs;
}

/** Every DDL statement in `sqls`, normalized from its keyword. */
const headTexts = (sqls) =>
  sqls
    .flatMap((sql) => lexSql(sql).statements)
    .map(headOf)
    .flatMap((head) => (head ? [head.text] : []));

/** The unique/primary-key constraints a `create table` / `alter table` names. */
function tableConstraints(s, defs) {
  const ddl = TABLE_DDL.exec(s);
  if (!ddl) return;
  const table = qualified(ddl[1] ?? "");
  for (const c of s.matchAll(new RegExp(`constraint (${IDENT}) (?:unique|primary key)`, "g"))) {
    defs.set(c[1] ?? "", table);
  }
  if (s.startsWith("create table") && /\bprimary key\b/.test(s)) {
    defs.set(`${table.name}_pkey`, table);
  }
}

/**
 * Which statement a marker comment excuses: the one it sits INSIDE, the one
 * whose `;` it trails on the same line, or else the NEXT one after it — i.e.
 * written directly above, where a reason reads naturally.
 *
 * @param {SqlStatement[]} statements
 * @param {number} offset
 * @param {number[]} starts
 */
function markerOwner(statements, offset, starts) {
  const inside = statements.findIndex((st) => offset >= st.first && offset <= st.end);
  if (inside !== -1) return inside;
  const line = lineAt(starts, offset);
  const trailing = statements.findIndex((st) => st.end < offset && lineAt(starts, st.end) === line);
  if (trailing !== -1) return trailing;
  return statements.findIndex((st) => st.first > offset);
}

/**
 * Every contraction one migration makes, each with the `aai:contract-ok`
 * markers that excuse it, plus every marker in the file (so the gate can
 * refuse one with no reason, whatever it is attached to).
 *
 * @param {string} sql
 * @param {Map<string, QName>} [uniqueDefs]
 * @returns {{ findings: Finding[], markers: Marker[] }}
 */
export function classifyMigration(sql, uniqueDefs = new Map()) {
  const { statements, comments } = lexSql(sql);
  const starts = lineStarts(sql);
  /** @type {Map<number, Marker[]>} */
  const byStatement = new Map();
  /** @type {Marker[]} */
  const markers = [];
  for (const comment of comments) {
    const at = comment.text.indexOf(CONTRACT_OK_MARKER);
    if (at === -1) continue;
    const reason = comment.text
      .slice(at + CONTRACT_OK_MARKER.length)
      .replace(/^[\s:—-]+/, "")
      .trim();
    const marker = { line: lineAt(starts, comment.offset), reason };
    markers.push(marker);
    const owner = markerOwner(statements, comment.offset, starts);
    if (owner !== -1) byStatement.set(owner, [...(byStatement.get(owner) ?? []), marker]);
  }
  /** @type {Finding[]} */
  const findings = [];
  for (const [index, statement] of statements.entries()) {
    const head = headOf(statement);
    if (!head) continue;
    const line = lineAt(starts, statement.start + head.index);
    const owned = byStatement.get(index) ?? [];
    for (const found of classifyStatement(head.text, uniqueDefs)) {
      findings.push({ ...found, line, statement: head.text, markers: owned });
    }
  }
  return { findings, markers };
}

const ADD_COLUMN = new RegExp(`^add (?:column )?(?:if not exists )?(${IDENT}) `);
const ALTER_TABLE = new RegExp(`^alter table (?:if exists )?(?:only )?(${QNAME}) (.*)$`);

/**
 * Columns an unreleased batch ADDS, as `schema.table.column` — so a unique
 * index or foreign key over nothing but brand-new columns is not charged to old
 * writers, who send NULL there, and NULL satisfies both.
 *
 * @param {readonly string[]} sqls
 * @returns {Set<string>}
 */
export function addedColumns(sqls) {
  const added = new Set();
  for (const s of headTexts(sqls)) {
    const alter = ALTER_TABLE.exec(s);
    if (!alter) continue;
    const table = qualified(alter[1] ?? "");
    for (const action of splitTopLevel(alter[2] ?? "")) {
      const col = ADD_COLUMN.exec(action)?.[1];
      if (col && !/^(constraint|check|unique|primary|foreign|exclude)$/.test(col)) {
        added.add(`${table.schema ?? ""}.${table.name}.${col}`);
      }
    }
  }
  return added;
}

// ---------------------------------------------------------------------------
// 3. The released code's literals
// ---------------------------------------------------------------------------

/**
 * Does this released path count as code that can name a schema object?
 *
 * `isShippedSource` (no tests, test helpers or markdown) narrowed further to
 * code under a package's `src/`, minus the `_*-harness.ts` modules that exist
 * only for specs to import.
 *
 * @param {string} path
 */
export function isReferenceSource(path) {
  if (!/^packages\/[^/]+\/src\//.test(path)) return false;
  if (!/\.(?:[cm]?[jt]sx?|sql)$/.test(path)) return false;
  if (/\/_[^/]*harness\.[cm]?[jt]sx?$/.test(path)) return false;
  return isShippedSource(path);
}

/**
 * @typedef {object} Literal
 * @property {number} start Offset in the source.
 * @property {string} text
 */

const REGEX_KEYWORDS = new Set([
  "return",
  "typeof",
  "case",
  "do",
  "else",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "yield",
  "await",
]);

/** Can a `/` after this token start a regex literal (rather than divide)? */
const regexMayStart = (prev) =>
  prev === "" || REGEX_KEYWORDS.has(prev) || /^[(,=:[!&|?{};+\-*%<>~^]$/.test(prev);

/** End offset (exclusive) of a regex literal at `i`, or -1 if it is not one. */
function regexEnd(source, i) {
  let inClass = false;
  for (let j = i + 1; j < source.length && source[j] !== "\n"; j++) {
    const c = source[j];
    if (c === "\\") j++;
    else if (c === "[") inClass = true;
    else if (c === "]") inClass = false;
    else if (c === "/" && !inClass) return j + 1;
  }
  return -1;
}

/** End offset (exclusive) of a comment at `i`, or -1. */
function jsCommentEnd(source, i) {
  if (source.startsWith("//", i)) {
    const stop = source.indexOf("\n", i);
    return stop === -1 ? source.length : stop;
  }
  if (source.startsWith("/*", i)) {
    const stop = source.indexOf("*/", i + 2);
    return stop === -1 ? source.length : stop + 2;
  }
  return -1;
}

/**
 * A small JS/TS scanner that keeps only what is inside quotes.
 *
 * A template's `${…}` holes are code (scanned recursively by brace depth); the
 * static chunks around them are literals. Regex literals are skipped by the
 * usual previous-token heuristic.
 */
class LiteralScanner {
  /** @param {string} source */
  constructor(source) {
    this.source = source;
    /** @type {Literal[]} */
    this.out = [];
    /** @type {number[]} brace depth inside each open `${` */
    this.holes = [];
    this.prev = "";
  }

  /** Read template text from `from` to the next `` ` `` or `${`. */
  template(from) {
    const { source } = this;
    let j = from;
    while (j < source.length && source[j] !== "`" && !source.startsWith("${", j)) {
      j += source[j] === "\\" ? 2 : 1;
    }
    this.out.push({ start: from, text: source.slice(from, j) });
    if (source.startsWith("${", j)) {
      this.holes.push(0);
      return j + 2;
    }
    return j + 1;
  }

  /** Read a `'…'` / `"…"` at `i`. */
  quoted(i) {
    const { source } = this;
    const quote = source[i];
    let j = i + 1;
    while (j < source.length && source[j] !== quote && source[j] !== "\n")
      j += source[j] === "\\" ? 2 : 1;
    this.out.push({ start: i + 1, text: source.slice(i + 1, j) });
    return j + 1;
  }

  /** A brace while inside a `${…}` hole; returns where to resume, or -1. */
  brace(c, i) {
    const depth = this.holes.at(-1);
    if (depth === undefined) return -1;
    if (c === "{") this.holes[this.holes.length - 1] = depth + 1;
    else if (depth > 0) this.holes[this.holes.length - 1] = depth - 1;
    else {
      this.holes.pop();
      return this.template(i + 1);
    }
    return -1;
  }

  /** Advance past whatever starts at `i`; returns the next offset. */
  step(i) {
    const { source } = this;
    const c = source[i] ?? "";
    const comment = jsCommentEnd(source, i);
    if (comment !== -1) return comment;
    if (c === "'" || c === '"' || c === "`") {
      this.prev = "a";
      return c === "`" ? this.template(i + 1) : this.quoted(i);
    }
    if (c === "{" || c === "}") {
      const resumed = this.brace(c, i);
      if (resumed !== -1) {
        this.prev = "a";
        return resumed;
      }
    }
    const regex = c === "/" && regexMayStart(this.prev) ? regexEnd(source, i) : -1;
    if (regex !== -1) {
      this.prev = "a";
      return regex;
    }
    const word = /^[\w$]+/.exec(source.slice(i, i + 64))?.[0];
    if (word) {
      this.prev = word;
      return i + word.length;
    }
    if (/\S/.test(c)) this.prev = c;
    return i + 1;
  }

  /** @returns {Literal[]} */
  run() {
    let i = 0;
    while (i < this.source.length) i = this.step(i);
    return this.out;
  }
}

/**
 * The string and template-literal contents of a JS/TS source — the only place
 * SQL can live in it. Comments and code are dropped, so prose explaining why a
 * table is GONE (there is a lot of it here) is not a reference to the table.
 *
 * @param {string} source
 * @returns {Literal[]}
 */
export const jsLiterals = (source) => new LiteralScanner(source).run();

/**
 * @typedef {object} SourceFile
 * @property {string} path
 * @property {string} source
 * @property {Literal[]} literals
 * @property {number[]} starts
 */

/**
 * @param {string} path
 * @param {string} source
 * @returns {SourceFile}
 */
export function prepareSource(path, source) {
  const literals = path.endsWith(".sql")
    ? lexSql(source).statements.map((st) => ({ start: st.start, text: st.code }))
    : jsLiterals(source);
  return { path, source, literals, starts: lineStarts(source) };
}

/**
 * @typedef {object} Hit
 * @property {string} path
 * @property {number} line
 * @property {string} text The source line, trimmed.
 */

const escapeRe = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const word = (name) => new RegExp(`(?<![A-Za-z0-9_$])${escapeRe(name)}(?![A-Za-z0-9_$])`, "gi");

/** Line `line` of the file, trimmed and capped for a report. */
function lineText(file, line) {
  const from = file.starts[line - 1] ?? 0;
  const to = file.starts[line] ?? file.source.length + 1;
  const text = file.source.slice(from, to - 1).trim();
  return text.length > 140 ? `${text.slice(0, 137)}...` : text;
}

/** Every LINE on which `re` matches inside the file's literals. @returns {Hit[]} */
function literalHits(file, re) {
  /** @type {Map<number, Hit>} */
  const hits = new Map();
  for (const literal of file.literals) {
    for (const m of literal.text.matchAll(re)) {
      const line = lineAt(file.starts, literal.start + (m.index ?? 0));
      if (!hits.has(line)) hits.set(line, { path: file.path, line, text: lineText(file, line) });
    }
  }
  return [...hits.values()];
}

/**
 * Where the file names this relation (or function/type) in a literal.
 *
 * Schema-qualified names outside `public` must be QUALIFIED in the file, or the
 * file must name the schema somewhere in a literal too — so `"/agents"` in a
 * CLI route string is not mistaken for `aai_platform.agents`, while a
 * `const T = "agents"` beside an `aai_platform.${T}` still counts.
 *
 * @param {SourceFile} file
 * @param {QName} object
 * @returns {Hit[]}
 */
function relationHits(file, object) {
  const hits = literalHits(file, word(object.name));
  if (hits.length === 0 || !object.schema || object.schema === "public") return hits;
  return literalHits(file, word(object.schema)).length > 0 ? hits : [];
}

/** A schema is named as a qualifier (`aai_admin.`) or as a whole literal. @returns {Hit[]} */
function schemaHits(file, schema) {
  const hits = literalHits(
    file,
    new RegExp(`(?<![A-Za-z0-9_$])"?${escapeRe(schema)}"?\\s*\\.`, "gi"),
  );
  for (const literal of file.literals) {
    if (literal.text.trim().toLowerCase() !== schema) continue;
    const line = lineAt(file.starts, literal.start);
    hits.push({ path: file.path, line, text: lineText(file, line) });
  }
  return hits;
}

/**
 * @typedef {object} Verdict
 * @property {boolean} breaks
 * @property {Hit[]} hits Where the released code names the target (for a
 *   `writers-column` failure: where it uses the TABLE without the column).
 * @property {string} why
 */

/** Where the corpus names what a `readers` finding removes. @returns {Hit[]} */
function readerHits(target, corpus) {
  const table = target.table ?? target;
  switch (target.type) {
    case "column":
      return corpus.flatMap((file) =>
        relationHits(file, table).length > 0 ? literalHits(file, word(target.name)) : [],
      );
    case "schema":
      return corpus.flatMap((file) => schemaHits(file, target.name));
    case "type":
      if (!target.schema || target.schema === "public") {
        // An unqualified type is named in a CAST; its bare name (`status`) is
        // far too common a word to search for on its own.
        const cast = new RegExp(`::\\s*"?${escapeRe(target.name)}"?(?![A-Za-z0-9_$])`, "gi");
        return corpus.flatMap((file) => literalHits(file, cast));
      }
      return corpus.flatMap((file) => relationHits(file, target));
    case "relation":
    case "function":
      return corpus.flatMap((file) => relationHits(file, target));
    default:
      return corpus.flatMap((file) => literalHits(file, word(target.name)));
  }
}

/** @returns {Verdict} */
function writersColumnVerdict(target, corpus) {
  const table = target.table ?? target;
  const files = corpus.filter((file) => relationHits(file, table).length > 0);
  const named = files.flatMap((file) => literalHits(file, word(target.name)));
  if (files.length === 0 || named.length > 0) {
    return {
      breaks: false,
      hits: named,
      why: "the released code writes the column, or not the table",
    };
  }
  return {
    breaks: true,
    hits: files.flatMap((file) => relationHits(file, table)),
    why: `the released code uses ${display({ type: "relation", ...table })} but never names ${target.name}, so its inserts omit it`,
  };
}

/** @returns {Verdict} */
function writersTableVerdict(finding, corpus, newColumns) {
  const { target } = finding;
  const prefix = `${target.schema ?? ""}.${target.name}.`;
  const columns = finding.columns ?? [];
  if (columns.length > 0 && columns.every((col) => newColumns.has(prefix + col))) {
    return { breaks: false, hits: [], why: "every column it constrains is new in this release" };
  }
  const hits = corpus.flatMap((file) => relationHits(file, target));
  return {
    breaks: hits.length > 0,
    hits,
    why: "the released code writes this table, and nothing here can prove its rows satisfy the new rule",
  };
}

/** @returns {Verdict} */
function conflictVerdict(target, corpus) {
  const byName = corpus.flatMap((file) => literalHits(file, word(target.name)));
  const table = target.table;
  const upserts = table
    ? corpus.flatMap((file) =>
        relationHits(file, table).length > 0 ? literalHits(file, /\bon\s+conflict\b/gi) : [],
      )
    : [];
  const hits = [...byName, ...upserts];
  return {
    breaks: hits.length > 0,
    hits,
    why: "the released code names it, or upserts into its table with ON CONFLICT, which needs a matching unique index",
  };
}

/**
 * Does the released code still depend on what this finding takes away?
 *
 * @param {Classified} finding
 * @param {readonly SourceFile[]} corpus The serving tree's reference sources.
 * @param {Set<string>} [newColumns] From {@link addedColumns}.
 * @returns {Verdict}
 */
export function evaluateFinding(finding, corpus, newColumns = new Set()) {
  switch (finding.rule) {
    case "readers": {
      const hits = readerHits(finding.target, corpus);
      return { breaks: hits.length > 0, hits, why: "the released code still names it" };
    }
    case "writers-column":
      return writersColumnVerdict(finding.target, corpus);
    case "writers-table":
      return writersTableVerdict(finding, corpus, newColumns);
    default:
      return conflictVerdict(finding.target, corpus);
  }
}

// ---------------------------------------------------------------------------
// 4. Which commit is the release
// ---------------------------------------------------------------------------

/**
 * The workspace packages whose `package.json` gained a `"version":` line in a
 * `git diff <c>^ <c>` — the exact test `ship.yml`'s `changed` job applies
 * (`grep -q '^+.*"version":'`), and one level deep for the reason it gives.
 *
 * @param {string} diff
 * @returns {Set<string>}
 */
export function bumpedPackages(diff) {
  const bumped = new Set();
  /** @type {string | null} */
  let current = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("diff --git")) {
      current = /^diff --git a\/packages\/([^/]+)\/package\.json b\//.exec(line)?.[1] ?? null;
    } else if (current && !line.startsWith("+++") && /^\+.*"version":/.test(line)) {
      bumped.add(current);
    }
  }
  return bumped;
}

/** Does this bump set arm `ship.yml`'s deploy job? @param {Set<string>} bumped */
export const armsDeploy = (bumped) => DEPLOY_CARRIERS.some((name) => bumped.has(name));
