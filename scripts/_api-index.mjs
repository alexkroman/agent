// Copyright 2026 the AAI authors. MIT license.
/**
 * `API-INDEX.md`: every published name, what it IS, where to import it, which
 * capability owns it, and the first sentence of what it is for.
 *
 * The reverse index over the published surface. A report and `API-EXPORTS.json`
 * are both indexed BY subpath, which is the wrong direction for the question a
 * reader actually arrives with — "which import gives me `WorkflowInputOf`?" —
 * and a flat list of a thousand names against their subpaths answered that
 * question and no other. A reader scanning for the right name also needs to
 * know whether a row is a function or a type, whether it is the agent API or
 * the host's, and what it does, and the old file made each of those a second
 * lookup. So each row now carries:
 *
 * | Column | From |
 * | --- | --- |
 * | Name | the export lists, with `FooProps`/`FooOptions` folded under `Foo` |
 * | Kind | API Extractor's doc model (`ApiItemKind`), plus the `use*` / PascalCase-component convention on `aai-ui` |
 * | Import from | the PREFERRED subpath first, then every other that publishes it |
 * | Capability | the `<pkg>:<capability>` contract whose entry point re-exports it |
 * | Summary | the first sentence of the doc comment, from the doc model |
 *
 * **Sections are AUDIENCES, cut by rule rather than list** — {@link audienceOf}
 * — so a new subpath lands in one by construction, the way every deny-list in
 * this repo works.
 *
 * **The capability column names the contract, never its epoch.** An epoch
 * number here would make every `--bump` a stale index, and `check:api-report`
 * runs BEFORE `check:api-contracts`, so the failure would name the wrong gate.
 * Which capability owns a name changes only when its entry point file does.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { compareNames, readManifest } from "./_fs.mjs";

/** The reverse index: every name, against the subpath that publishes it. */
export const INDEX_FILE = "API-INDEX.md";

/** Subpaths whose reader is the FRAMEWORK. Both say so in their own module docs. */
const INTERNAL_SUBPATH = /\/(?:internal|host-internal)$/;

/** Subpaths an agent's SPECS import — the harnesses, stubs and eval runners. */
const TESTING_SUBPATH = /\/(?:testing|eval)(?:\/|$)/;

/**
 * `@alexkroman1/aai` subpaths whose reader is a HOST or a tool rather than an
 * agent: the config schema the CLI parses, the wire a custom client or server
 * speaks, and the file rules a project copier applies. Short, and argued per
 * entry, because everything else on the SDK defaults to the authoring section.
 */
const SDK_HOST_SUBPATHS = new Set([
  "@alexkroman1/aai/manifest",
  "@alexkroman1/aai/protocol",
  "@alexkroman1/aai/workspace-files",
]);

/** The sections, in reading order. The key is what {@link audienceOf} returns. */
const AUDIENCES = [
  {
    key: "authoring",
    heading: "Agent authoring",
    blurb: "What an `agent.ts`, its tools, its steps and its workflows import.",
  },
  {
    key: "client",
    heading: "Browser client",
    blurb: "The React client an agent's page is built from (`@alexkroman1/aai-ui`).",
  },
  {
    key: "testing",
    heading: "Testing and evals",
    blurb: "What an agent's specs and evals import: stubs, harnesses, the eval runner.",
  },
  {
    key: "hosting",
    heading: "Hosting and tooling",
    blurb:
      "What runs an agent rather than what one is written in: the host runtime, " +
      "the CLI's build hooks, the config schema and the wire protocol.",
  },
];

/** Which section a subpath belongs to. Order matters: internal and testing win. */
export function audienceOf(specifier) {
  if (INTERNAL_SUBPATH.test(specifier)) return "internal";
  if (TESTING_SUBPATH.test(specifier)) return "testing";
  if (specifier.startsWith("@alexkroman1/aai-ui")) return "client";
  if (specifier.startsWith("@alexkroman1/aai-runtime")) return "hosting";
  if (specifier.startsWith("@alexkroman1/aai-cli")) return "hosting";
  if (SDK_HOST_SUBPATHS.has(specifier)) return "hosting";
  return "authoring";
}

/**
 * The floor under the index's public half, set from the measured actual with
 * room to shrink.
 *
 * Every gate in this repo whose success output is a COUNT carries one, because
 * a scan that stopped matching prints the same checkmark as a healthy tree.
 * `--check` compares content, so a broken extraction fails there first — but it
 * fails as "out of date", which invites regenerating and committing the empty
 * file. The floor makes the writer refuse instead.
 */
const MIN_INDEXED_SYMBOLS = 500;

/**
 * `{ "src/…/barrel.ts" -> specifier }` from a manifest's `@dev/source` targets,
 * so an entry point's `from "../../barrel.ts"` names its subpath.
 */
function specifiersBySource(manifest) {
  const bySource = new Map();
  for (const [subpath, target] of Object.entries(manifest.exports ?? {})) {
    const source = typeof target === "object" ? target["@dev/source"] : undefined;
    if (typeof source !== "string") continue;
    const specifier = subpath === "." ? manifest.name : `${manifest.name}/${subpath.slice(2)}`;
    bySource.set(source.replace(/^\.\//, ""), specifier);
  }
  return bySource;
}

/** The exported names in one `export { a, type B, c as d }` clause. */
const clauseNames = (clause) =>
  clause
    .replace(/\/\/.*$/gm, "")
    .split(",")
    .map((raw) =>
      raw
        .replace(/^\s*type\s+/, "")
        .split(/\s+as\s+/)
        .pop()
        .trim(),
    )
    .filter((name) => name !== "");

/**
 * `{ specifier -> { name -> capability } }`, read from every package's
 * `src/contracts/entrypoints/*.ts`.
 *
 * Each entry point is one `export { … } from "<barrel>"`, and the barrel is
 * resolved to a subpath through the package's own `exports` map (its
 * `@dev/source` condition), so no subpath is named here.
 */
export function capabilityOwners(packageDirs) {
  const owners = new Map();
  for (const dir of packageDirs) {
    for (const [specifier, name, capability] of ownedNames(dir)) {
      if (!owners.has(specifier)) owners.set(specifier, new Map());
      owners.get(specifier).set(name, capability);
    }
  }
  return owners;
}

/** `[specifier, name, capability]` for every name one package's contracts select. */
function* ownedNames(dir) {
  const entryDir = join(dir, "src/contracts/entrypoints");
  if (!existsSync(entryDir)) return;
  const bySource = specifiersBySource(readManifest(join(dir, "package.json")));
  const key = dir.split("/").pop();
  for (const file of readdirSync(entryDir)
    .filter((f) => f.endsWith(".ts"))
    .sort()) {
    const capability = `${key}:${file.replace(/\.ts$/, "")}`;
    const text = readFileSync(join(entryDir, file), "utf8");
    for (const [, clause, from] of text.matchAll(/export\s*\{([^}]*)\}\s*from\s*"([^"]+)"/g)) {
      // Both groups are mandatory in the pattern, but `matchAll` types them
      // `string | undefined` under the scripts' strict checking.
      if (clause === undefined || from === undefined) continue;
      const specifier = bySource.get(relative(dir, join(entryDir, from)));
      if (specifier === undefined) continue;
      for (const name of clauseNames(clause)) yield [specifier, name, capability];
    }
  }
}

/**
 * A TSDoc comment's SUMMARY section: its lines up to the first blank line,
 * block tag, fence, table or heading.
 */
function summaryLines(docComment) {
  const lines = docComment
    .replace(/^\s*\/\*\*/, "")
    .replace(/\*\/\s*$/, "")
    .split("\n")
    .map((line) => line.replace(/^\s*\* ?/, "").trim());
  const start = lines.findIndex((line) => line !== "");
  if (start < 0) return [];
  const rest = lines.slice(start);
  const end = rest.findIndex((line) => line === "" || /^(@|```|\||#)/.test(line));
  return end < 0 ? rest : rest.slice(0, end);
}

/** The row's width budget for a summary: enough to recognise a name by. */
const SUMMARY_MAX = 160;

/**
 * The first sentence of a TSDoc comment, as one table-safe line.
 *
 * An inline `{@link X}` renders as `X` (or its label), and a `|` is escaped so
 * it cannot open a table column. Capped, because a row is for recognising a
 * name, and the reference page is one click away for reading it.
 */
export function summaryOf(docComment) {
  if (typeof docComment !== "string") return "";
  let text = summaryLines(docComment)
    .join(" ")
    .replace(/\{@link(?:code|plain)?\s+([^}|\s]+)\s*(?:\|\s*([^}]+))?\}/g, (_, target, label) =>
      label ? label.trim() : `\`${target}\``,
    )
    .replace(/\s+/g, " ")
    .trim();
  text = text.slice(0, sentenceEnd(text));
  if (text.length > SUMMARY_MAX) {
    let cut = text.slice(0, SUMMARY_MAX).replace(/\s+\S*$/, "");
    // Never end inside inline code: a dangling backtick swallows the rest of
    // the row when the table renders.
    if ((cut.match(/`/g) ?? []).length % 2 === 1) {
      cut = cut.slice(0, cut.lastIndexOf("`")).trimEnd();
    }
    text = `${cut} …`;
  }
  return text.replaceAll("|", "\\|");
}

/**
 * Where the first sentence ends: a `.`/`!`/`?` followed by whitespace, outside
 * inline code, and not the full stop of `e.g.` / `i.e.` / `vs.` / `etc.`.
 */
function sentenceEnd(text) {
  let inCode = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "`") inCode = !inCode;
    if (inCode || !".!?".includes(ch)) continue;
    if (i + 1 < text.length && !/\s/.test(text[i + 1])) continue;
    if (ch === "." && /(?:\be\.g|\bi\.e|\bvs|\betc)$/i.test(text.slice(0, i))) continue;
    return i + 1;
  }
  return text.length;
}

/**
 * `{ name -> doc comment }` for one entry point's doc model.
 *
 * The doc model trims `@internal` items, so the KIND comes from the report
 * instead (`collectExports`), which records every export and its release tag.
 */
function docComments(path) {
  const out = new Map();
  if (!existsSync(path)) return out;
  const model = JSON.parse(readFileSync(path, "utf8"));
  for (const entry of model.members ?? []) {
    for (const member of entry.members ?? []) {
      if (!out.get(member.name) && member.docComment) out.set(member.name, member.docComment);
    }
  }
  return out;
}

/**
 * The Kind cell: the declaration kind, `hook`/`component` by the browser
 * client's naming convention, and `@internal` when the report tags it so — an
 * internal name on a public subpath is worth seeing, not hiding.
 */
function kindOf(name, specifier, entry) {
  if (entry === undefined) return "";
  let kind = entry.kind ?? "";
  if (specifier.startsWith("@alexkroman1/aai-ui") && ["function", "const"].includes(kind)) {
    if (/^use[A-Z]/.test(name)) kind = "hook";
    else if (kind === "function" && /^[A-Z][a-z]/.test(name)) kind = "component";
  }
  return entry.tag === "internal" ? `${kind} · \`@internal\`` : kind;
}

/**
 * The import a reader should write when several subpaths publish one name.
 *
 * The capability owner's subpath when there is one — that is the page a change
 * to the name is recorded against. Otherwise the NARROWEST subpath, the rule the
 * contracts already apply ("a name published on both belongs to the narrower
 * one"), measured by how many names each publishes.
 */
function preferredOf(name, specifiers, owners, sizes) {
  const owned = specifiers.find((s) => owners.get(s)?.has(name));
  if (owned !== undefined) return owned;
  return [...specifiers].sort((a, b) => sizes.get(a) - sizes.get(b))[0];
}

/** `Foo` for `FooProps` / `FooOptions`, or `foo` when only the factory exists. */
function foldTarget(name, rows) {
  const match = /^(.+?)(Props|Options)$/.exec(name);
  if (match === null) return;
  const base = match[1];
  if (base === undefined) return;
  const lowered = `${base.charAt(0).toLowerCase()}${base.slice(1)}`;
  const target = [base, lowered].find((candidate) => rows.has(candidate));
  if (target === undefined) return;
  const same = (a, b) => a.length === b.length && a.every((s) => b.includes(s));
  return same(rows.get(target).specifiers, rows.get(name).specifiers) ? target : undefined;
}

const code = (s) => `\`${s}\``;

/** One section's table. */
function table(rows) {
  const folded = new Map();
  for (const name of rows.keys()) {
    const target = foldTarget(name, rows);
    if (target === undefined) continue;
    if (!folded.has(target)) folded.set(target, []);
    folded.get(target).push(name);
  }
  const hidden = new Set([...folded.values()].flat());
  const out = [
    "| Name | Kind | Import from | Capability | Summary |",
    "| --- | --- | --- | --- | --- |",
  ];
  for (const [name, row] of [...rows].sort(([a], [b]) => compareNames(a, b))) {
    if (hidden.has(name)) continue;
    const names = [name, ...(folded.get(name) ?? []).sort(compareNames)].map(code).join(", ");
    const [first, ...rest] = row.specifiers;
    const imports =
      rest.length === 0 ? code(first) : `${code(first)} (also ${rest.map(code).join(", ")})`;
    out.push(
      `| ${names} | ${row.kind} | ${imports} | ${row.capability ? code(row.capability) : ""} | ${row.summary} |`,
    );
  }
  return out;
}

/**
 * Build the file from the report sections (`specifier`, `names`,
 * `docModelPath`) and the capability owners.
 */
export function indexFile(sections, owners) {
  const sizes = new Map(sections.map((s) => [s.specifier, s.names.length]));
  const docs = new Map(sections.map((s) => [s.specifier, docComments(s.docModelPath)]));
  const declared = new Map(
    sections.map((s) => [s.specifier, new Map(s.entries.map((entry) => [entry.name, entry]))]),
  );

  const publics = new Map();
  const internals = new Map();
  for (const section of sections) {
    const target = INTERNAL_SUBPATH.test(section.specifier) ? internals : publics;
    for (const name of section.names) {
      if (!target.has(name)) target.set(name, []);
      target.get(name).push(section.specifier);
    }
  }
  // A name on both halves is a PUBLIC name: listing it twice would say the
  // reader has a choice of import where one of the two is not covered by semver.
  for (const name of publics.keys()) internals.delete(name);

  if (publics.size < MIN_INDEXED_SYMBOLS) {
    throw new Error(
      `api-report: ${INDEX_FILE} indexed ${publics.size} public symbol(s), under the ` +
        `floor of ${MIN_INDEXED_SYMBOLS}. Either the export scan stopped matching or ` +
        "the surface really shrank — check which before lowering it.",
    );
  }

  const describe = (name, specifiers) => {
    const preferred = preferredOf(name, specifiers, owners, sizes);
    const ordered = [preferred, ...specifiers.filter((s) => s !== preferred)];
    const capability = ordered.map((s) => owners.get(s)?.get(name)).find(Boolean);
    // A re-export from ANOTHER package (`export { AgentEnv }` of an import from
    // `@alexkroman1/aai/host-internal`) is declared in neither its own report
    // nor its own doc model, so both fall back to whichever entry point does.
    const everywhere = [...ordered, ...docs.keys()];
    const entry = everywhere.map((s) => declared.get(s)?.get(name)).find((e) => e?.kind);
    return {
      specifiers: ordered,
      kind: kindOf(name, preferred, entry),
      capability,
      summary: summaryOf(everywhere.map((s) => docs.get(s)?.get(name)).find(Boolean)),
    };
  };

  /** @type {Map<string, Map<string, ReturnType<typeof describe>>>} */
  const bySection = new Map(AUDIENCES.map(({ key }) => [key, new Map()]));
  const sectionOf = (key) => bySection.get(key) ?? new Map();
  for (const [name, specifiers] of publics) {
    const row = describe(name, specifiers);
    sectionOf(audienceOf(row.specifiers[0] ?? "")).set(name, row);
  }
  const internalRows = new Map(
    [...internals].map(([name, specs]) => [name, describe(name, specs)]),
  );

  const out = [
    "<!-- Generated by `pnpm api-report`. Do not edit — edit the source, then regenerate. -->",
    "",
    "# Where each published name comes from",
    "",
    "Every export of every publishable package: what it is, the subpath to import",
    "it from, the capability contract that versions it, and the first sentence of",
    "its doc comment. `API.md` is the same surface indexed by subpath, with",
    "signatures; this is the reverse index, for when you have the name — or half",
    "of it — and want the import.",
    "",
    "- **Import from** lists the subpath to write FIRST. Any listed after it",
    '  ("also") publish the same declaration, so they compile too.',
    "- **`FooProps` / `FooOptions`** share `Foo`'s row when both come from the",
    "  same subpaths.",
    "- **Capability** is the `<package>:<capability>` contract under",
    "  `packages/<package>/src/contracts/` that records breaking changes to the",
    "  name. Blank means no contract covers it.",
    "",
    "## Contents",
    "",
    ...AUDIENCES.map(
      ({ key, heading }) =>
        `- [${heading}](#${heading.toLowerCase().replaceAll(" ", "-")}) — ${sectionOf(key).size} names`,
    ),
    `- [Framework internals](#framework-internals) — ${internalRows.size} names`,
  ];
  for (const { key, heading, blurb } of AUDIENCES) {
    out.push("", `## ${heading}`, "", blurb, "", ...table(sectionOf(key)));
  }
  out.push(
    "",
    "## Framework internals",
    "",
    "Not public API and not covered by semver — listed so a name found in a stack",
    "trace or a type error can be traced back to something.",
    "",
    ...table(internalRows),
    "",
  );
  return out.join("\n");
}

/** Every package directory a section came from, for {@link capabilityOwners}. */
export const packageDirsOf = (sections) => [...new Set(sections.map((s) => s.packageDir))];
