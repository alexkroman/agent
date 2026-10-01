// Copyright 2026 the AAI authors. MIT license.
/**
 * Local-model STT factory — returns a pure descriptor.
 *
 * Points the pipeline's STT stage at a speech model served on your own
 * machine (or your own network) instead of a vendor's cloud. The host opener
 * speaks a small WebSocket protocol, documented on {@link localStt}, which a
 * model server implements; the model itself decides when the user's turn is
 * over, so it suits the end-of-turn-token ASR models (a transcript followed
 * by a special marker when the speaker has finished) as well as plain ones
 * paired with a server-side silence rule.
 *
 * Exported from `@alexkroman1/aai/experimental` only: it is new, unmeasured,
 * and useful for `aai dev` and self-hosted runs, where the host can reach the
 * model server — never on the managed platform, whose hosts cannot.
 */

import { omitUndefined } from "../../omit-undefined.ts";
import type { ProviderCredentialOptions, SttProvider } from "../../providers.ts";
import { defineProvider, describeProvider } from "../define-provider.ts";

/** This vendor's registration (see `define-provider.ts`); the constants below derive from it. */
export const LOCAL_STT_PROVIDER = defineProvider({
  kind: "local",
  stage: "stt",
  envVar: "",
  label: "Local model",
  factory: "localStt",
  subpath: "experimental",
});

/** Kind tag recognised by the host-side resolver. */
export const LOCAL_STT_KIND = LOCAL_STT_PROVIDER.kind;

/** Where the host looks for the model server when the descriptor names none. */
export const LOCAL_STT_DEFAULT_URL = "ws://127.0.0.1:8765";

/**
 * How long the server holds a turn-ending decision before committing it, when
 * the descriptor names none. For an end-of-turn-token model this is how long
 * the marker must PERSIST: measured on 98 labelled tau2 caller turns, ending on
 * the first decode that emitted it cut 61% of turns early (the model fires on
 * every breath between two complete sentences), and an 800 ms hold cut that to
 * 7% for a median 1.2 s response after the caller stops.
 */
export const LOCAL_STT_DEFAULT_MIN_TURN_SILENCE_MS = 800;

/**
 * Trailing silence after which the server ends the turn whatever the model
 * says — the content-blind ceiling, so a model that never fires cannot leave a
 * caller waiting forever.
 */
export const LOCAL_STT_DEFAULT_MAX_TURN_SILENCE_MS = 2000;

/**
 * Options for {@link localStt}. `apiKeyEnv` (from
 * {@link ProviderCredentialOptions}) names an env var holding a bearer token,
 * sent as `Authorization: Bearer …`; unset sends none — a server on loopback
 * normally needs no credential, so unlike every cloud stage there is no
 * default variable.
 */
export interface LocalSttOptions extends ProviderCredentialOptions {
  /**
   * The model server's WebSocket URL. Defaults to
   * {@link LOCAL_STT_DEFAULT_URL} (`ws://127.0.0.1:8765`).
   */
  url?: string;
  /**
   * How long, in ms, the server holds an end-of-turn decision before
   * committing it. Defaults to {@link LOCAL_STT_DEFAULT_MIN_TURN_SILENCE_MS}.
   * The endpointing rule table moves it mid-call, as it moves AssemblyAI's.
   */
  minTurnSilenceMs?: number;
  /**
   * Trailing silence, in ms, after which the turn ends even if the model has
   * not said so. Defaults to {@link LOCAL_STT_DEFAULT_MAX_TURN_SILENCE_MS}.
   */
  maxTurnSilenceMs?: number;
  /** Spoken language, as the model server names it (e.g. `"English"`). */
  language?: string;
}

/**
 * Build a local-model STT descriptor.
 *
 * EXPERIMENTAL. The host opens `url` and speaks this protocol:
 *
 * - **client → server**, first frame, JSON:
 *   `{"type":"config","sample_rate":16000,"min_turn_silence_ms":800,"max_turn_silence_ms":2000,"language":"English","prompt":"…"}`
 *   (`language` and `prompt` only when set; `prompt` is the agent's `sttPrompt`).
 * - **client → server**, then: binary PCM16 mono frames at `sample_rate`;
 *   `{"type":"update","min_turn_silence_ms":N}` when the endpointing rules
 *   move the window; `{"type":"force_endpoint"}` to end the turn now.
 * - **server → client**, JSON: `{"type":"partial","text":"…"}` while the user
 *   speaks, `{"type":"final","text":"…","end_of_turn_confidence":1}` once per
 *   turn when it ends, `{"type":"error","message":"…"}` on a failure.
 *
 * A `final` IS the end of the turn — the server owns endpointing.
 *
 * @example
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { localStt } from "@alexkroman1/aai/experimental";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   stt: localStt({ url: "ws://127.0.0.1:8765" }),
 * });
 * ```
 */
export function localStt(options: LocalSttOptions = {}): SttProvider {
  return describeProvider(LOCAL_STT_PROVIDER, options);
}

/**
 * The settings this stage will actually run with — the descriptor's own
 * options with every host-side default filled in. Shared by the opener and
 * the runtime's "Session mode resolved" log.
 */
export function resolveLocalSttSettings(options: LocalSttOptions): {
  url: string;
  minTurnSilenceMs: number;
  maxTurnSilenceMs: number;
  language?: string;
} {
  return {
    url: options.url ?? LOCAL_STT_DEFAULT_URL,
    minTurnSilenceMs: options.minTurnSilenceMs ?? LOCAL_STT_DEFAULT_MIN_TURN_SILENCE_MS,
    maxTurnSilenceMs: options.maxTurnSilenceMs ?? LOCAL_STT_DEFAULT_MAX_TURN_SILENCE_MS,
    ...omitUndefined({ language: options.language }),
  };
}
