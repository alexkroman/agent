// Copyright 2026 the AAI authors. MIT license.
/**
 * The invariants every STARTER spec asserts.
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
 * The prompt↔builtin scan beside it (`commandedBuiltins`,
 * `expectPromptBuiltinsDeclared`) is `testing-prompt-builtins.ts`, split out at
 * the source-length cap on the seam between the two: this module reads the
 * CONFIG a deploy carries, that one reads the PROSE the model is handed.
 *
 * On `@alexkroman1/aai/testing` rather than `/manifest`, though this is
 * config knowledge beside `AgentConfigSchema`: `/manifest` is on
 * `NON_AUTHORING_SUBPATHS` — no capability, no epoch, no reference page — and
 * the only reader of these helpers is a spec an author writes. Publishing a
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
import { errorMessage } from "./utils.ts";

/**
 * One provider stage of a {@link DeployedConfig} — the descriptor as it will be
 * deployed: its `kind`, and its `options` exactly as serialized.
 *
 * @sealed
 * @public
 */
export interface DeployedStage {
  /** The provider the stage resolves through, e.g. `"assemblyai"`. */
  readonly kind: string;
  /** The descriptor's options, as they cross the wire. */
  readonly options?: Readonly<Record<string, unknown>> | undefined;
}

/**
 * What {@link expectDeployable} hands back: the RESOLVED config a deploy
 * carries, narrowed to the fields a starter spec asserts on.
 *
 * Not the whole `AgentConfig`, on purpose. That type is inferred from the
 * canonical config SCHEMA, so returning it put the schema — every serializable
 * agent field, each with its own validation shape — into this subpath's
 * contract, and a new agent field moved a TEST helper's hash. These are the
 * fields the shipped specs read; the object returned is the real config, so a
 * spec that needs one more can read it off `toAgentConfig`
 * (`@alexkroman1/aai/manifest`) directly.
 *
 * `mode` is always present: {@link expectDeployable} refuses a conversion that
 * derived none.
 *
 * @sealed
 * @public
 */
export interface DeployedConfig {
  /** The name the platform lists the agent under. */
  readonly name: string;
  /**
   * The system prompt a deploy carries — the author's string, or the framework
   * default when there is none. A RESOLVER is not carried (it cannot be
   * serialized), so an agent with one reads the default here.
   */
  readonly systemPrompt: string;
  /** The session mode the conversion derived. */
  readonly mode: "pipeline" | "s2s" | "text";
  /** `true` for a text agent. */
  readonly text?: true | undefined;
  /** The STT stage — declared, or the injected default in pipeline mode. */
  readonly stt?: DeployedStage | undefined;
  /** The LLM stage — declared, or the injected default in pipeline mode. */
  readonly llm?: DeployedStage | undefined;
  /** The TTS stage — declared, or the injected default in pipeline mode. */
  readonly tts?: DeployedStage | undefined;
  /** The speech-to-speech descriptor, for an s2s agent. */
  readonly s2s?: DeployedStage | undefined;
  /** The builtins the agent declares (absent: the default surface). */
  readonly builtinTools?: readonly BuiltinTool[] | undefined;
  /** Who ends the caller's turn — `"manual"` for push-to-talk. */
  readonly turnDetection?: string | undefined;
  /** The session's token budget, when it declares one. */
  readonly usageLimits?: { readonly totalTokens?: number | undefined } | undefined;
  /** The MCP servers whose tools join the agent's own, by key. */
  readonly mcpServers?: Readonly<Record<string, Readonly<Record<string, unknown>>>> | undefined;
  /** The env var names a deploy preflights. */
  readonly requiredEnv?: readonly string[] | undefined;
}

/** The three pipeline stages, in the order a failure names them. */
const PIPELINE_STAGES = ["stt", "llm", "tts"] as const;

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
 *   default export of an `agent.ts`. Structural: only `name` is required of
 *   the TYPE, because validating the rest is this helper's job at run time —
 *   the same `toAgentConfig` a deploy runs. Generic only so a spread literal
 *   carrying a field this type does not name (`{ ...def, maxSteps: 0 }`) is
 *   not an excess-property error.
 * @returns The config a deploy carries, mode derived and defaults injected —
 *   see {@link DeployedConfig} for the fields it names.
 * @throws Naming the invariant that failed, and — for the validation one — the
 *   sentence `toAgentConfig` wrote about the field.
 *
 * @public
 */
export function expectDeployable<
  const D extends {
    readonly name: unknown;
    readonly stt?: unknown;
    readonly llm?: unknown;
    readonly tts?: unknown;
  },
>(def: D): DeployedConfig {
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
    // Typed by SHAPE only (see the parameter), and validated by the conversion
    // itself — which is the claim under test — so the cast claims nothing the
    // next line does not check.
    const source: unknown = def;
    config = toAgentConfig(source as AgentConfigSource);
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
  const mode = assertStagesFilled(def, config);
  return { ...config, mode };
}

/**
 * The third invariant: what the derived mode needs, and nothing it forbids.
 * Answers the mode, which is what makes {@link DeployedConfig.mode} required.
 */
function assertStagesFilled(
  def: Readonly<Partial<Record<(typeof PIPELINE_STAGES)[number], unknown>>>,
  config: AgentConfig,
): DeployedConfig["mode"] {
  switch (config.mode) {
    case "s2s":
      assertS2sAlone(config);
      return config.mode;
    case "text":
      assertNoAudioPath(config, "text mode", "a text agent has no audio path");
      return config.mode;
    case "pipeline":
      assertPipelineFilled(def, config);
      return config.mode;
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
function assertPipelineFilled(
  def: Readonly<Partial<Record<(typeof PIPELINE_STAGES)[number], unknown>>>,
  config: AgentConfig,
): void {
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
