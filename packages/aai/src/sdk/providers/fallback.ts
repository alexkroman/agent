// Copyright 2026 the AAI authors. MIT license.
/**
 * `fallback([primary, secondary, …])` — provider failover as a DESCRIPTOR.
 *
 * Without it a provider outage is spoken aloud (`errorPhrase`) and the turn
 * ends. With it the host tries the next descriptor in the list instead, and
 * reports each switch as a `provider.failedOver` session event.
 *
 * Pure data like every other descriptor: `{ kind: "fallback", options: {
 * providers } }`, so it crosses the CLI → server → guest boundary unchanged
 * and the host resolver (`aai-runtime`'s `providers/fallback.ts`) decides what
 * failing over MEANS. That definition is on {@link fallback}'s doc, because an
 * author needs it to decide whether a fallback helps.
 *
 * @module
 */

import { isRecord } from "../is-record.ts";
import type { LlmProvider, SttProvider, TtsProvider } from "../providers.ts";

/** The `kind` of a fallback descriptor, reserved at every stage. */
export const FALLBACK_KIND = "fallback" as const;

/**
 * Try `providers` in order, failing over to the next when one cannot serve.
 *
 * ```ts
 * import { agent } from "@alexkroman1/aai";
 * import { llm } from "@alexkroman1/aai/llm";
 * import { assemblyAIStt, deepgramStt, fallback } from "@alexkroman1/aai/stt";
 *
 * export default agent({
 *   name: "Support",
 *   systemPrompt: "You are a support agent. Be brief.",
 *   stt: fallback([assemblyAIStt(), deepgramStt()]),
 *   llm: fallback([
 *     llm({ provider: "assemblyai", model: "gpt-5.6-luna" }),
 *     llm({ provider: "anthropic", model: "claude-sonnet-5" }),
 *   ]),
 * });
 * ```
 *
 * **When it fails over** — only before the stage has produced anything, so a
 * caller never hears half an answer from one vendor and the rest from another:
 *
 * - **STT / TTS**: the connection fails to open (connect, auth, a refused
 *   handshake), or the open session reports an error before its first output
 *   (a transcript for STT, audio for TTS). Text sent to a TTS member that
 *   failed before speaking is replayed into the next one.
 * - **LLM**: a request throws (network, any HTTP error status), or its stream
 *   errors before the first content part. Once text or a tool call has
 *   streamed, an error is the turn's, as it is without a fallback.
 * - **Never** on an abort (a barge-in, a session ending).
 *
 * The failed member is skipped for the rest of that session (STT/TTS) or that
 * request (LLM); the next request tries the primary again. When every member
 * fails, the LAST error is the stage's, exactly as a lone provider's would be.
 *
 * **Every member's key is required.** The credential preflight (`aai dev`,
 * deploy) demands each one, because a fallback whose secondary has no key fails
 * at the moment it is needed.
 *
 * The list is typed as two or more: a fallback of one member is not a fallback.
 * Members are flattened, so a fallback inside a fallback is one list. Each
 * member keeps its own options; the descriptors must all be the same stage.
 *
 * @public
 */
export function fallback(
  providers: readonly [SttProvider, SttProvider, ...SttProvider[]],
): SttProvider;
export function fallback(
  providers: readonly [LlmProvider, LlmProvider, ...LlmProvider[]],
): LlmProvider;
export function fallback(
  providers: readonly [TtsProvider, TtsProvider, ...TtsProvider[]],
): TtsProvider;
export function fallback(
  providers: readonly (SttProvider | LlmProvider | TtsProvider)[],
): SttProvider | LlmProvider | TtsProvider {
  const members = providers.flatMap((p) =>
    isFallbackDescriptor(p) ? fallbackMembers(p) : [{ kind: p.kind, options: { ...p.options } }],
  );
  if (members.length < 2) {
    throw new TypeError("fallback(): needs at least two providers to fail over between.");
  }
  // The primary's `model` rides on the fallback too: an LLM descriptor's
  // readers (the settings log, the context budget, the model cache) read
  // `options.model`, and the primary is the model a healthy session runs on.
  const model = members[0]?.options.model;
  return {
    kind: FALLBACK_KIND,
    options: typeof model === "string" ? { model, providers: members } : { providers: members },
  };
}

/** Is `descriptor` a {@link fallback}? */
export function isFallbackDescriptor(descriptor: unknown): boolean {
  return isRecord(descriptor) && descriptor.kind === FALLBACK_KIND;
}

/**
 * A fallback descriptor's members, in order — each a `{ kind, options }`.
 *
 * Read off a config that crossed a wire, so it is a guard rather than a cast:
 * an entry that is not a descriptor is dropped, and the resolver reports a
 * fallback left with fewer than two members by name.
 */
export function fallbackMembers(
  descriptor: unknown,
): { kind: string; options: Record<string, unknown> }[] {
  if (!(isRecord(descriptor) && isRecord(descriptor.options))) return [];
  const list = descriptor.options.providers;
  if (!Array.isArray(list)) return [];
  return list.flatMap((entry: unknown) =>
    isRecord(entry) && typeof entry.kind === "string" && isRecord(entry.options)
      ? [{ kind: entry.kind, options: entry.options }]
      : [],
  );
}
