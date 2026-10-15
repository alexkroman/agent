// Copyright 2026 the AAI authors. MIT license.
/// <reference types="vite/client" />
/**
 * `scripts/check-migration-contract.mjs` — the gate that an UNRELEASED
 * migration does not contract the schema under the code that is still serving.
 *
 * `ship.yml` applies migrations BEFORE the rolling deploy, so the previous
 * release's server keeps running against the new schema for the whole rollout
 * (and for good after a failed deploy or a `modal app rollback`). CI only ever
 * applies migrations to an EMPTY database, where every contraction succeeds, so
 * this gate is the only thing that can see one land a release too early.
 *
 * The decisions are VALUE-imported from `scripts/_migration-contract-rules.mjs`
 * — the lexer, the statement classifier, the literal scan of the released tree
 * and the version-line test — for the reason `deploy-changeset-gate.test.ts`
 * records: a regex scraped out of a gate goes vacuous the day the rule moves.
 * Every case is a PAIR, the contraction the gate must catch beside the
 * neighbouring change it must let through, because the gate's whole success
 * output is a checkmark and a classifier that matched nothing would print it.
 *
 * What it cannot hold here is the git half (the release walk, the
 * `cat-file --batch` read of the serving tree): a unit spec may not spawn git.
 * That half was exercised by hand when the gate landed — a planted migration
 * dropping `agents.worker_hash`, renaming `workflow_runs.label`, dropping
 * `session_events`, retyping inside a `do $$` block and setting a brand-new
 * column NOT NULL each failed naming the released `file:line`, while the
 * reasoned marker and the unique index over a new column passed.
 */

import { describe, expect, test } from "vitest";
import { GATE_WIRING, numericConstant, sole } from "./_gate-support.ts";

type Rule = "readers" | "writers-column" | "writers-table" | "conflict";
interface Target {
  type: string;
  schema: string | null;
  name: string;
  table?: { schema: string | null; name: string } | undefined;
}
interface Finding {
  rule: Rule;
  target: Target;
  action: string;
  line: number;
  statement: string;
  columns?: string[];
  markers: { line: number; reason: string }[];
}
interface Hit {
  path: string;
  line: number;
  text: string;
}
type SourceFile = { path: string };
type Defs = Map<string, { schema: string | null; name: string }>;

/** The gate's real decisions, imported rather than re-derived. */
const rules = sole(
  import.meta.glob<{
    CONTRACT_OK_MARKER: string;
    MIN_REASON_CHARS: number;
    classifyMigration: (
      sql: string,
      uniqueDefs?: Defs,
    ) => { findings: Finding[]; markers: { line: number; reason: string }[] };
    uniqueDefinitions: (sqls: readonly string[]) => Defs;
    addedColumns: (sqls: readonly string[]) => Set<string>;
    jsLiterals: (source: string) => { start: number; text: string }[];
    isReferenceSource: (path: string) => boolean;
    prepareSource: (path: string, source: string) => SourceFile;
    evaluateFinding: (
      finding: Finding,
      corpus: readonly SourceFile[],
      newColumns?: Set<string>,
    ) => { breaks: boolean; hits: Hit[]; why: string };
    bumpedPackages: (diff: string) => Set<string>;
    armsDeploy: (bumped: Set<string>) => boolean;
  }>("../../../scripts/_migration-contract-rules.mjs", { eager: true }),
);

const script = sole(
  import.meta.glob<string>("../../../scripts/check-migration-contract.mjs", {
    query: "?raw",
    import: "default",
    eager: true,
  }),
);

/** The real migrations, by filename — the corpus the gate classifies. */
const migrations = Object.fromEntries(
  Object.entries(
    import.meta.glob<string>("../../../supabase/migrations/*.sql", {
      query: "?raw",
      import: "default",
      eager: true,
    }),
  ).map(([key, sql]) => [key.slice(key.lastIndexOf("/") + 1), sql]),
);

const r = () => {
  if (!rules) throw new Error("scripts/_migration-contract-rules.mjs did not resolve");
  return rules;
};

/** The findings for one SQL text, as `rule:action` strings. */
const classify = (sql: string, defs?: Defs) =>
  r()
    .classifyMigration(sql, defs)
    .findings.map((f) => `${f.rule}: ${f.action}`);

/** The first finding of `sql`, for the evaluation pairs. */
const only = (sql: string, defs?: Defs): Finding => {
  const [finding] = r().classifyMigration(sql, defs).findings;
  if (!finding) throw new Error(`no finding in: ${sql}`);
  return finding;
};

const corpusOf = (files: Record<string, string>) =>
  Object.entries(files).map(([path, source]) => r().prepareSource(path, source));

describe("the gate is wired where it is enforced", () => {
  test("both runner files name it", () => {
    for (const [path, text] of Object.entries(GATE_WIRING)) {
      expect.soft(text, `${path} not found`).toBeTypeOf("string");
      expect
        .soft(text, `${path} no longer references check:migration-contract`)
        .toContain("check:migration-contract");
    }
  });

  test("it is FATAL in the check table", () => {
    // A contraction that lands breaks production at release time, after the
    // npm publish; it is not technical debt to be reported at the end.
    expect(GATE_WIRING["scripts/check.mjs"]).toMatch(
      /script:\s*"check:migration-contract",\s*phase:\s*"ratchets",\s*fatal:\s*true/,
    );
  });

  test("it fails the process, and never exits 0 over a base it could not resolve", () => {
    const source = script ?? "";
    expect(source).toContain("process.exit(1)");
    const release = source.slice(source.indexOf("function findRelease"));
    const body = release.slice(0, release.indexOf("\n}\n"));
    expect(body, "findRelease no longer slices out").toContain("cannot resolve");
    expect(body).toContain("fail(");
    expect(body).not.toContain("process.exit(0)");
  });

  test("it declares floors under both corpora", () => {
    const source = script ?? "";
    const migrationFloor = numericConstant(
      source,
      "MIN_RELEASED_MIGRATIONS",
      "check-migration-contract.mjs",
    );
    expect(migrationFloor).toBeGreaterThan(0);
    expect(migrationFloor).toBeLessThan(Object.keys(migrations).length);
    expect(
      numericConstant(source, "MIN_REFERENCE_FILES", "check-migration-contract.mjs"),
    ).toBeGreaterThan(0);
  });
});

describe("what counts as a contraction", () => {
  test("removing a column, but not adding one", () => {
    expect(classify("alter table aai_platform.agents drop column if exists config;")).toEqual([
      "readers: drops column aai_platform.agents.config",
    ]);
    expect(
      classify("alter table aai_platform.agents add column if not exists config jsonb;"),
    ).toEqual([]);
  });

  test("dropping a table, view, function, type or schema — but not creating one", () => {
    expect(
      classify(
        'DROP TABLE IF EXISTS "aai_platform"."slug_locks", aai_platform.slug_epochs CASCADE;',
      ),
    ).toEqual([
      "readers: drops table aai_platform.slug_locks",
      "readers: drops table aai_platform.slug_epochs",
    ]);
    expect(classify("drop function if exists aai_platform.sweep(bigint, integer);")).toEqual([
      "readers: drops function aai_platform.sweep",
    ]);
    expect(classify("drop schema if exists aai_admin restrict;")).toEqual([
      "readers: drops schema aai_admin",
    ]);
    expect(classify("create table if not exists aai_platform.t (id int primary key);")).toEqual([]);
    expect(
      classify(
        "create or replace function aai_platform.f() returns int language sql as $$ select 1 $$;",
      ),
    ).toEqual([]);
  });

  test("renames, including the ones inside a do $$ block", () => {
    expect(classify("alter table aai_platform.a rename column x to y;")).toEqual([
      "readers: renames column aai_platform.a.x to y",
    ]);
    expect(classify("alter table aai_platform.a rename to b;")).toEqual([
      "readers: renames aai_platform.a to b",
    ]);
    expect(
      classify(
        "do $$ begin\n  if exists (select 1 from pg_namespace where nspname = 'workflow') then\n" +
          "    alter schema workflow rename to workflow_retired;\n  end if;\nend $$;",
      ),
    ).toEqual(["readers: renames schema workflow to workflow_retired"]);
    expect(classify("alter table aai_platform.a enable row level security;")).toEqual([]);
  });

  test("a retype, but not a new default", () => {
    expect(classify("alter table t alter column c type bigint using c::bigint;")).toEqual([
      "readers: changes the type of t.c",
    ]);
    expect(classify("alter table t alter column c set default 0;")).toEqual([]);
  });

  test("tightening for WRITERS — set not null, drop default — but not relaxing", () => {
    expect(
      classify("alter table t alter column c set not null, alter column d drop default;"),
    ).toEqual(["writers-column: makes t.c NOT NULL", "writers-column: drops the default of t.d"]);
    // DROP NOT NULL is how an expand is written (`agents.config` was one).
    expect(classify("alter table t alter column c drop not null;")).toEqual([]);
  });

  test("a NOT NULL column with no default, but not one with a default", () => {
    expect(classify("alter table t add column c int not null;")).toEqual([
      "writers-table: adds t.c NOT NULL with no default",
    ]);
    expect(
      classify("alter table t add column if not exists c integer not null default 0;"),
    ).toEqual([]);
  });

  test("a new constraint or unique index on an existing table", () => {
    expect(classify("alter table t add constraint t_ok check (n > 0);")).toEqual([
      "writers-table: adds a CHECK constraint t_ok to t",
    ]);
    expect(classify("create unique index if not exists t_k on aai_platform.t (slug, k);")).toEqual([
      "writers-table: adds a unique index on aai_platform.t",
    ]);
    expect(classify("create index if not exists t_k on aai_platform.t (slug, k);")).toEqual([]);
  });

  test("dropping a UNIQUE index is an upsert hazard; dropping a plain one is not a contraction of anything named", () => {
    const defs = r().uniqueDefinitions([
      "create unique index if not exists q_idem on aai_platform.q (slug, k);",
      "create table if not exists aai_platform.h (token text, constraint h_token unique (token));",
    ]);
    expect(classify("drop index if exists aai_platform.q_idem;", defs)).toEqual([
      "conflict: drops unique index q_idem",
    ]);
    expect(classify("alter table aai_platform.h drop constraint h_token;", defs)).toEqual([
      "conflict: drops unique constraint h_token on aai_platform.h",
    ]);
    expect(classify("drop index if exists aai_platform.q_run_idx;", defs)).toEqual([
      "readers: drops index aai_platform.q_run_idx",
    ]);
  });

  test("a revoke counts only when it reaches a role the server connects as", () => {
    expect(
      classify("revoke all on all tables in schema aai_platform from anon, authenticated;"),
    ).toEqual([]);
    expect(classify("revoke select on aai_platform.agents from service_role;")).toEqual([
      "readers: revokes privileges on aai_platform.agents",
    ]);
  });

  test("prose and string literals are not statements", () => {
    expect(
      classify("-- drop table aai_platform.agents;\n/* alter table x drop column y; */"),
    ).toEqual([]);
    expect(
      classify(
        "select cron.schedule('j', '* * * * *', 'select 1');\ninsert into t values ('drop table x');",
      ),
    ).toEqual([]);
  });

  test("the reported line is the DDL keyword's, not the do block's", () => {
    const sql = "do $$\nbegin\n  if true then\n    drop table if exists t;\n  end if;\nend $$;";
    expect(only(sql).line).toBe(4);
  });
});

describe("the escape hatch is a comment with a reason", () => {
  const marker = (sql: string) =>
    r()
      .classifyMigration(sql)
      .findings.map((f) => f.markers.map((m) => m.reason));

  test("above, trailing, or inside the statement", () => {
    expect(marker("-- aai:contract-ok unread since 0.40.0, see #1\ndrop table t;")).toEqual([
      ["unread since 0.40.0, see #1"],
    ]);
    expect(marker("drop table t; -- aai:contract-ok unread since 0.40.0\ndrop table u;")).toEqual([
      ["unread since 0.40.0"],
      [],
    ]);
    expect(
      marker(
        "alter table t\n  -- aai:contract-ok: widening int to bigint\n  alter column c type bigint;",
      ),
    ).toEqual([["widening int to bigint"]]);
  });

  test("a marker belongs to ONE statement, not to every one after it", () => {
    expect(marker("-- aai:contract-ok unread since 0.40.0\ndrop table t;\ndrop table u;")).toEqual([
      ["unread since 0.40.0"],
      [],
    ]);
  });

  test("a bare marker is recorded with an empty reason, which the gate refuses", () => {
    const { markers } = r().classifyMigration("-- aai:contract-ok\ndrop table t;");
    expect(markers).toEqual([{ line: 1, reason: "" }]);
    expect(r().MIN_REASON_CHARS).toBeGreaterThan(0);
    expect(script).toContain("marker.reason.length < MIN_REASON_CHARS");
  });
});

describe("what counts as the released code naming it", () => {
  const store = [
    "// The retired `config` column is gone; see the drop migration.",
    "const GET = `select slug, worker_hash from aai_platform.agents where slug = $1`;",
    "const PUT = `insert into aai_platform.agents (slug, worker_hash) values ($1, $2)",
    "  on conflict (slug) do update set worker_hash = excluded.worker_hash`;",
  ].join("\n");
  const corpus = corpusOf({ "packages/aai-server/src/agent-store.ts": store });

  test("a dropped column the code selects breaks; one it only mentions in a comment does not", () => {
    const used = r().evaluateFinding(
      only("alter table aai_platform.agents drop column worker_hash;"),
      corpus,
    );
    expect(used.breaks).toBe(true);
    expect(used.hits.map((hit) => `${hit.path}:${hit.line}`)).toEqual([
      "packages/aai-server/src/agent-store.ts:2",
      "packages/aai-server/src/agent-store.ts:3",
      "packages/aai-server/src/agent-store.ts:4",
    ]);
    expect(
      r().evaluateFinding(only("alter table aai_platform.agents drop column config;"), corpus)
        .breaks,
    ).toBe(false);
  });

  test("a bare table name counts only beside its schema", () => {
    const routeOnly = corpusOf({ "packages/aai-cli/src/list.ts": 'const URL = "/agents";' });
    const split = corpusOf({
      "packages/aai-server/src/x.ts": `const T = "agents";\nconst Q = \`select 1 from aai_platform.\${T}\`;`,
    });
    const drop = only("drop table aai_platform.agents;");
    expect(r().evaluateFinding(drop, routeOnly).breaks).toBe(false);
    expect(r().evaluateFinding(drop, split).breaks).toBe(true);
  });

  test("set not null breaks the writers that omit the column, not the ones that write it", () => {
    expect(
      r().evaluateFinding(
        only("alter table aai_platform.agents alter column worker_hash set not null;"),
        corpus,
      ).breaks,
    ).toBe(false);
    const omits = r().evaluateFinding(
      only("alter table aai_platform.agents alter column version set not null;"),
      corpus,
    );
    expect(omits.breaks).toBe(true);
    expect(omits.why).toContain("never names version");
  });

  test("a unique index over brand-new columns spares old writers; one over existing columns does not", () => {
    const batch = "alter table aai_platform.agents add column tag text;";
    const index = only("create unique index a_tag on aai_platform.agents (tag);");
    expect(r().evaluateFinding(index, corpus, r().addedColumns([batch])).breaks).toBe(false);
    expect(
      r().evaluateFinding(only("create unique index a_s on aai_platform.agents (slug);"), corpus)
        .breaks,
    ).toBe(true);
  });

  test("dropping a unique index breaks an ON CONFLICT upsert into its table", () => {
    const defs = r().uniqueDefinitions([
      "create unique index agents_slug on aai_platform.agents (slug);",
    ]);
    const drop = only("drop index aai_platform.agents_slug;", defs);
    expect(r().evaluateFinding(drop, corpus).breaks).toBe(true);
    const noUpsert = corpusOf({
      "packages/aai-server/src/r.ts": "const Q = `select slug from aai_platform.agents`;",
    });
    expect(r().evaluateFinding(drop, noUpsert).breaks).toBe(false);
  });

  test("an unqualified type is matched as a cast, not as a common word", () => {
    const drop = only("drop type status;");
    expect(
      r().evaluateFinding(drop, corpusOf({ "packages/a/src/a.ts": 'log("status ok");' })).breaks,
    ).toBe(false);
    expect(
      r().evaluateFinding(drop, corpusOf({ "packages/a/src/a.ts": "q(`select $1::status`);" }))
        .breaks,
    ).toBe(true);
  });

  test("only string and template literals are read: comments, code and regexes are not", () => {
    const texts = r()
      .jsLiterals(
        `// 'no'\nconst a = 'one' / 2; /* \`no\` */ const b = \`two \${f(\`three\`)} four\`; const re = /'no'/;`,
      )
      .map((l) => l.text);
    expect(texts).toEqual(["one", "two ", "three", " four"]);
  });

  test("the reference corpus is shipped source under src, never tests or harnesses", () => {
    const keep = r().isReferenceSource;
    expect(keep("packages/aai-server/src/agent-store.ts")).toBe(true);
    expect(keep("packages/aai-server/src/agent-store.test.ts")).toBe(false);
    expect(keep("packages/aai-server/src/_tenancy-platform-harness.ts")).toBe(false);
    expect(keep("packages/aai-server/src/_request-test-utils.ts")).toBe(false);
    expect(keep("packages/aai-guest/src/harness/agent-mode.ts")).toBe(true);
    expect(keep("packages/aai-server/SCHEMA-CLAUDE.md")).toBe(false);
    expect(keep("packages/aai-server/modal_deploy.py")).toBe(false);
  });
});

describe("the release is ship.yml's release", () => {
  const diff = (pkg: string, line: string) =>
    `diff --git a/packages/${pkg}/package.json b/packages/${pkg}/package.json\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n${line}\n`;

  test("a moved version line is a release; a dependency bump is not", () => {
    expect([...r().bumpedPackages(diff("aai", '+  "version": "0.14.0",'))]).toEqual(["aai"]);
    expect([...r().bumpedPackages(diff("aai", '+    "zod": "^4.0.0",'))]).toEqual([]);
    expect([...r().bumpedPackages(diff("aai", '-  "version": "0.13.0",'))]).toEqual([]);
  });

  test("one level deep, as ship.yml's shell glob is", () => {
    const nested =
      'diff --git a/packages/aai-templates/scaffold/package.json b/packages/aai-templates/scaffold/package.json\n+  "version": "1.0.0",\n';
    expect([...r().bumpedPackages(nested)]).toEqual([]);
  });

  test("only a carrier bump arms the deploy that decides what is SERVING", () => {
    expect(r().armsDeploy(new Set(["aai", "aai-ui"]))).toBe(false);
    expect(r().armsDeploy(new Set(["aai", "aai-studio-server"]))).toBe(true);
  });
});

describe("the classifier sees the contractions this tree really made", () => {
  // Non-vacuity against the real corpus: if the lexer stopped splitting a
  // `do $$` body or a QNAME stopped matching a quoted identifier, these are
  // the statements that would silently fall out.
  const real = (name: string) => {
    const sql = migrations[name];
    if (sql === undefined) throw new Error(`${name} is gone — pick another real contraction`);
    return classify(sql);
  };

  test("the workflow journal contract", () => {
    expect(real("20261001010000_workflow_journal_contract.sql")).toEqual([
      "writers-column: makes aai_platform.workflow_steps.started_at NOT NULL",
      "readers: drops table aai_platform.workflow_attempts",
    ]);
  });

  test("the agents.config drop and the devkit schema retirement", () => {
    expect(real("20260810030000_drop_agents_config.sql")).toEqual([
      "readers: drops column aai_platform.agents.config",
    ]);
    expect(real("20260901010000_drop_workflow_devkit_schema.sql")).toContain(
      "readers: renames schema workflow to workflow_retired",
    );
  });

  test("expansions classify as nothing", () => {
    expect(real("20260929010000_workflow_run_label.sql")).toEqual([]);
    expect(real("20260902130000_workflow_step_started_at.sql")).toEqual([]);
  });
});
