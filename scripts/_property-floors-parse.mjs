// Copyright 2026 the AAI authors. MIT license.
/**
 * What a `fast-check` file DECLARES: does it run a property, does that property
 * drive a machine through a generated sequence, and what coverage floors does it
 * assert afterwards.
 *
 * Its own module for the reason `_test-assertions-parse.mjs` is: the gate that
 * uses it (`check-property-floors.mjs`) is a script with top-level effects, and
 * the thing that needs a spec is the PARSER. A gate whose whole success output
 * is a count prints the same checkmark over an empty scan as over a healthy
 * tree, so the matcher is the part that has to be pinned by a test.
 *
 * ## A real parse, for the same reasons and one more
 *
 * `fc` is a MEMBER expression (`fc.array`, `fc.assert`) and the floors are a
 * call chain (`expect(reached.x, "why").toBeGreaterThan(45)`), so a regex has to
 * mask comments and strings before it can tell a live `fc.assert(` from one
 * named in the paragraph above it — and four files here discuss `fast-check` in
 * prose only, which is exactly the mask bug `check-test-assertions` paid for
 * twice. `oxc-parser` is already a root devDependency for that gate.
 *
 * The extra reason is the COMMENT. This gate's second half asks whether a floor
 * records the actual it was measured against, and the answer lives in a comment
 * — the one thing a plain AST walk throws away. `parseSync` hands comments back
 * with spans beside the program, so the floor's numeric literal and the note
 * beside it are read from the same parse.
 *
 * ## The three questions, and why they are separate
 *
 * - `runsProperty` — a `fc.assert(…)` / `fc.check(…)` call. A module that only
 *   EXPORTS arbitraries (`_pipeline-fuzz-input.ts`, `_s2s-fuzz-plans.ts`) runs
 *   no property, so it cannot own a floor; the floor belongs to the file that
 *   runs it. Three of the corpus's twenty-two files are this.
 * - `statefulApis` and `countsStates` — the two independent signals that a
 *   property WALKS A MACHINE, which is where a state can go unreached across
 *   every run and so the whole vacuity risk lives. The first is the fast-check
 *   API (`commands`, `scheduler`, `asyncProperty`); the second is the file
 *   keeping a tally of states its generator reached. Either is enough, and four
 *   suites in the tree have only the second.
 * - `floors` — every numeric lower bound, in either of the two shapes the tree
 *   actually uses, each with the comment region it could record a measurement
 *   in.
 *
 * `siblingFcModules` exists because the two integration suites keep their
 * arbitraries next door: `s2s-fuzz.integration.test.ts` reaches `fc.commands`
 * only through `./_s2s-fuzz-plans.ts`. One hop is enough
 * for both and is where the resolution deliberately stops — a transitive walk
 * would make the obligation depend on a graph nobody reading the file can see.
 */

import { parseSync } from "oxc-parser";

/**
 * The fast-check APIs that mean "this property drives a MACHINE".
 *
 * `commands` / `modelRun` / `asyncModelRun` and `scheduler` / `schedulerFor` are
 * the explicit stateful APIs. `asyncProperty` is here because an async property
 * body awaits real machinery — a session, a server, a stream — and cannot be a
 * pure function of its input.
 *
 * `fc.array` is deliberately NOT here, and the calibration run is why. It looked
 * like the discriminator (thirteen of the fourteen floored suites use it) until
 * `_pcm.test.ts` landed mid-session: `fc.array(fc.integer({ min: 0, max: 255 }))`
 * there generates a byte BUFFER — one value, checked by a round-trip — and
 * obliging it would have produced exactly the compliance floor this gate must
 * not create ("did we draw a non-empty array", true by construction). A
 * sequence-shaped arbitrary says nothing about whether the sequence walks
 * anything.
 */
export const STATEFUL_APIS = new Set([
  "commands",
  "modelRun",
  "asyncModelRun",
  "scheduler",
  "schedulerFor",
  "asyncProperty",
]);

/**
 * The matchers that express a lower bound. `not.toBeLessThan` is nobody's idiom.
 *
 * Composed from the shorter name rather than spelled twice, because a vitest
 * matcher name is long enough and mixed-case enough to read as a high-entropy
 * string to Biome's `noSecrets`, which is ON for `scripts/`.
 */
const LOWER_BOUND = "toBeGreater";
/** The canonical matcher name, for a message that wants to show the shape. */
export const FLOOR_MATCHER = `${LOWER_BOUND}Than`;
export const FLOOR_MATCHERS = new Set([FLOOR_MATCHER, `${FLOOR_MATCHER}OrEqual`]);

/** Calls that actually RUN a property, as opposed to describing one. */
export const PROPERTY_RUNNERS = new Set(["assert", "check"]);

/**
 * What counts as a recorded measurement.
 *
 * A range (`158-203`), an approximate actual (`~350`), or the word `measured` /
 * `observed` near a number. Deliberately NOT "the comment contains a digit": a
 * floor's neighbouring JSDoc paragraph nearly always contains one, so that
 * reading would pass every floor in the tree and the gate's second half would
 * check nothing — the failure mode it exists to catch, arriving in the gate.
 */
export const MEASUREMENT_RE =
  /\d+\s*(?:[-–—]|to)\s*\d+|~\s*\d+|\b(?:measured|observed)\b[^.]{0,60}?\d/i;

/** Every `type`d node under `node`; a visitor returning `false` skips children. */
function walk(node, visit) {
  // Baselined against rule 17, for the two reasons `_test-assertions-parse.mjs`
  // records at its byte-identical guard: a `scripts/*.mjs` gate cannot import
  // the SDK's `isRecord`, and this guard must ADMIT arrays — an AST node's
  // children are arrays, so narrowing them away would stop the walk at the
  // first `body` or `arguments`.
  if (node === null || typeof node !== "object") return;
  if (Array.isArray(node)) {
    for (const child of node) walk(child, visit);
    return;
  }
  if (typeof node.type === "string" && visit(node) === false) return;
  for (const key of Object.keys(node)) {
    if (key === "type" || key === "start" || key === "end") continue;
    walk(node[key], visit);
  }
}

/** Byte offset of the start of each 1-based line. */
function lineStarts(source) {
  const starts = [0];
  for (let i = 0; i < source.length; i++) if (source[i] === "\n") starts.push(i + 1);
  return starts;
}

/** 1-based line holding `offset`. */
function lineAt(starts, offset) {
  let lo = 0;
  let hi = starts.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (starts[mid] <= offset) lo = mid;
    else hi = mid - 1;
  }
  return lo + 1;
}

/** The numeric value of a literal, including a negated one; `null` otherwise. */
function numericValue(node) {
  if (!node) return null;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-") {
    const inner = numericValue(node.argument);
    return inner === null ? null : -inner;
  }
  return null;
}

/**
 * Comments indexed by the line they start on, plus whether each one owns its
 * line (nothing but whitespace before it). Own-line-ness is what lets the
 * upward scan stop at the first line of code rather than walking through the
 * whole file on the strength of one trailing `// x`.
 */
function commentIndex(source, comments, starts) {
  const byLine = new Map();
  for (const comment of comments) {
    const line = lineAt(starts, comment.start);
    const before = source.slice(starts[line - 1], comment.start);
    const entry = { value: comment.value, ownLine: before.trim() === "" };
    const list = byLine.get(line);
    if (list) list.push(entry);
    else byLine.set(line, [entry]);
    // A block comment can span lines; mark the rest so the upward scan does not
    // mistake the middle of a JSDoc for a line of code.
    const endLine = lineAt(starts, comment.end);
    for (let l = line + 1; l <= endLine; l++) {
      if (!byLine.has(l)) byLine.set(l, [{ value: "", ownLine: true }]);
    }
  }
  return byLine;
}

/**
 * The comments a floor at [startLine, endLine] may record its measurement in:
 * anything inside the floor's own span (the trailing `); // 158-203` lands
 * here, the closing paren and the note sharing a line), plus the contiguous
 * comment block above it — where a floor whose justification needs a paragraph
 * puts its numbers.
 *
 * **The upward scan walks THROUGH sibling floors**, which the calibration run is
 * the argument for. Floors come in GROUPS under one comment, and a group's
 * measurement is written once for the group:
 *
 *     // Measured over five runs: started 41-68, discarded 38-65.
 *     expect(count("speculationStarted"), "…").toBeGreaterThan(13);
 *     expect(count("speculationDiscarded"), "…").toBeGreaterThan(12);
 *
 * A scan that stopped at the first line of code reported the second of those as
 * unmeasured — two of the first draft's three findings in
 * `pipeline-fuzz.integration.test.ts` were this, and both were the gate being
 * wrong rather than the file. The third survived the fix and is a real one.
 *
 * `floorLines` is the set of lines any floor in the file occupies, so the walk
 * still stops at ordinary code and cannot wander up the file.
 *
 * @param {Map<number, {value: string, ownLine: boolean}[]>} byLine
 * @param {number} startLine
 * @param {number} endLine
 * @param {Set<number>} floorLines
 */
export function measurementScope(byLine, startLine, endLine, floorLines = new Set()) {
  const values = [];
  for (let line = startLine; line <= endLine; line++) {
    for (const comment of byLine.get(line) ?? []) values.push(comment.value);
  }
  for (let line = startLine - 1; line >= 1; line--) {
    const list = byLine.get(line);
    const isComment = list?.some((comment) => comment.ownLine) === true;
    if (!(isComment || floorLines.has(line))) break;
    for (const comment of list ?? []) values.push(comment.value);
  }
  return values;
}

/**
 * Does this node COUNT something — `reached.x++`, `cov[k] += 1`,
 * `cov[k] = (cov[k] ?? 0) + 1`?
 *
 * The second half of the obligation trigger, and the half the calibration run
 * forced. Four suites here walk a machine through a SYNC `fc.property` —
 * `pipeline-history`, `fuzz-hooks`, `audio-stress`,
 * `workflow-typed-json-property` — so no fast-check API marks them as stateful,
 * and all four already declare floors (nineteen between them) that a
 * stateful-API-only trigger would stop requiring. What they have and the
 * value-level suites do not is a COUNTER: the file already tallies states its
 * generator reaches.
 *
 * That is evidence of a machine walk rather than a restatement of the rule. The
 * question the trigger asks is "must this file declare a floor?", and a file
 * that counts states but floors none is precisely the rot this gate exists to
 * catch — counters printed under an env var, believed by nobody, asserted
 * nowhere.
 */
function isCounterBump(node) {
  if (node.type === "UpdateExpression") return node.argument?.type === "MemberExpression";
  // `seen.set(what, (seen.get(what) ?? 0) + 1)` — the Map spelling of the same
  // tally, and the third of the three in this tree.
  // `workflow-typed-json-property.test.ts` is the one that uses it, and it was
  // classified value-level until this arm existed.
  if (node.type === "CallExpression") {
    return (
      node.callee?.type === "MemberExpression" &&
      node.callee.property?.type === "Identifier" &&
      node.callee.property.name === "set" &&
      node.arguments?.length === 2 &&
      isPlusOne(node.arguments[1])
    );
  }
  if (node.type !== "AssignmentExpression") return false;
  if (node.left?.type !== "MemberExpression") return false;
  if (node.operator === "+=") return true;
  // `cov[k] = (cov[k] ?? 0) + 1` — the spelling a Record<string, number> needs.
  return node.operator === "=" && isPlusOne(node.right);
}

/** An addition, however parenthesised — what every tally's right-hand side is. */
function isPlusOne(node) {
  return node?.type === "BinaryExpression" && node.operator === "+";
}

/** The local names bound to the fast-check module object, and to its members. */
function fastCheckBindings(program) {
  const moduleNames = new Set();
  const memberNames = new Map();
  for (const node of program.body) {
    if (node.type !== "ImportDeclaration" || node.source.value !== "fast-check") continue;
    for (const spec of node.specifiers ?? []) {
      if (spec.type === "ImportSpecifier") memberNames.set(spec.local.name, spec.imported.name);
      else moduleNames.add(spec.local.name);
    }
  }
  return { moduleNames, memberNames };
}

/** The fast-check API a call expression invokes, or `null`. */
function fcApiOf(node, { moduleNames, memberNames }) {
  const callee = node.callee;
  if (!callee) return null;
  if (
    callee.type === "MemberExpression" &&
    callee.object?.type === "Identifier" &&
    moduleNames.has(callee.object.name) &&
    callee.property?.type === "Identifier"
  ) {
    return callee.property.name;
  }
  if (callee.type === "Identifier" && memberNames.has(callee.name)) {
    return memberNames.get(callee.name);
  }
  return null;
}

/**
 * Analyse one source file.
 *
 * Returns `errors` rather than throwing, so the caller decides: a file that will
 * not parse must be LOUD, since skipping it silently is the same shape as the
 * bug this gate exists to catch.
 *
 * @param {string} filename Used only to pick the dialect (`.ts` vs `.tsx`).
 * @param {string} source
 */
export function analyzeSource(filename, source) {
  const parsed = parseSync(filename, source);
  if (parsed.errors.length > 0) {
    return { errors: parsed.errors.map((e) => e.message) };
  }
  const program = parsed.program;
  const bindings = fastCheckBindings(program);
  const importsFastCheck =
    bindings.moduleNames.size > 0 ||
    bindings.memberNames.size > 0 ||
    program.body.some(
      (node) =>
        (node.type === "ImportDeclaration" || node.type === "ExportNamedDeclaration") &&
        node.source?.value === "fast-check",
    );

  const starts = lineStarts(source);
  const byLine = commentIndex(source, parsed.comments, starts);
  // `flatMap` rather than `filter().map()`: a `filter` predicate does not narrow
  // what the following `map` receives, so `node.source` was being read off the
  // whole `Statement` union.
  const siblingFcModules = program.body.flatMap((node) =>
    node.type === "ImportDeclaration" && node.source.value.startsWith(".")
      ? [node.source.value]
      : [],
  );

  const found = collect(program, bindings, starts);
  found.spans.push(...tableSpans(found.tables, found.referenced, starts));

  return {
    importsFastCheck,
    runsProperty: found.runsProperty,
    countsStates: found.countsStates,
    floors: resolveFloors(found.spans, byLine),
    statefulApis: [...found.statefulApis].sort(),
    siblingFcModules,
    errors: [],
  };
}

/**
 * One walk of the program, gathering everything the three questions need.
 *
 * Split out of {@link analyzeSource} to keep each piece under Biome's cognitive
 * complexity ceiling, and because the ORDER matters: floor spans have to be
 * complete before any measurement is resolved, since a group's comment sits
 * above its siblings and the upward scan walks through them.
 */
function collect(program, bindings, starts) {
  const statefulApis = new Set();
  /** Floor spans, measurements deliberately deferred. */
  const spans = [];
  /** Identifiers referenced anywhere, so a floors table nothing reads is not a floor. */
  const referenced = new Map();
  /** `const X_FLOORS = { … }` tables, kept aside until their reference count is known. */
  const tables = [];
  let runsProperty = false;
  let countsStates = false;

  const onCall = (node) => {
    const api = fcApiOf(node, bindings);
    if (api !== null) {
      if (PROPERTY_RUNNERS.has(api)) runsProperty = true;
      if (STATEFUL_APIS.has(api)) statefulApis.add(api);
    }
    const span = floorSpanOf(node, starts);
    if (span !== null) spans.push(span);
  };

  walk(program, (node) => {
    if (node.type === "Identifier") {
      referenced.set(node.name, (referenced.get(node.name) ?? 0) + 1);
      return;
    }
    if (isCounterBump(node)) countsStates = true;
    // A member access rather than a call: `fc.scheduler` handed straight to a
    // combinator still names the API, and the property is stateful either way.
    const member = statefulMemberOf(node, bindings);
    if (member !== null) statefulApis.add(member);
    if (node.type === "CallExpression") {
      onCall(node);
      return;
    }
    const table = floorsTableOf(node);
    if (table !== null) tables.push(table);
  });

  return { statefulApis, spans, referenced, tables, runsProperty, countsStates };
}

/** `fc.<statefulApi>` read as a value, or `null`. */
function statefulMemberOf(node, { moduleNames }) {
  if (node.type !== "MemberExpression") return null;
  if (node.object?.type !== "Identifier" || !moduleNames.has(node.object.name)) return null;
  if (node.property?.type !== "Identifier") return null;
  return STATEFUL_APIS.has(node.property.name) ? node.property.name : null;
}

/** A `…toBeGreaterThan(<number>)` call's span, or `null`. */
function floorSpanOf(node, starts) {
  if (node.callee?.type !== "MemberExpression") return null;
  if (node.callee.property?.type !== "Identifier") return null;
  if (!FLOOR_MATCHERS.has(node.callee.property.name)) return null;
  const value = numericValue(node.arguments?.[0]);
  if (value === null) return null;
  return {
    kind: "assertion",
    value,
    startLine: lineAt(starts, node.start),
    endLine: lineAt(starts, node.end),
  };
}

/** A `const …FLOORS = { … }` declarator, or `null`. */
function floorsTableOf(node) {
  if (node.type !== "VariableDeclarator" || node.id?.type !== "Identifier") return null;
  if (!/floors?$/i.test(node.id.name)) return null;
  const object = node.init?.type === "TSAsExpression" ? node.init.expression : node.init;
  if (object?.type !== "ObjectExpression") return null;
  return { name: node.id.name, object };
}

/**
 * Floor spans from every floors TABLE the file both declares and READS.
 *
 * `s2s-fuzz.integration.test.ts` declares thirteen floors this way and asserts
 * them in one go (`expect(floorsMissed(cov)).toEqual([])`), so a matcher that
 * only knew the `expect(...).toBeGreaterThan(...)` shape read the repo's most
 * heavily floored suite as having none at all.
 */
function tableSpans(tables, referenced, starts) {
  const spans = [];
  for (const { name, object } of tables) {
    // The declaration itself counts as one reference; a table nothing READS is
    // decoration, and counting it would let a file satisfy the gate with an
    // object literal no assertion ever consults.
    if ((referenced.get(name) ?? 0) < 2) continue;
    for (const prop of object.properties) {
      if (prop.type !== "Property") continue;
      const value = numericValue(prop.value);
      if (value === null) continue;
      spans.push({
        kind: "table",
        table: name,
        value,
        startLine: lineAt(starts, prop.start),
        endLine: lineAt(starts, prop.end),
      });
    }
  }
  return spans;
}

/** Resolve each span's measurement, with every floor's lines already known. */
function resolveFloors(spans, byLine) {
  const floorLines = new Set();
  for (const span of spans) {
    for (let line = span.startLine; line <= span.endLine; line++) floorLines.add(line);
  }
  return spans
    .map((span) => {
      const floor = {
        kind: span.kind,
        value: span.value,
        line: span.startLine,
        measured: measurementScope(byLine, span.startLine, span.endLine, floorLines).some((text) =>
          MEASUREMENT_RE.test(text),
        ),
      };
      if (span.table !== undefined) floor.table = span.table;
      return floor;
    })
    .sort((a, b) => a.line - b.line);
}
