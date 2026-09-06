// Copyright 2026 the AAI authors. MIT license.
/**
 * The invariants every STARTER spec asserts, and the prompt↔builtin scan.
 *
 * `aai init` scaffolds a template's `agent.test.ts` verbatim into a user's
 * project and `aai build` runs it before bundling, so what such a spec may
 * assert is narrow: a property that survives a rename, a voice, a stage swap
 * and a switch to speech-to-speech, on the RESOLVED config rather than the def's
 * empty fields. Six shipped templates had written the same three tests under
 * the same ten-line comment — the config passes `toAgentConfig`, the platform
 * can name the agent, every stage its mode needs is filled — and three of them
 * carried the mode cascade byte-identically at twenty-one lines each. That is
 * a spec's business exactly once, which is what {@link expectDeployable} is.
 *
 * {@link commandedBuiltins} and {@link expectPromptBuiltinsDeclared} are the
 * other duplicated block: two prompt-only templates scanned their prompt for
 * snake_case names, asked the SDK's own schema which were builtins, and asserted
 * each was declared — 32 byte-identical lines — while a third kept a hand list
 * of web builtins and an eight-line test guarding the hand list. Which tokens in
 * the prose are TOOL NAMES is a question for `BuiltinToolSchema`, never for a
 * catalog restated in a spec: a copied list goes stale the first time the SDK
 * adds a builtin, and matching every underscored word reddens on a prompt that
 * names `annual_rate` in a formula.
 *
 * On `@alexkroman1/aai/testing` rather than `/manifest`, though the scan is
 * config knowledge beside `AgentConfigSchema`: `/manifest` is on
 * `NON_AUTHORING_SUBPATHS` — no capability, no epoch, no reference page — and
 * the only reader of either helper is a spec an author writes. Publishing a
 * name to authors on a subpath that promises them nothing is the wrong trade;
 * this one is contracted (`aai:testing`) and its readers are exactly the specs.
 *
 * Every failure here THROWS naming the invariant, on the principle the
 * `@alexkroman1/aai-runtime/eval` readers follow: `expect(() =>
 * toAgentConfig(def)).not.toThrow()` failing prints "expected function not to
 * throw" and buries the sentence `toAgentConfig` wrote about which field is
 * wrong.
 *
 * @module testing-deployable
 */

import { type AgentConfig, type AgentConfigSource, toAgentConfig } from "./agent-config.ts";
import type { BuiltinTool } from "./builtin-tools.ts";
import { isRecord } from "./is-record.ts";
import { BuiltinToolSchema } from "./type-schemas.ts";
import { errorMessage } from "./utils.ts";

/** The three pipeline stages, in the order a failure names them. */
const PIPELINE_STAGES = ["stt", "llm", "tts"] as const;

/**
 * A snake_case token — two or more `_`-joined lowercase words. The shape every
 * builtin's name has, and the shape a prompt's own variables and formulas share
 * with it, which is why the match is then filtered through the schema.
 */
const SNAKE_CASE = /\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g;

/**
 * Run the invariants a deployable agent owes, and hand back the RESOLVED config
 * so a spec can go on to assert its own specifics — a chosen model, a declared
 * builtin — without converting twice.
 *
 * Three invariants, each thrown by name:
 *
 * - **The config passes manifest validation** — the same `toAgentConfig` that
 *   `aai build` and `aai deploy` run, so an invalid provider combination or
 *   tuning fails here rather than at the first live session.
 * - **The platform can name it** — there IS a name, and the conversion carries
 *   it through. Not the literal: renaming the agent is the first edit a starter
 *   invites, and the studio lists a deployed agent by exactly this string.
 * - **Every stage its mode needs is filled, declared or defaulted** — asserted
 *   per MODE so it survives a swap. A pipeline agent has an `stt`, `llm` and
 *   `tts` kind, each declared stage surviving as declared and each unset one
 *   filled by `defaultProviders`; a text agent has no audio stage (its `llm`
 *   may be absent — `createTextAgent` defaults the one stage it has); an `s2s`
 *   agent has an `s2s` kind and NO cascade, since speech-to-speech replaces the
 *   pipeline rather than joining it — the one thing that must never happen by
 *   fallthrough.
 *
 * `toAgentConfig` already refuses most of the states the second and third
 * invariants describe (a blank name, `s2s` beside a pipeline stage). They are
 * checked here anyway, and BEFORE or AFTER the conversion as the message needs,
 * because the value of this helper is the sentence: a spec that failed on
 * "expected function not to throw" has to re-run the conversion by hand to
 * learn which invariant went.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { expectDeployable } from "@alexkroman1/aai/testing";
 *
 * const config = expectDeployable(agent({ name: "Desk", builtinTools: ["run_code"] }));
 * // The invariants held; now the template's own claim.
 * console.log(config.builtinTools); // ["run_code"]
 * ```
 *
 * @param def - The agent under test — an `agent()` definition, or the raw
 *   default export of an `agent.ts`. Structural, like `toAgentConfig`.
 * @returns The config a deploy carries, mode derived and defaults injected.
 * @throws Naming the invariant that failed, and — for the validation one — the
 *   sentence `toAgentConfig` wrote about the field.
 *
 * @public
 */
export function expectDeployable(def: AgentConfigSource): AgentConfig {
  // BEFORE the conversion: `toAgentConfig` refuses a blank name too, and its
  // message says "name must not be blank", which is right and is not this
  // spec's claim. The claim is that the platform has something to list.
  if (typeof def.name !== "string" || def.name.trim() === "") {
    throw new Error(
      "expectDeployable: the agent has no name the platform can list — `agent({ name })` is " +
        "what the studio shows and the slug is derived from",
    );
  }
  let config: AgentConfig;
  try {
    config = toAgentConfig(def);
  } catch (cause) {
    throw new Error(
      `expectDeployable: the config does not pass manifest validation — ${errorMessage(cause)}`,
      { cause },
    );
  }
  if (config.name !== def.name) {
    throw new Error(
      "expectDeployable: the conversion did not carry the name through — the def says " +
        `${JSON.stringify(def.name)} and the config ${JSON.stringify(config.name)}`,
    );
  }
  assertStagesFilled(def, config);
  return config;
}

/** The third invariant: what the derived mode needs, and nothing it forbids. */
function assertStagesFilled(def: AgentConfigSource, config: AgentConfig): void {
  switch (config.mode) {
    case "s2s":
      assertS2sAlone(config);
      break;
    case "text":
      assertNoAudioPath(config, "text mode", "a text agent has no audio path");
      break;
    case "pipeline":
      assertPipelineFilled(def, config);
      break;
    default:
      throw new Error(
        `expectDeployable: the conversion derived no session mode (got ${JSON.stringify(config.mode)})`,
      );
  }
}

/** s2s: a descriptor carries the mode, and NO cascade stands beside it. */
function assertS2sAlone(config: AgentConfig): void {
  if (!config.s2s?.kind) {
    throw new Error("expectDeployable: s2s mode was derived and no s2s descriptor carries it");
  }
  if (config.llm !== undefined) {
    throw new Error(
      "expectDeployable: s2s mode still carries an llm stage — speech-to-speech REPLACES the " +
        "pipeline, so no cascade may be filled beside it",
    );
  }
  assertNoAudioPath(config, "s2s mode", "speech-to-speech REPLACES the pipeline");
}

/**
 * No `stt` and no `tts`. For a text agent that is the whole invariant — an
 * absent `llm` is fine, since `defaultProviders` skips a text agent and
 * `createTextAgent` defaults the one stage it has.
 */
function assertNoAudioPath(config: AgentConfig, mode: string, why: string): void {
  for (const stage of ["stt", "tts"] as const) {
    if (config[stage] !== undefined) {
      throw new Error(`expectDeployable: ${mode} still carries a ${stage} stage — ${why}`);
    }
  }
}

/** pipeline: every stage has a kind, and a declared one survived as declared. */
function assertPipelineFilled(def: AgentConfigSource, config: AgentConfig): void {
  for (const stage of PIPELINE_STAGES) {
    const resolved = config[stage]?.kind;
    if (!resolved) {
      throw new Error(
        `expectDeployable: pipeline mode left the ${stage} stage unfilled — nothing ` +
          "declared it and no default was injected",
      );
    }
    const declared = def[stage];
    if (isRecord(declared) && typeof declared.kind === "string" && declared.kind !== resolved) {
      throw new Error(
        `expectDeployable: the declared ${stage} stage (${JSON.stringify(declared.kind)}) ` +
          `did not survive the conversion — the config carries ${JSON.stringify(resolved)}`,
      );
    }
  }
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
 * endpoints and formulas are not. Reading the CONFIG's prompt rather than a
 * file: that is what a deploy carries, and it is where `system-prompt.md` lands
 * only if the build applied it.
 *
 * A reader, not an assertion — {@link expectPromptBuiltinsDeclared} is the
 * claim most specs want. This is exported for the spec that wants to say more:
 * that a particular builtin is among the commanded ones, or that the prompt
 * commands exactly the set the template is about.
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
export function commandedBuiltins(config: AgentConfig): BuiltinTool[] {
  const tokens = new Set(config.systemPrompt.match(SNAKE_CASE) ?? []);
  return [...tokens].filter(isBuiltin);
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
 * @param def - The agent under test, converted through `toAgentConfig` so the
 *   scan reads the prompt a deploy carries.
 * @returns The commanded builtins, for a spec that wants to say more about them.
 * @throws When the prompt names no builtin, or names one `builtinTools` lacks.
 *
 * @public
 */
export function expectPromptBuiltinsDeclared(def: AgentConfigSource): BuiltinTool[] {
  const config = toAgentConfig(def);
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
  const declared = new Set<string>(config.builtinTools ?? []);
  const missing = commanded.filter((name) => !declared.has(name));
  if (missing.length > 0) {
    throw new Error(
      `expectPromptBuiltinsDeclared: the prompt commands ${missing.map((n) => JSON.stringify(n)).join(", ")} ` +
        `and \`builtinTools\` declares ${declared.size === 0 ? "none" : [...declared].join(", ")} — ` +
        "a model told to use a tool it cannot see apologizes for it on every turn",
    );
  }
  return commanded;
}
