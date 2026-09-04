// Copyright 2026 the AAI authors. MIT license.
/**
 * The NODE vocabulary every `guard-invariants` node rule is composed from —
 * the AST counterpart of `guard-invariants-ere.mjs`.
 *
 * The two modules answer the same question ("can this pattern see that shape")
 * and that is why they are shaped alike: small named predicates, each doing one
 * thing, so a rule reads as a sentence at its own definition. What they do NOT
 * share is the failure mode. An ERE fragment is a claim about CHARACTERS, so
 * every one here carries a comment about a shape it cannot cross — a type
 * argument, an arrow's parameter list, a line break Biome chose. A predicate
 * over a parsed node has no such edges: `setTimeout(resolve, 0)` is one
 * `CallExpression` whether it is written on one line or five.
 *
 * Two consequences worth stating, because they are what the migration bought:
 *
 *   - **`skipComments` is gone from every rule here.** A comment is not a node,
 *     so a rule's own remedy text quoting the anti-pattern cannot match it —
 *     which also means this module needs no `SELF_REFERENTIAL` entry, unlike
 *     all four ERE rule modules and the ERE vocabulary itself.
 *   - **The samples are SOURCE.** A line rule's positive sample is a line, so
 *     the sample proving a rule sees a multi-line shape could not be written in
 *     it — rule 3 shipped for months with a single-line sample while the rule
 *     was blind to the wrapped form. A node rule's sample is a snippet the spec
 *     parses, so it is written the way the code is written.
 */

/**
 * The expression a wrapper wraps — parentheses, and the TypeScript casts that
 * are erased at runtime.
 *
 * **This is the parse's own version of "a shape the pattern cannot cross", and
 * it is the one trap the migration to an AST does not remove by itself.** oxc
 * PRESERVES `ParenthesizedExpression`, so `Math.random() * (w / 2)` is a
 * multiplication whose right operand is a wrapper rather than the division a
 * predicate is looking for — rule 31 matched nothing at all until this existed,
 * caught by its own positive sample in `guard-invariants-gate.test.ts`. Which
 * is the argument for that suite twice over: a node rule can be as silently
 * dead as a regex, and the sample is what says so.
 *
 * `as`, `satisfies` and `!` are here for the same reason and by anticipation
 * rather than by injury: `(ms as number) / 2` is the same arithmetic, and a
 * rule that could not see through one would report a checkmark.
 */
export function unwrap(node) {
  let current = node;
  while (
    current?.type === "ParenthesizedExpression" ||
    current?.type === "TSAsExpression" ||
    current?.type === "TSSatisfiesExpression" ||
    current?.type === "TSNonNullExpression"
  ) {
    current = current.expression;
  }
  return current;
}

/** Is `node` the identifier `name`? */
export const isIdent = (node, name) => {
  const inner = unwrap(node);
  return inner?.type === "Identifier" && (name === undefined || inner.name === name);
};

/**
 * The property name of a member expression, computed or not.
 *
 * `a.b` and `a["b"]` are the same access and a rule should not have to know
 * which one an author wrote. The ERE side could only ever see the first.
 */
export function propertyName(node) {
  const member = unwrap(node);
  if (member?.type !== "MemberExpression") return;
  const { property, computed } = member;
  if (computed !== true) return property?.type === "Identifier" ? property.name : undefined;
  return property?.type === "Literal" && typeof property.value === "string"
    ? property.value
    : undefined;
}

/** Is `node` a member access `<object>.<name>` on the identifier `object`? */
export const isMemberOf = (node, object, name) =>
  propertyName(node) === name && isIdent(unwrap(node)?.object, object);

/**
 * Is `node` a call of `name`, reached bare or through any object?
 *
 * Both spellings matter for the timer rules: `setTimeout(...)` is the global and
 * `timers.setTimeout(...)` / `globalThis.setTimeout(...)` is the same function
 * reached through an object. A rule that only knew the bare form would report a
 * checkmark over the other.
 */
export function isCallOf(node, name) {
  const call = unwrap(node);
  if (call?.type !== "CallExpression") return false;
  return isIdent(call.callee, name) || propertyName(call.callee) === name;
}

/**
 * The CALL behind `<object>.<name>(…)` — `Promise.race`, `expect.poll` — or
 * `undefined`.
 *
 * Hands back the UNWRAPPED node rather than a boolean, for two reasons that
 * turn out to be one. A rule that then reads `node.arguments` or
 * `node.callee` cannot be type-checked off a `boolean`, oxc's `Node` being a
 * union in which most members have neither. And it was reading the wrong node:
 * the test ran against `unwrap(node)` while the rule body used `node`, so a
 * parenthesized or `as`-wrapped call matched and was then walked as its
 * wrapper, finding nothing. Rule 31's doc records paying for that once already.
 *
 * @param {import("oxc-parser").Node} node
 * @returns {import("oxc-parser").CallExpression | undefined}
 */
export function callOfMember(node, object, name) {
  const call = unwrap(node);
  return call?.type === "CallExpression" && isMemberOf(call.callee, object, name)
    ? call
    : undefined;
}

/** Is `node` a call of `<object>.<name>` — `Promise.race`, `expect.poll`? */
export const isCallOfMember = (node, object, name) =>
  callOfMember(node, object, name) !== undefined;

/** Is `node` an arrow or a `function` expression? */
export const isFunctionExpression = (node) =>
  unwrap(node)?.type === "ArrowFunctionExpression" || unwrap(node)?.type === "FunctionExpression";

/**
 * The ONE expression a function body evaluates, or `undefined` when it does
 * more than one thing.
 *
 * This is the discriminator the ERE side could only approximate, and it is what
 * separates a hand-rolled wait from an ordinary promise that happens to contain
 * a timer. `new Promise((r) => setTimeout(r, 0))` exists solely to wait;
 * `new Promise((resolve) => { const socket = net.connect(...); ... })` is a
 * connection whose readiness happens to involve one. A line-based pattern sees
 * `new Promise` and `setTimeout` near each other and cannot tell them apart —
 * which is why the ERE version required both on ONE LINE, and why it therefore
 * missed every block-bodied occurrence including `aai-ui`'s own `tick()`.
 */
export function soleExpression(fn) {
  const body = unwrap(fn)?.body;
  if (body === undefined || body === null) return;
  if (body.type !== "BlockStatement") return unwrap(body);
  if (body.body.length !== 1) return;
  const [only] = body.body;
  if (only.type === "ExpressionStatement") return unwrap(only.expression);
  if (only.type === "ReturnStatement") return unwrap(only.argument) ?? undefined;
}

/** Every parameter of `fn` that is a plain identifier, by name. */
const parameterNames = (fn) =>
  new Set((unwrap(fn)?.params ?? []).filter((p) => p.type === "Identifier").map((p) => p.name));

/**
 * Does `node` do nothing but SETTLE the promise whose executor declares
 * `settlers` — either by being one of them, or by being a function that calls
 * one and does nothing else?
 *
 * The second half is the real five-second wait in both fuzz harnesses
 * (`setTimeout(() => r("hung"), 5000)`), which the flat argument class could not
 * cross. Requiring the wrapper to do nothing ELSE is what keeps a SCHEDULED
 * PIECE OF WORK out: `host/step-files.test.ts` defers a read with
 * `setTimeout(() => { inFlight -= 1; resolve(bytes...); }, 0)`, which is not a
 * yield and has no `flush()`/`tick()` remedy.
 */
function settlesOnly(node, settlers) {
  const inner = unwrap(node);
  if (isIdent(inner) && settlers.has(inner.name)) return true;
  if (!isFunctionExpression(inner)) return false;
  const only = soleExpression(inner);
  if (only?.type !== "CallExpression") return false;
  return isIdent(only.callee) && settlers.has(unwrap(only.callee).name);
}

/** A timer call's delay in milliseconds is zero when it is absent or literal 0. */
const isZeroDelay = (delay) => {
  const inner = unwrap(delay);
  return inner === undefined || (inner.type === "Literal" && inner.value === 0);
};

/**
 * What kind of WAIT `node` is, when it is a promise that exists only to wait:
 * `"yield"` for a zero-length one (rule 4), `"sleep"` for a real delay (rule
 * 19), `undefined` for anything else.
 *
 * The split is the whole reason the two rules are separate, and it is exact
 * here where the ERE side spelled it as "a digit 1-9, an identifier head, or an
 * open paren" after the comma — a class that had to be widened twice, once for
 * a computed delay and once for the two-parameter executor whose comma it was
 * reading as the delay's.
 *
 * `setImmediate` can only ever be a yield: it takes no delay at all.
 */
export function promiseWait(node) {
  if (node?.type !== "NewExpression" || !isIdent(node.callee, "Promise")) return;
  const [executor] = node.arguments;
  if (!isFunctionExpression(executor)) return;
  const settlers = parameterNames(executor);
  if (settlers.size === 0) return;
  const only = soleExpression(executor);
  if (only?.type !== "CallExpression") return;
  if (isCallOf(only, "setImmediate")) {
    return settlesOnly(only.arguments[0], settlers) ? "yield" : undefined;
  }
  if (!isCallOf(only, "setTimeout")) return;
  if (!settlesOnly(only.arguments[0], settlers)) return;
  return isZeroDelay(only.arguments[1]) ? "yield" : "sleep";
}

/**
 * The `node:timers/promises` sleep, which is the one timer
 * `vi.useFakeTimers()` cannot drive — so the spelling silently decides whether
 * a poll loop can be tested at all.
 *
 * Matched on the IMPORT, and on the specifier as well as the name: the ERE
 * version keyed on the substring `setTimeout as <ident>`, which is a rename in
 * ANY module, so `import { setTimeout as raf } from "./_timer.ts"` would have
 * been reported by a rule that has nothing to say about it.
 */
export function isTimersPromisesSleep(node) {
  if (node?.type !== "ImportDeclaration") return false;
  if (node.source?.value !== "node:timers/promises") return false;
  return (node.specifiers ?? []).some(
    (s) => s.type === "ImportSpecifier" && s.imported?.name === "setTimeout",
  );
}

/**
 * The event-registration methods a listener is handed to.
 *
 * Unlike its ERE twin the order carries no meaning at all — this is a set
 * lookup, where the regex had to be spelled longest-first so a reader checking
 * `addListener` against `addEventListener` did not have to reason about POSIX
 * alternation.
 */
const LISTENER_REGISTRARS = new Set([
  "addEventListener",
  "prependOnceListener",
  "prependListener",
  "addListener",
  "once",
  "on",
]);

/**
 * An `async` function handed STRAIGHT to an event registration, as the LISTENER
 * argument.
 *
 * Position rather than a character class is the improvement. The ERE required
 * the event name to hold no comma, which kept a hono handler out
 * (`app.on("GET", "/x", async (c) => ...)`, which the framework really does
 * await) at the cost of missing an options argument after the listener —
 * `signal.addEventListener("abort", async () => {}, { once: true })` is the
 * hazard with a third argument, and was invisible. Asking for the listener to
 * sit at index 1 spares the first and reports the second.
 */
export function asyncListener(node) {
  if (node?.type !== "CallExpression") return;
  const name = propertyName(node.callee);
  if (name === undefined || !LISTENER_REGISTRARS.has(name)) return;
  const listener = unwrap(node.arguments[1]);
  if (!isFunctionExpression(listener) || listener.async !== true) return;
  return listener;
}

/** Is `node` a division by a numeric literal — the `w / 2` half of a jitter? */
const isFractionOf = (node) => {
  const inner = unwrap(node);
  if (inner?.type !== "BinaryExpression" || inner.operator !== "/") return false;
  const divisor = unwrap(inner.right);
  return divisor?.type === "Literal" && typeof divisor.value === "number";
};

/** Is `node` `Math.random() * (w / N)` — a draw spread over part of a window? */
function isRandomFraction(node) {
  const inner = unwrap(node);
  if (inner?.type !== "BinaryExpression" || inner.operator !== "*") return false;
  const random = (side) => isCallOfMember(side, "Math", "random");
  if (random(inner.left)) return isFractionOf(inner.right);
  return random(inner.right) && isFractionOf(inner.left);
}

/**
 * A retry delay spread over a FRACTION of a computed window — the jitter half
 * of an exponential backoff, in either order it gets written.
 *
 * Deliberately the jitter and NOT the doubling, for the reason rule 31's remedy
 * gives. The commuted spelling costs nothing here: the ERE needed two
 * alternatives because multiplication commutes on the page, where this checks
 * both operands of one `+`.
 */
export function isJitteredWindow(node) {
  if (node?.type !== "BinaryExpression" || node.operator !== "+") return false;
  if (isFractionOf(node.left) && isRandomFraction(node.right)) return true;
  return isFractionOf(node.right) && isRandomFraction(node.left);
}
