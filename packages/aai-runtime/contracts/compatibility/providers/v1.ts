// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:providers` epoch 1.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 1 is advertised as supported.** A compile error here is the
 * finding, not something to edit away — `pnpm typecheck` is the
 * backward-compatibility gate for this capability. Imports are RELATIVE
 * (`../../../runtime-barrel.ts`) because the package cannot resolve itself by
 * name.
 *
 * This is the seam a HOST embedding the runtime writes against; an agent author
 * never touches it. Two halves, and the file is both:
 *
 * - **Substituting a speech stage** (`registerSttKind` / `registerTtsKind`).
 *   The example is a text front door over an ordinary voice agent: the STT
 *   stage is driven by typed input instead of audio, and the TTS stage collects
 *   the reply text instead of synthesizing it. Everything above the audio
 *   boundary — the real pipeline transport, the real LLM loop, the real tool
 *   executor — runs unchanged, which is exactly what `aai-evals`' level-1
 *   target does with this seam. Registering a KIND rather than handing in a
 *   pre-resolved opener is the point: a registered stage resolves exactly like
 *   a shipped provider, its env var included, so production code only ever sees
 *   descriptors.
 * - **Reaching the LLM the agent named** (`resolveLlm`), and the tool-call
 *   repair that goes with a `streamText` loop a host drives itself
 *   (`createToolCallRepair`, `salvageJson`).
 *
 * `S2SConfig` rounds it out: the endpoint an embedded runtime's S2S sessions
 * connect to.
 */

// The DESCRIPTOR types stay on the authoring subpaths: a descriptor is what a
// factory returns and what an agent config carries, which is an author's
// concern. The opener contract below is the host's half of the same seam.
import type { LlmProvider } from "@alexkroman1/aai/llm";
import type { SttProvider } from "@alexkroman1/aai/stt";
import type { TtsProvider } from "@alexkroman1/aai/tts";
import { isRecord, safeJsonParse } from "@alexkroman1/aai/utils";
// The repair's own type comes from the AI SDK, which is what a host assembling
// its own `streamText` call is holding anyway.
import type { ToolCallRepairFunction, ToolSet } from "ai";
import { createNanoEvents } from "nanoevents";

// The OPENER CONTRACT — the `Stt*`/`Tts*` shapes a stage of one's own is written
// against — sits beside the two register functions rather than on the authoring
// `/stt` and `/tts` subpaths, for the same reason they do: a HOST registers a
// kind and an agent author never does.
import {
  createToolCallRepair,
  type Logger,
  type OpenerRegistryEntry,
  registerSttKind,
  registerTtsKind,
  resolveLlm,
  type S2SConfig,
  type SttEvents,
  type SttOpener,
  type SttSession,
  salvageJson,
  type TtsEvents,
  type TtsOpener,
  type TtsSession,
} from "../../../runtime-barrel.ts";

/** The kinds a descriptor names to select these stages. */
export const TEXT_STT_KIND = "text-console-stt";
export const TEXT_TTS_KIND = "text-console-tts";

/**
 * The credential the runtime resolves before opening either stage.
 *
 * A registered kind is resolved like any other, so it needs an env var even
 * when the stage itself has nothing to authenticate against — the preflights
 * that check an agent's credentials before it starts read exactly this.
 */
export const TEXT_STAGE_API_KEY_ENV = "TEXT_CONSOLE_KEY";

/** One open text-driven STT stream: the host pushes turns in instead of audio. */
export type TextSttSession = SttSession & {
  /** Show a partial, as a caller typing would. */
  typing(text: string): void;
  /** Submit the turn — the cue the pipeline runs the LLM on. */
  submit(text: string): void;
};

/** One open text-collecting TTS stream, plus what the agent said into it. */
export type TextTtsSession = TtsSession & {
  readonly said: readonly string[];
};

/** The STT stage: a stream whose transcripts come from the host, not a network. */
export function createTextSttOpener(name: string): SttOpener & {
  last(): TextSttSession | undefined;
} {
  let last: TextSttSession | undefined;
  return {
    name,
    last: () => last,
    // `open` is handed the session's sample rate, the resolved key and an abort
    // signal; this stage needs none of them, and taking them as `_opts` is what
    // says so.
    open: async (_opts) => {
      const events = createNanoEvents<SttEvents>();
      const session: TextSttSession = {
        sendAudio() {
          // A text front door forwards no audio. A real client's PCM16 frames
          // would arrive here.
        },
        on: (event, fn) => events.on(event, fn),
        close: async () => undefined,
        typing: (text) => events.emit("partial", text),
        submit: (text) => events.emit("final", text),
      };
      last = session;
      return session;
    },
  };
}

/** The TTS stage: the reply is collected as text, and no audio is produced. */
export function createTextTtsOpener(name: string): TtsOpener & {
  last(): TextTtsSession | undefined;
} {
  let last: TextTtsSession | undefined;
  return {
    name,
    last: () => last,
    open: async (_opts) => {
      const events = createNanoEvents<TtsEvents>();
      const said: string[] = [];
      const session: TextTtsSession = {
        said,
        sendText: (text) => said.push(text),
        // `done` ends the turn, and forwarding NO audio is deliberate: the
        // pipeline estimates playback open-loop from the audio it forwarded, so
        // a stage that emitted silence would have the agent modelled as still
        // holding the floor and the next submitted turn would read as a
        // barge-in.
        flush: () => events.emit("done"),
        cancel: () => events.emit("done"),
        on: (event, fn) => events.on(event, fn),
        close: async () => undefined,
      };
      last = session;
      return session;
    },
  };
}

/**
 * The two registry entries.
 *
 * `open` is handed the DESCRIPTOR, whose `options` are a serializable record —
 * an agent config crossed a wire to get here, so a host reads its own options
 * back out with a narrowing rather than a type it wishes it had.
 */
export function textSttEntry(): OpenerRegistryEntry<SttOpener> {
  return {
    envVar: TEXT_STAGE_API_KEY_ENV,
    open: (descriptor) => createTextSttOpener(labelOf(descriptor.options, TEXT_STT_KIND)),
  };
}

export function textTtsEntry(): OpenerRegistryEntry<TtsOpener> {
  return {
    envVar: TEXT_STAGE_API_KEY_ENV,
    open: (descriptor) => createTextTtsOpener(labelOf(descriptor.options, TEXT_TTS_KIND)),
  };
}

function labelOf(options: Record<string, unknown>, fallback: string): string {
  const label = options.label;
  return typeof label === "string" ? label : fallback;
}

/**
 * Install both stages, and the descriptors + env that select them.
 *
 * Both register calls hand back an unregister, and calling them is not
 * optional: the registry is process-global and a session can outlive whatever
 * installed it, so a host that runs more than one of these at a time gives each
 * its own kind.
 */
export function installTextStages(suffix: string): {
  stt: SttProvider;
  tts: TtsProvider;
  env: Record<string, string>;
  release(): void;
} {
  const sttKind = `${TEXT_STT_KIND}-${suffix}`;
  const ttsKind = `${TEXT_TTS_KIND}-${suffix}`;
  const undoStt = registerSttKind(sttKind, textSttEntry());
  const undoTts = registerTtsKind(ttsKind, textTtsEntry());
  return {
    stt: { kind: sttKind, options: { label: sttKind } },
    tts: { kind: ttsKind, options: { label: ttsKind } },
    env: { [TEXT_STAGE_API_KEY_ENV]: "text-console" },
    release: () => {
      undoStt();
      undoTts();
    },
  };
}

/**
 * The repair to hand a `streamText` loop the host drives itself, bound to the
 * same model the agent's own descriptor names.
 *
 * `getAbortSignal` is what keeps a tier-2 repair from outliving its turn: the
 * second tier re-asks the model for the arguments, so without the in-flight
 * turn's signal a barge-in leaves a billed LLM call running for a turn that no
 * longer exists.
 */
export function repairForAgentModel(
  descriptor: LlmProvider,
  env: Record<string, string>,
  log: Logger,
  currentTurn: () => AbortSignal | undefined,
): ToolCallRepairFunction<ToolSet> {
  return createToolCallRepair(resolveLlm(descriptor, env), log, currentTurn);
}

/**
 * Tier 1 on its own, for a host that only wants the half that costs no tokens:
 * arguments that are nearly JSON — a fence around them, a raw newline inside a
 * string literal, an unclosed bracket — repaired without a round trip.
 *
 * `null` from `salvageJson` means "not repairable", and the caller's answer to
 * that is its own; here it is an empty argument record rather than a throw.
 */
export async function salvagedArgs(raw: string): Promise<Record<string, unknown>> {
  const repaired = await salvageJson(raw);
  if (repaired === null) return {};
  const parsed = safeJsonParse(repaired);
  return isRecord(parsed) ? parsed : {};
}

/**
 * Where this host's S2S sessions connect — handed to the runtime as its
 * `s2sConfig`.
 *
 * The rates are what a client is told to capture and play at. They are not a
 * free choice per transport: AssemblyAI's Voice Agent API accepts one rate in
 * both directions and honours no declaration, so the runtime pins that
 * transport itself. What a host really chooses here is the ENDPOINT — an
 * in-house relay, a regional deployment.
 */
export const relayS2sConfig: S2SConfig = {
  wssUrl: "wss://s2s-relay.internal.example/v1/ws",
  inputSampleRate: 24_000,
  outputSampleRate: 24_000,
};
