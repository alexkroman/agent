// Copyright 2026 the AAI authors. MIT license.
/**
 * The prompt↔builtin scan: which builtins a system prompt COMMANDS by name, and
 * whether the agent really has a tool of each name.
 *
 * Two prompt-only templates scanned their prompt for snake_case names, asked
 * the SDK's own schema which were builtins, and asserted each was declared — 32
 * byte-identical lines — while a third kept a hand list of web builtins and an
 * eight-line test guarding the hand list. Which tokens in the prose are TOOL
 * NAMES is a question for `BuiltinToolSchema`, never for a catalog restated in a
 * spec: a copied list goes stale the first time the SDK adds a builtin, and
 * matching every underscored word reddens on a prompt that names `annual_rate`
 * in a formula.
 *
 * Split out of `testing-deployable.ts` at the source-length cap, on the seam
 * between the two: that module reads the CONFIG a deploy carries, this one
 * reads the PROSE the model is handed. Published from the same subpath
 * (`@alexkroman1/aai/testing`, contracted as `aai:testing`) for the reason that
 * module gives — its only readers are the specs an author writes.
 *
 * @module testing-prompt-builtins
 */

import { createToolContext } from "./_testing-context.ts";
import {
  type AgentSystemPrompt,
  staticSystemPrompt,
  systemPromptResolver,
} from "./agent-instructions.ts";
import type { BuiltinTool } from "./builtin-tools.ts";
import { DEFAULT_BUILTIN_TOOLS } from "./constants.ts";
import { DEFAULT_SYSTEM_PROMPT } from "./system-prompt.ts";
import { BuiltinToolSchema } from "./type-schemas.ts";
import { errorMessage } from "./utils.ts";

/**
 * A snake_case token — two or more `_`-joined lowercase words. The shape most
 * builtins' names have, and the shape a prompt's own variables and formulas
 * share with it, which is why the match is then filtered through the schema.
 */
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * The builtins whose name is ONE ordinary English word — `think`, `calculate`,
 * `remember`, `recall` today. Read off the schema, so a single-word builtin a
 * later SDK adds is scanned for without an edit here.
 */
const SINGLE_WORD_BUILTINS: readonly string[] = BuiltinToolSchema.options.filter(
  (name) => !name.includes("_"),
);

/**
 * Where a single-word builtin reads as a TOOL NAME rather than as prose.
 *
 * A snake_case name cannot occur in English by accident; `think` and
 * `calculate` occur in every other prompt — "think before you answer",
 * "calculate the tip in your head", "remember their name" — and a scan that
 * matched the bare word would demand `think` be declared by every agent whose
 * prompt tells the model to think. So a single word counts only in one of three
 * positions, each a way an author NAMES a tool and none a way prose uses the
 * verb:
 *
 * 1. **In backticks** — `` `think` `` or `` `calculate()` ``: markdown's own
 *    way of saying "this is an identifier", and how the shipped prompts name
 *    their tools.
 * 2. **As the noun before "tool"**, after an article — "the calculate tool",
 *    "a think tool", "your recall tool". The article is what keeps "think
 *    tools through" out: a verb takes no article.
 * 3. **As the object of use/call/invoke** — "use calculate", "call think",
 *    "invoking recall". Those verbs take a THING; "use think" is not an
 *    English sentence unless `think` is a name. (Not "run": "run the numbers
 *    and calculate" would put the scan one word away from prose.)
 *
 * The word itself must be lowercase in all three — a tool name is — while the
 * verb and article may open a sentence. What it deliberately MISSES: a prompt
 * that names `think` bare ("think, then answer" meant as the tool). That prose
 * cannot be told from advice, and the miss costs a check nothing worse than
 * today's; a false hit would fail a correct agent.
 */
const SINGLE_WORD_POSITIONS: readonly RegExp[] = singleWordPositions(
  SINGLE_WORD_BUILTINS.join("|"),
);

/** The three positions of {@link SINGLE_WORD_POSITIONS}, over an alternation of names. */
function singleWordPositions(names: string): RegExp[] {
  if (names === "") return [];
  return [
    new RegExp(`\`(${names})(?:\\(\\))?\``, "g"),
    new RegExp(`\\b(?:[Tt]he|[Aa]n?|[Yy]our)\\s+(${names})\\s+tool\\b`, "g"),
    // Not "used"/"called": "a technique called recall" NAMES a concept, not a tool.
    new RegExp(
      `\\b(?:[Uu]ses?|[Uu]sing|[Cc]alls?|[Cc]alling|[Ii]nvokes?|[Ii]nvoking)\\s+(${names})\\b(?!-)`,
      "g",
    ),
  ];
}

/** Every builtin NAME mention in `prompt`, as `[index, name]` in any order. */
function mentions(prompt: string): [number, string][] {
  const found: [number, string][] = [];
  for (const match of prompt.matchAll(SNAKE_CASE)) found.push([match.index, match[0]]);
  for (const position of SINGLE_WORD_POSITIONS) {
    for (const match of prompt.matchAll(position)) {
      const name = match[1];
      // The index of the NAME, not the phrase: "use think" and "`think`" at the
      // same place must order the same against a snake_case neighbour.
      if (name !== undefined) found.push([match.index + match[0].indexOf(name), name]);
    }
  }
  return found;
}

/** Is this snake_case token one of the SDK's builtin tool names? */
function isBuiltin(name: string): name is BuiltinTool {
  return BuiltinToolSchema.safeParse(name).success;
}

/**
 * Every builtin the system prompt COMMANDS by name, in first-mention order.
 *
 * The prompt is scanned for snake_case tokens and each is asked of the SDK's own
 * builtin schema — so `run_code` and `fetch_json` are found, and the
 * `vs_currencies`, `per_person` and `annual_rate` a finance prompt names in its
 * endpoints and formulas are not. A builtin whose name is one English word
 * (`think`, `calculate`, `remember`, `recall`) is found only where the prose
 * NAMES it — in backticks, as "the calculate tool", or as the object of
 * use/call/invoke — so "think before you answer" commands nothing; the rule and
 * its reasons are on `SINGLE_WORD_POSITIONS` in this module. Reading the
 * CONFIG's prompt rather than a file: that is what a deploy carries, and it is
 * where `system-prompt.md` lands only if the build applied it.
 *
 * Takes only the field it reads, so an `AgentConfig` passes and so does a
 * `{ systemPrompt }` a spec assembled itself — a resolver's own text, say.
 *
 * A reader, not an assertion — {@link expectPromptBuiltinsDeclared} is the
 * claim most specs want. This is exported for the spec that wants to say more:
 * that a particular builtin is among the commanded ones, or that the prompt
 * commands exactly the set the template is about.
 *
 * **It reads what the CONFIG carries, which for a RESOLVER is nothing.**
 * `AgentDef.systemPrompt` may be a function, and `toAgentConfig` cannot
 * serialize one — it drops the field and the schema fills in
 * `DEFAULT_SYSTEM_PROMPT` — so a config converted from a resolver-based agent
 * hands this function the FRAMEWORK's prompt and gets `[]` back, which is a
 * true answer to the wrong question. Nothing here can tell that config from one
 * whose author simply wrote no prompt; the def can, which is why the check that
 * refuses is {@link expectPromptBuiltinsDeclared} and not this reader. To scan a
 * resolver's own text, resolve it and substitute it:
 * `commandedBuiltins({ systemPrompt: resolver(ctx) })`.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { toAgentConfig } from "@alexkroman1/aai/manifest";
 * import { commandedBuiltins } from "@alexkroman1/aai/testing";
 *
 * const config = toAgentConfig(
 *   agent({ name: "Penny", systemPrompt: "Use fetch_json for rates; annual_rate is a number." }),
 * );
 * console.log(commandedBuiltins(config)); // ["fetch_json"]
 * ```
 *
 * @public
 */
export function commandedBuiltins(config: { readonly systemPrompt: string }): BuiltinTool[] {
  const ordered = mentions(config.systemPrompt).sort(([a], [b]) => a - b);
  const names = new Set(ordered.map(([, name]) => name));
  return [...names].filter(isBuiltin);
}

/**
 * Every builtin the prompt commands is one `builtinTools` declares — or a throw
 * naming the ones that are not.
 *
 * The pairing a prompt-driven template is made of: the prose holds the rules
 * ("you MUST use `run_code` for arithmetic", "look rates up with `fetch_json`"),
 * and `agent.ts` holds the array that makes those tools exist. The failure is
 * silent in both directions and shows up in a diff of neither file — a prompt
 * commanding `fetch_json` at an agent that never declared it produces a model
 * apologizing for a tool it cannot see, and a builtin dropped from `agent.ts`
 * alone leaves an endpoint list addressed to nothing.
 *
 * **A prompt commanding NO builtin is a failure, not a pass.** Non-vacuity earns
 * its keep twice: a loop over nothing asserts nothing, and it is also the state a
 * template lands in when `system-prompt.md` was not applied — the framework
 * default names no builtin, so "I edited the prompt and nothing changed" fails
 * here instead of passing quietly with the template's rules nowhere in its
 * context. A spec whose prompt legitimately describes its tools rather than
 * naming them does not want this helper; it asserts on `builtinTools` directly.
 *
 * The converse is deliberately NOT asserted: declaring a builtin the prompt never
 * mentions is an ordinary edit, and the model learns about it from its own tool
 * schema rather than from the prose.
 *
 * **A custom tool of the same NAME declares it too.** An agent may replace a
 * builtin with its own `tools/text_me.ts` — a different channel, a different
 * recipient rule — and the prompt's "text it with `text_me`" is then addressed
 * to that tool, which the model sees under exactly that name. The claim is "the
 * model has a tool called this", and `def.tools` answers it as well as
 * `builtinTools` does. That is why `tools` is read, and why a def lowered with
 * `deployedAgent` (or imported from `virtual:aai/agent`) is the one to pass: the
 * authored `./agent.ts` carries no `tools`.
 *
 * **A RESOLVER is CALLED, and refused when it cannot be.** `systemPrompt` may be
 * a function, and `toAgentConfig` drops one rather than putting it on the wire —
 * so scanning the converted config would read the FRAMEWORK's default prompt and
 * report on a prompt this agent never sends. That is the one outcome a check may
 * not have: the default names no builtin, so scanning it fails for the wrong
 * reason — pointing at an unapplied `system-prompt.md` that is not the problem —
 * and PASSES the day the default happens to name one. So the resolver is
 * called with a bare {@link createToolContext} — a fresh session id, no env, an
 * empty slot store — and its answer is what gets scanned. That is enough for the
 * prose half, which is a `?raw` import closed over by the function and does not
 * vary with session state. A resolver that cannot answer from a bare context
 * (it reads an env var, or a slot it expects seeded) THROWS, and this refuses by
 * name rather than falling back to the default: seed a context and scan the text
 * yourself with {@link commandedBuiltins}, or assert on `builtinTools` directly.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { expectPromptBuiltinsDeclared } from "@alexkroman1/aai/testing";
 *
 * const commanded = expectPromptBuiltinsDeclared(
 *   agent({
 *     name: "Coda",
 *     systemPrompt: "Answer every sum by calling run_code.",
 *     builtinTools: ["run_code"],
 *   }),
 * );
 * console.log(commanded); // ["run_code"]
 * ```
 *
 * @param def - The agent under test — only its `systemPrompt`, `builtinTools`
 *   and the KEYS of `tools` are read, so an `agent()` def passes as it is. Whether the
 *   WHOLE def converts is {@link expectDeployable}'s claim, not this one's.
 * @returns The commanded builtins, for a spec that wants to say more about them.
 * @throws When the prompt names no builtin, when it names one `builtinTools`
 * lacks, or when a `systemPrompt` resolver cannot answer from a bare context.
 *
 * @public
 */
export function expectPromptBuiltinsDeclared(def: {
  readonly systemPrompt?: AgentSystemPrompt | undefined;
  readonly builtinTools?: readonly BuiltinTool[] | undefined;
  readonly tools?: Readonly<Record<string, unknown>> | undefined;
}): BuiltinTool[] {
  // What `toAgentConfig` would carry, read off the two fields directly: a
  // string prompt as written, the schema's default when there is none, and a
  // resolver's own answer — see `resolvedPrompt`.
  const config = { systemPrompt: resolvedPrompt(def.systemPrompt) };
  const commanded = commandedBuiltins(config);
  if (commanded.length === 0) {
    // Composed from short pieces: Biome's `noSecrets` reads one long,
    // punctuation-dense literal as a high-entropy secret.
    const hint = [
      "if the prompt lives in `system-prompt.md`, is it applied?",
      "A spec importing `./agent.ts` reads the framework default prompt;",
      "import `virtual:aai/agent` (or lower it with `deployedAgent`)",
      "to read the one a deploy carries.",
    ].join(" ");
    // The function's own name, read off it: as a literal, the mixed-case
    // identifier alone reads to `noSecrets` as a high-entropy secret.
    const prefix = `${expectPromptBuiltinsDeclared.name}:`;
    throw new Error(
      `${prefix} the system prompt commands no builtin at all, so there is nothing to check — ${hint}`,
    );
  }
  // Unset means the default surface, which is what a deploy serves.
  const declared = new Set<string>(def.builtinTools ?? DEFAULT_BUILTIN_TOOLS);
  // A custom tool under a builtin's name is the tool the model sees by it.
  const custom = new Set(Object.keys(def.tools ?? {}));
  const missing = commanded.filter((name) => !(declared.has(name) || custom.has(name)));
  if (missing.length > 0) {
    throw new Error(
      `expectPromptBuiltinsDeclared: the prompt commands ${missing.map((n) => JSON.stringify(n)).join(", ")} ` +
        `and \`builtinTools\` declares ${declared.size === 0 ? "none" : [...declared].join(", ")}, ` +
        "with no custom tool of that name — " +
        "a model told to use a tool it cannot see apologizes for it on every turn",
    );
  }
  return commanded;
}

/**
 * The prompt to SCAN: the string as written, the framework default when there
 * is none (what `toAgentConfig`'s schema fills in), or what the agent's
 * `systemPrompt` resolver answers.
 *
 * Separate from {@link commandedBuiltins} because only a caller holding the DEF
 * can tell "this agent has a resolver" from "this agent declared no prompt" —
 * the two arrive at `toAgentConfig` differently and leave it identical.
 *
 * @throws When the def carries a resolver that cannot answer from a bare
 * context. Refusing is the point: the alternative is scanning
 * `DEFAULT_SYSTEM_PROMPT` and reporting on a prompt the agent never sends.
 */
function resolvedPrompt(prompt: AgentSystemPrompt | undefined): string {
  const resolver = systemPromptResolver(prompt);
  if (resolver === undefined) return staticSystemPrompt(prompt) ?? DEFAULT_SYSTEM_PROMPT;
  let resolved: unknown;
  try {
    // A bare session: a fresh id, no env, an empty slot store. Every slot read
    // answers with its declared initial value, which is what a resolver sees on
    // the first request of a real session too.
    resolved = resolver(createToolContext());
  } catch (cause) {
    throw new Error(refusal(`calling it threw — ${errorMessage(cause)}`), { cause });
  }
  if (typeof resolved !== "string" || resolved.trim() === "") {
    throw new Error(refusal(`it answered ${JSON.stringify(resolved)} rather than a prompt`));
  }
  return resolved;
}

/**
 * Both refusals above: what went wrong, and the way out of either.
 *
 * Composed from short pieces and reading the function's own name off it, for the
 * reason the vacuity message does: `noSecrets` reads a long punctuation-dense
 * literal, and a bare mixed-case identifier, as high-entropy secrets.
 */
function refusal(what: string): string {
  const head = [expectPromptBuiltinsDeclared.name, ": this agent's `systemPrompt` is a "].join("");
  const out = [
    "There is nothing to scan, and the converted config carries the FRAMEWORK's",
    "default prompt rather than yours — checking that one would report on a prompt",
    "this agent never sends. Seed a context, call the resolver yourself, and scan",
    "its text — hand `commandedBuiltins` a `{ systemPrompt }` of your own.",
    "Or assert on `builtinTools` directly.",
  ].join(" ");
  return `${head}resolver and ${what}. ${out}`;
}
