// Copyright 2026 the AAI authors. MIT license.
/**
 * What each starter prompt actually ASKED FOR, as checkable facts.
 *
 * The point is a success measure the agent cannot satisfy by weakening its
 * own test. "Builds and the tests pass" says nothing about whether the four
 * capabilities the prompt enumerated all exist — and dropping one is a
 * documented failure mode (the preamble has a rule against it). So each
 * starter declares the capabilities it named, and the check runs against the
 * built agent's config and source, not against anything the agent authored.
 *
 * `capabilities` are matched loosely (any listed synonym, in a tool name or
 * a tool key in agent.ts), because the agent legitimately chooses its own
 * names — `add_pizza`, `addPizza` and `add_item` are all the ask, while no
 * tool at all is not.
 *
 * `builtins` are exact: the prompt named them, and the SDK spells them one
 * way. `mode` follows the studio's own default rule (all-AssemblyAI
 * pipeline unless the user asked for the S2S voice-agent API).
 *
 * This was `scripts/starter-eval/expectations.mjs`, the last surviving file of
 * the second test runner the eval tier replaced — JavaScript, outside
 * `packages/`, and reached by both of this package's starter suites through a
 * `../../scripts/` specifier. Its neighbours were deleted as dead chains; it was
 * kept because it is the ASSERTION half, which is a different job from the case
 * loop. Moving it in is what retires the last nested `.mjs` under `scripts/`,
 * the package's `allowJs`, and the two `turbo.json` input overrides that existed
 * to hash a corpus living outside the package that reads it.
 *
 * @module
 */

import { invariant } from "@alexkroman1/aai/internal";

/**
 * One starter's ask, as facts about the agent it should produce.
 *
 * `ui: true` means the starter should produce a custom client.tsx. Set it
 * where the agent has state a person would want to watch — a cart, a
 * dashboard, an inventory. The default UI hides all of it, so an agent that
 * mutates visible state and ships no client is thinner than the ask.
 *
 * `builtinDelegation` names the builtins a prompt PRESCRIBES. For those
 * starters a capability also counts as covered when the agent declared the
 * builtins and its prose tells the model to use them for that task — see
 * {@link checkCapabilities}, which is where the two-halves rule lives.
 */
export type Expectation = {
  /** The starter's label, which must match one in `STARTERS`. */
  readonly label: string;
  /** Synonym groups: each group is one capability, any member satisfies it. */
  readonly capabilities: readonly (readonly string[])[];
  readonly builtins?: readonly string[];
  readonly builtinDelegation?: readonly string[];
  readonly minTools?: number;
  readonly ui?: boolean;
};

/** The agent the runtime actually built, as {@link parseLoadedConfig} read it. */
export type LoadedConfig = {
  readonly name: string;
  readonly mode: string;
  readonly tools: readonly string[];
};

/** A structural verdict, with the reason attached when it is a failure. */
export type CheckResult = {
  readonly ok: boolean;
  readonly note?: string;
};

/** What {@link checkCapabilities} found. */
export type CapabilityReport = {
  /** The first synonym of each capability the agent shows no sign of. */
  readonly missing: readonly string[];
  readonly missingBuiltins: readonly string[];
  readonly toolCount: number;
  readonly tooFewTools: boolean;
  readonly covered: boolean;
};

export const EXPECTATIONS: readonly Expectation[] = [
  {
    label: "A pizza-ordering agent with a real cart",
    capabilities: [
      ["add", "order_pizza"],
      ["remove", "delete", "cancel"],
      ["list", "show", "view", "summary", "total"],
      ["place", "submit", "checkout", "confirm"],
    ],
    minTools: 4,
    // The prompt asks for a themed cart view outright.
    ui: true,
  },
  {
    // These two prescribe run_code and name no custom tools, so grading on
    // tool names would fail the very design they asked for — the finance
    // trap, one starter over. But `capabilities: []` made them assert nothing
    // about the agent at all: with no UI expected either, "shippable" reduced
    // to "builds, declares run_code, is pipeline mode", which a three-line
    // systemPrompt satisfies. Both were passing in 3 tool calls and ~17s.
    //
    // What IS gradeable is what each prompt DEMANDS, via builtinDelegation:
    // the agent must declare run_code AND say what to reach for it for. Only
    // the demands, never the illustrative examples — "things like the 50th
    // Fibonacci number" enumerates nothing, and requiring it would recreate
    // the over-specification bug this file has been bitten by four times.
    label: "An agent that solves problems by writing code",
    // "always compute rather than guess, and read results aloud
    // conversationally" — two explicit clauses of the ask.
    capabilities: [
      ["compute", "calculat"],
      ["guess", "mental", "in your head", "in its head"],
      ["aloud", "conversation", "spoken", "out loud"],
    ],
    builtins: ["run_code"],
    builtinDelegation: ["run_code"],
  },
  {
    label: "A math tutor that never does arithmetic in its head",
    // "arithmetic, unit conversions, and dice rolls" — three enumerated
    // subjects. The prompt's negative framing ("never in its head") is
    // deliberately NOT graded: an agent that says "always use run_code"
    // without the negative has satisfied the ask by another wording.
    capabilities: [
      ["arithmetic", "calculat"],
      ["conversion", "convert"],
      ["dice", "roll"],
    ],
    builtins: ["run_code"],
    builtinDelegation: ["run_code"],
  },
  {
    label: "A personal finance helper with live prices",
    capabilities: [
      ["convert", "currency", "exchange"],
      ["price", "quote", "crypto", "bitcoin"],
      ["split", "tip", "bill"],
    ],
    // Deliberately NO `builtins` requirement, despite the prompt naming
    // fetch_json and run_code. Those are MODEL-facing tools; tool code cannot
    // call them, so an agent that writes custom tools using plain fetch has
    // satisfied the ask by another valid design. Requiring the declaration
    // failed two good agents. The capability check above covers the substance.
    //
    // The other valid design is the one the reference template actually uses:
    // no custom tools at all, just these two builtins and a system prompt
    // telling the model what to do with them. Graded on tool names that run
    // fails, and it failed three iterations running while being a near copy
    // of templates/personal-finance/agent.ts. See `builtinDelegation`.
    builtinDelegation: ["fetch_json", "run_code"],
  },
  {
    label: "A web researcher that cites its sources",
    capabilities: [],
    builtins: ["web_search", "visit_webpage"],
    ui: true,
  },
  {
    label: "An FAQ bot over an embedded knowledge base",
    capabilities: [
      ["list_topics", "topics"],
      ["search", "knowledge", "lookup"],
    ],
    minTools: 2,
  },
  {
    label: "A drug-interaction checker on openFDA",
    capabilities: [
      ["interaction", "check"],
      ["drug", "label", "lookup", "info"],
    ],
    minTools: 2,
  },
  {
    label: "A 911-style dispatch command center",
    capabilities: [
      ["create", "new_incident", "report"],
      ["triage", "priority", "severity"],
      ["escalate"],
      ["annotate", "note", "comment"],
      ["update", "status"],
      ["resource", "unit", "crew"],
      ["dispatch", "assign"],
      // The spoken one. The screen is checked by `ui` below — they are two
      // deliverables, and the prompt used to call both "the ops dashboard",
      // which is how agents shipped only the screen.
      ["status", "situation", "dashboard", "summary", "overview"],
    ],
    minTools: 6,
    ui: true,
  },
  {
    label: "A retail support agent that manages real orders",
    capabilities: [
      ["find_user", "email", "authenticate", "identify", "lookup_customer"],
      ["order", "get_order", "list_order"],
      ["cancel"],
      ["modify", "change", "update_order"],
      ["return", "exchange", "refund"],
      ["address"],
    ],
    minTools: 5,
    // The prompt asks for a live order view outright.
    ui: true,
  },
  {
    label: "A text adventure in the style of Infocom",
    // The prompt reads "inventory (take/drop), location, and puzzle flags" —
    // the parenthetical DEFINES inventory as take/drop, so requiring a
    // separate inventory tool over-specifies the ask (it wrongly failed an
    // agent with take_item/drop_item/look_around/move/solve_puzzle).
    capabilities: [
      ["take", "get", "pick"],
      ["drop"],
      ["move", "go", "walk", "travel", "look"],
      // "use_item"/"unlock" because that is how an Infocom puzzle is
      // actually solved, and two independent models converged on exactly
      // that design (a `use_item` tool that lights the lamp, unlocks the
      // door, bridges the pit, and sets the flags). The reference template
      // uses `game_state_flag`, which the earlier synonyms matched — so the
      // list described one valid design and failed the other.
      ["puzzle", "flag", "solve", "unlock", "use_item"],
    ],
    minTools: 4,
    ui: true,
  },
  {
    label: "A solo RPG with dice and a story oracle",
    capabilities: [
      ["character", "setup", "create"],
      ["roll", "action", "check"],
      ["momentum", "burn"],
      ["oracle", "ask"],
      ["save", "load"],
    ],
    minTools: 5,
    // A character sheet and momentum track are state you watch.
    ui: true,
  },
  {
    label: "A late-night movie, music, and book picker",
    capabilities: [["recommend", "pick", "suggest", "choose"]],
    minTools: 1,
    ui: true,
  },
];

/**
 * A capture group's text.
 *
 * Every group read through this helper is MANDATORY in its pattern, so a miss
 * cannot happen. It exists because `noUncheckedIndexedAccess` types an index
 * into a match as possibly-undefined, and the alternative at a dozen call sites
 * is a non-null assertion each — a suppression per line, for a condition the
 * regex already rules out. Genuinely OPTIONAL groups (the quote-style
 * alternation in {@link toolDescriptionsFromSource}) coalesce at their call
 * site instead, where the choice is the point.
 *
 * An {@link invariant} rather than the `?? ""` this used to be: the patterns
 * and their groups are both declared in this file, so a miss is a pattern
 * edited out from under a reader — and an empty string is that bug reported as
 * an agent that failed an expectation.
 */
const group = (m: RegExpMatchArray, i: number): string => {
  const text = m[i];
  invariant(text !== undefined, "starter.match.group", () => ({ i, matched: m[0] }));
  return text;
};

/**
 * `test_agent` reports the loaded config as prose. Parsing it is how the
 * check reads the agent the runtime ACTUALLY built, rather than trusting
 * source that may not be what compiled.
 *
 * Shape: `Agent "Name" (pipeline mode), tools: a, b, c.`
 */
export function parseLoadedConfig(text: string | undefined): LoadedConfig | undefined {
  const m = /Agent "([^"]*)" \(([a-z0-9]+) mode\), tools: ([^\n.]*)/i.exec(text ?? "");
  if (!m) return;
  const raw = group(m, 3).trim();
  return {
    name: group(m, 1),
    mode: group(m, 2),
    tools: raw === "" || /^\(none\)$/i.test(raw) ? [] : raw.split(/\s*,\s*/).filter(Boolean),
  };
}

/** Body of the `tools: { ... }` object literal, brace-matched. */
function toolsBlock(source: string): string | undefined {
  const at = source.search(/\btools\s*:\s*\{/);
  if (at === -1) return;
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
}

/** Tool keys declared in agent.ts — the fallback when nothing ever loaded. */
function toolNamesFromSource(source: string | undefined): string[] {
  if (!source) return [];
  const names = new Set<string>();
  // `tools: { add_pizza: ..., remove_pizza: ... }` — brace-matched rather
  // than regexed, so a nested object or an inline map is not truncated.
  const block = toolsBlock(source);
  if (block) {
    for (const m of block.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g)) names.add(group(m, 1));
  }
  // `const addPizza = tool({ ... })`
  for (const m of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*tool\s*\(/g)) {
    names.add(group(m, 1));
  }
  return [...names];
}

/**
 * The `description` strings of the agent's tools.
 *
 * A tool's description is the model-facing statement of what it does, and it
 * is where a capability lives when the identifier does not carry it. Grading
 * on names alone failed two agents that both implemented the same feature
 * properly: one shipped `use_item` described as "Use an inventory item on the
 * current room's puzzle. This owns puzzle flags" and set four puzzle flags;
 * the other tracked them from `move_location`. Neither used the word in an
 * identifier, so both were marked `missing:puzzle` — the same false negative
 * as the finance starter, one layer down.
 *
 * Not more gameable than matching names: both are agent-authored, while the
 * capability list comes from the prompt, which the agent cannot edit.
 */
function toolDescriptionsFromSource(source: string | undefined): string[] {
  const out: string[] = [];
  // Single, double and template quotes; descriptions routinely contain
  // apostrophes, so the character class per quote style matters. The three
  // groups are ALTERNATIVES, so exactly one is set and the coalescing chain is
  // the read — not `group`, whose contract is a mandatory match.
  for (const m of (source ?? "").matchAll(/description\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g)) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Builtins the agent declared, e.g. `builtinTools: ["run_code"]`. */
function builtinsFromSource(source: string | undefined): string[] {
  const m = /builtinTools\s*:\s*\[([^\]]*)\]/.exec(source ?? "");
  if (!m) return [];
  return [...group(m, 1).matchAll(/["'`]([\w-]+)["'`]/g)].map((x) => group(x, 1));
}

const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The studio's own default: an all-AssemblyAI cascaded pipeline unless the
 * user asked for the S2S voice-agent API. Ported from the eval suite's
 * CONFIG_CASES, which exist because this is a "will it run once published"
 * rule — ASSEMBLYAI_API_KEY is the only key publishing seeds, so an agent
 * that reaches for another provider unbidden cannot start.
 *
 * It took `source` as well, to note "provider-less agent" and "no loaded config
 * to check". Neither note could ever be READ — both rode on `ok: true`, and
 * `createRecorder` drops a `detail` on a check that held — so three regexes
 * existed to produce two strings no report saw. Stage presence needs no source
 * check either: any subset of stt/llm/tts (including none) is valid, since
 * unset stages are filled with the AssemblyAI defaults at parse time.
 */
export function checkMode(config: LoadedConfig | undefined): CheckResult {
  if (config === undefined || config.mode === "pipeline") return { ok: true };
  return { ok: false, note: `mode=${config.mode}, expected pipeline (studio default)` };
}

/**
 * A WORKFLOW project's shape, which is what {@link checkMode} cannot ask about.
 *
 * The hero's Workflow position creates the project under a system prompt whose
 * default is a STATIC workflow app, so "pipeline mode with all three stages on
 * AssemblyAI" is the wrong question here — there is no session and no pipeline.
 * The right one is whether the four pieces that make a workflow app exist, and
 * each is a thing the coding agent reaches for the OTHER shape by omitting: a
 * `workflowApp()` declaration rather than an `agent()`, a body under
 * `workflows/` (the only directory the build transforms, so a body in agent.ts
 * is undurable and silent about it), and a page — which is not optional here,
 * because it is the product's whole front door — mounted with `page()` rather
 * than `client()`, since a static page opened as a session dials a `/websocket`
 * the server declines.
 *
 * Checked against the FILES rather than the loaded config for the same reason
 * the capability check reads agent.ts: these are structural facts the agent
 * cannot edit a test to satisfy.
 */
export function checkWorkflowShape(files: Record<string, string> | undefined): CheckResult {
  const source = files?.["agent.ts"] ?? "";
  const client = files?.["client.tsx"];
  const problems: string[] = [];
  if (!/\bworkflowApp\s*\(/.test(source)) problems.push("no workflowApp() declaration");
  if (!Object.keys(files ?? {}).some((p) => p.startsWith("workflows/"))) {
    problems.push("no workflows/ body");
  }
  if (client === undefined) problems.push("no client.tsx (the front door)");
  else if (!/\bpage\s*\(/.test(client)) problems.push("client.tsx does not mount with page()");
  return problems.length === 0
    ? { ok: true }
    : { ok: false, note: `workflow-shape: ${problems.join("; ")}` };
}

/** Did the run produce a custom client, when the starter wanted one? */
export function checkUi(
  expectation: Expectation | undefined,
  files: Record<string, string> | undefined,
): CheckResult {
  if (!expectation?.ui) return { ok: true };
  const client = files?.["client.tsx"];
  if (client === undefined) return { ok: false, note: "no client.tsx (custom UI expected)" };
  // A client that never reads live data is decoration: the point is showing
  // state as it changes, which goes through one of the SDK's hooks.
  // `useAgentState` is listed FIRST because it is now the recommended one,
  // and omitting it marked a correct Infocom client as "no live state".
  const reactive = /useAgentState|useToolResult|useEvent|useSession/.test(client);
  return reactive ? { ok: true } : { ok: false, note: "client.tsx shows no live state" };
}

/**
 * The agent's WHOLE source, lowered — tool bodies, identifiers and comments
 * included, not just its system prompt and greeting.
 *
 * Where a capability lives when it is delegated to a builtin rather than written
 * as a tool: no tool name to match, only the instruction telling the model to
 * use `fetch_json` for a currency lookup. It was `agentProse`, documented as
 * "system prompt and greeting", which made the check look narrower than it is —
 * a synonym in a code COMMENT counts as the instruction. Narrowing it to the
 * real prose changes what the grader accepts and wants a measured run, not a
 * rename; this says what it does today.
 */
function agentSource(source: string | undefined): string {
  return (source ?? "").toLowerCase();
}

/**
 * Did the built agent cover what the prompt enumerated?
 *
 * Deliberately generous on naming and strict on presence: the failure this
 * exists to catch is a capability that is simply absent, not one spelled
 * differently than expected.
 *
 * (This doc comment sat above {@link checkUi} in the `.mjs` original, orphaned
 * by an edit that inserted a function between it and the one it describes.)
 */
export function checkCapabilities(
  expectation: Expectation,
  { config, source }: { config: LoadedConfig | undefined; source: string | undefined },
): CapabilityReport {
  const declared = [...(config?.tools ?? []), ...toolNamesFromSource(source)].map(norm);
  // Tool descriptions count as evidence too — see toolDescriptionsFromSource.
  const described = toolDescriptionsFromSource(source).map((d) => d.toLowerCase());
  const builtins = new Set([...(config?.tools ?? []), ...builtinsFromSource(source)]);
  /**
   * A prompt that PRESCRIBES builtins ("use the fetch_json builtin for live
   * data") is asking for an agent with no custom tools at all — which is what
   * the matching reference template is. Grading such a run on tool names
   * failed it three iterations running while it matched the template almost
   * line for line. So for those starters a capability also counts as covered
   * when the agent both declared the enabling builtins and instructed the
   * model to use them for that task.
   *
   * The two halves are both required, and that is what keeps it honest: the
   * greeting alone names all three capabilities, so prose by itself would
   * pass anything, and the builtins by themselves say nothing about what the
   * agent was told to do with them.
   */
  const delegation = expectation.builtinDelegation ?? [];
  const delegable = delegation.length > 0 && delegation.every((b) => builtins.has(b));
  const prose = delegable ? agentSource(source) : "";
  const missing: string[] = [];
  for (const synonyms of expectation.capabilities) {
    // Each synonym normalized ONCE: inside the inner `.some`, `norm(s)` ran per
    // candidate name rather than per synonym — ~500 calls where 24 do.
    const wanted = synonyms.map((s) => ({ normed: norm(s), lowered: s.toLowerCase() }));
    const hit = wanted.some(
      ({ normed, lowered }) =>
        declared.some((d) => d.includes(normed)) ||
        described.some((d) => d.includes(lowered)) ||
        (delegable && prose.includes(lowered)),
    );
    if (!hit && synonyms[0] !== undefined) missing.push(synonyms[0]);
  }
  const missingBuiltins = (expectation.builtins ?? []).filter((b) => !builtins.has(b));
  const toolCount = new Set(declared).size;
  return {
    missing,
    missingBuiltins,
    toolCount,
    tooFewTools: expectation.minTools !== undefined && toolCount < expectation.minTools,
    covered: missing.length === 0 && missingBuiltins.length === 0,
  };
}
