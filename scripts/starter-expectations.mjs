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
 */

/**
 * `ui: true` means the starter should produce a custom client.tsx. Set it
 * where the agent has state a person would want to watch — a cart, a
 * dashboard, an inventory. The default UI hides all of it, so an agent that
 * mutates visible state and ships no client is thinner than the ask.
 *
 * @typedef {{ label: string, capabilities: string[][], builtins?: string[],
 *   minTools?: number, ui?: boolean }} Expectation
 */

/** @type {Expectation[]} */
export const EXPECTATIONS = [
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
    label: "An agent that solves problems by writing code",
    capabilities: [],
    builtins: ["run_code"],
  },
  {
    label: "A math tutor that never does arithmetic in its head",
    capabilities: [],
    builtins: ["run_code"],
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
 * `test_agent` reports the loaded config as prose. Parsing it is how the
 * check reads the agent the runtime ACTUALLY built, rather than trusting
 * source that may not be what compiled.
 *
 * Shape: `Agent "Name" (pipeline mode), tools: a, b, c.`
 */
export function parseLoadedConfig(text) {
  const m = /Agent "([^"]*)" \(([a-z0-9]+) mode\), tools: ([^\n.]*)/i.exec(text ?? "");
  if (!m) return undefined;
  const raw = (m[3] ?? "").trim();
  return {
    name: m[1],
    mode: m[2],
    tools: raw === "" || /^\(none\)$/i.test(raw) ? [] : raw.split(/\s*,\s*/).filter(Boolean),
  };
}

/** Body of the `tools: { ... }` object literal, brace-matched. */
function toolsBlock(source) {
  const at = source.search(/\btools\s*:\s*\{/);
  if (at === -1) return undefined;
  const open = source.indexOf("{", at);
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    if (source[i] === "{") depth++;
    else if (source[i] === "}" && --depth === 0) return source.slice(open + 1, i);
  }
  return undefined;
}

/** Tool keys declared in agent.ts — the fallback when nothing ever loaded. */
export function toolNamesFromSource(source) {
  if (!source) return [];
  const names = new Set();
  // `tools: { add_pizza: ..., remove_pizza: ... }` — brace-matched rather
  // than regexed, so a nested object or an inline map is not truncated.
  const block = toolsBlock(source);
  if (block) {
    for (const m of block.matchAll(/(?:^|[\s,{])([A-Za-z_$][\w$]*)\s*:/g)) names.add(m[1]);
  }
  // `const addPizza = tool({ ... })`
  for (const m of source.matchAll(/(?:const|let)\s+([A-Za-z_$][\w$]*)\s*=\s*tool\s*\(/g)) {
    names.add(m[1]);
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
export function toolDescriptionsFromSource(source) {
  const out = [];
  // Single, double and template quotes; descriptions routinely contain
  // apostrophes, so the character class per quote style matters.
  for (const m of (source ?? "").matchAll(
    /description\s*:\s*(?:"([^"]*)"|'([^']*)'|`([^`]*)`)/g,
  )) {
    out.push(m[1] ?? m[2] ?? m[3] ?? "");
  }
  return out;
}

/** Builtins the agent declared, e.g. `builtinTools: ["run_code"]`. */
export function builtinsFromSource(source) {
  const m = /builtinTools\s*:\s*\[([^\]]*)\]/.exec(source ?? "");
  if (!m) return [];
  return [...m[1].matchAll(/["'`]([\w-]+)["'`]/g)].map((x) => x[1]);
}

const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * The studio's own default: an all-AssemblyAI cascaded pipeline unless the
 * user asked for the S2S voice-agent API. Ported from the eval suite's
 * CONFIG_CASES, which exist because this is a "will it run once published"
 * rule — ASSEMBLYAI_API_KEY is the only key publishing seeds, so an agent
 * that reaches for another provider unbidden cannot start.
 */
export function checkMode(config, source) {
  if (!config) return { ok: true, note: "no loaded config to check" };
  if (config.mode !== "pipeline") {
    return { ok: false, note: `mode=${config.mode}, expected pipeline (studio default)` };
  }
  // The three stages must each be declared; the source is the only place the
  // provider kind is visible, since the loaded-config line reports mode only.
  //
  // `assemblyAIPipeline()` sets all three at once, so spreading it satisfies
  // every stage. Without this the check reported "missing stt, llm, tts" for
  // an agent that had all three — a false negative created the moment the
  // guide started recommending the preset, which is exactly what it is for.
  const src = source ?? "";
  const missing = /assemblyAIPipeline\s*\(/.test(src)
    ? []
    : ["stt", "llm", "tts"].filter((k) => !new RegExp(`\\b${k}\\s*:`).test(src));
  return missing.length
    ? { ok: false, note: `pipeline missing stage(s): ${missing.join(", ")}` }
    : { ok: true };
}

/**
 * Did the built agent cover what the prompt enumerated?
 *
 * Deliberately generous on naming and strict on presence: the failure this
 * exists to catch is a capability that is simply absent, not one spelled
 * differently than expected.
 */
/** Did the run produce a custom client, when the starter wanted one? */
export function checkUi(expectation, files) {
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
 * The prose an agent ships — system prompt and greeting.
 *
 * Where a capability lives when it is delegated to a builtin rather than
 * written as a tool: there is no tool name to match, only the instruction
 * that tells the model to use `fetch_json` for a currency lookup.
 */
function agentProse(source) {
  return String(source ?? "").toLowerCase();
}

export function checkCapabilities(expectation, { config, source }) {
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
  const delegable =
    (expectation.builtinDelegation ?? []).length > 0 &&
    expectation.builtinDelegation.every((b) => builtins.has(b));
  const prose = delegable ? agentProse(source) : "";
  const missing = [];
  for (const synonyms of expectation.capabilities ?? []) {
    const hit =
      synonyms.some((s) => declared.some((d) => d.includes(norm(s)))) ||
      synonyms.some((s) => described.some((d) => d.includes(s.toLowerCase()))) ||
      (delegable && synonyms.some((s) => prose.includes(s.toLowerCase())));
    if (!hit) missing.push(synonyms[0]);
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
