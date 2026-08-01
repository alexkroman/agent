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

/** @typedef {{ label: string, capabilities: string[][], builtins?: string[], minTools?: number }} Expectation */

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
    builtins: ["fetch_json", "run_code"],
  },
  {
    label: "A web researcher that cites its sources",
    capabilities: [],
    builtins: ["web_search", "visit_webpage"],
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
      ["dashboard", "summary", "overview"],
    ],
    minTools: 6,
  },
  {
    label: "A text adventure in the style of Infocom",
    capabilities: [
      ["take", "get", "pick"],
      ["drop"],
      ["move", "go", "walk", "travel", "look"],
      ["inventory", "items"],
    ],
    minTools: 4,
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
  },
  {
    label: "A late-night movie, music, and book picker",
    capabilities: [["recommend", "pick", "suggest", "choose"]],
    minTools: 1,
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
  const missing = ["stt", "llm", "tts"].filter((k) => !new RegExp(`\\b${k}\\s*:`).test(source ?? ""));
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
export function checkCapabilities(expectation, { config, source }) {
  const declared = [...(config?.tools ?? []), ...toolNamesFromSource(source)].map(norm);
  const builtins = new Set([...(config?.tools ?? []), ...builtinsFromSource(source)]);
  const missing = [];
  for (const synonyms of expectation.capabilities ?? []) {
    const hit = synonyms.some((s) => declared.some((d) => d.includes(norm(s))));
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
