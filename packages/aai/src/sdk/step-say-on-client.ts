// Copyright 2026 the AAI authors. MIT license.
/**
 * `stepSayOnClient` — say a sentence on a device: `stepSpeak` and
 * `stepNotifyClient` in one call, with the text travelling beside the audio.
 *
 * Every app that announces on a device wrote the same six lines per
 * announcement — synthesize at the device's rate, push the PCM with the text
 * as `data.said` so a screen or a log can show what was heard — and one app
 * carried eight copies, each re-importing the same sample-rate constant. This
 * is those lines once, plus the two things none of the copies did:
 *
 * - **The rate is the AGENT's.** `agent({ clientInbox: { sampleRate } })` is
 *   published by the host that serves the inbox (the slot below), so a call
 *   names a rate only to override the fleet's.
 * - **A retry does not re-synthesize.** The step's retries ARE the redelivery
 *   (a device unplugged for an hour is 120 attempts), and each attempt used to
 *   pay for the same speech again. The audio of an utterance that failed to
 *   deliver is held (a few, bounded) until it is delivered or fails for a
 *   reason other than the device being unreachable.
 *
 * It must still run INSIDE a step, and in ONE step: the audio never crosses the
 * journal (what a step returns is journaled, and a PCM buffer is not something
 * to replay), and the step's `maxAttempts` is the delivery budget —
 * {@link DEFAULT_CLIENT_DELIVERY_ATTEMPTS} rides out an hour's outage.
 */

import { omitUndefined } from "./omit-undefined.ts";
import {
  ClientUnreachableError,
  DEFAULT_CLIENT_RETRY_MS,
  stepNotifyClient,
} from "./step-notify-client.ts";
import { STEP_SPEAK_SAMPLE_RATE, stepSpeak } from "./step-speak.ts";

/**
 * A step `maxAttempts` that rides out an hour-long device outage: 120 attempts
 * at `stepNotifyClient`'s 30-second retry.
 *
 * @public
 */
export const DEFAULT_CLIENT_DELIVERY_ATTEMPTS: number = Math.ceil(
  (60 * 60 * 1000) / DEFAULT_CLIENT_RETRY_MS,
);

/**
 * Options for {@link stepSayOnClient}.
 *
 * @public
 */
export type StepSayOnClientOptions = {
  /**
   * Identifies the DELIVERY, so the device drops a repeat — the run id for a
   * run's one announcement, `${runId}:failed` for its failure. 1 to 128
   * characters.
   */
  id: string;
  /** What the device should do with it, e.g. `"reminder"`. */
  event: string;
  /** What to say. Also sent as `data.said`. */
  text: string;
  /**
   * Anything JSON-serializable the device reads alongside `event`. `said` is
   * set to `text` on top of it.
   */
  data?: Record<string, unknown> | undefined;
  /**
   * Samples per second to synthesize at. Defaults to the agent's
   * `clientInbox.sampleRate`, then to `stepSpeak`'s own default.
   */
  sampleRate?: number | undefined;
  /** Voice id, as `stepSpeak` takes it. */
  voice?: string | undefined;
  /** Spoken language, as `stepSpeak` takes it. */
  language?: string | undefined;
  /** How long to wait for the device's ack — see `stepNotifyClient`. */
  ackTimeoutMs?: number | undefined;
  /** When the step's next attempt runs after the device was unreachable. */
  retryAfterMs?: number | undefined;
  /** Abort the synthesis and the delivery. */
  signal?: AbortSignal | undefined;
};

/**
 * What the host publishes from `agent({ clientInbox })`.
 *
 * @internal
 */
export type ClientInboxDefaults = { sampleRate?: number | undefined };

const CLIENT_INBOX_SLOT = Symbol.for("@alexkroman1/aai.clientInboxDefaults");

type ClientInboxSlot = { [CLIENT_INBOX_SLOT]?: ClientInboxDefaults };

/**
 * Publish the agent's `clientInbox` defaults for this process's steps.
 * `undefined` unpublishes.
 *
 * Published beside the step env, by whatever serves the agent's workflows —
 * `createAgentServer` and `aai dev` — and for the same reason as every step
 * slot: the agent bundle and the host hold two copies of this module.
 *
 * @internal — a host concern. A step author calls {@link stepSayOnClient}.
 */
export function publishClientInboxDefaults(defaults: ClientInboxDefaults | undefined): void {
  if (defaults === undefined) delete (globalThis as ClientInboxSlot)[CLIENT_INBOX_SLOT];
  else (globalThis as ClientInboxSlot)[CLIENT_INBOX_SLOT] = Object.freeze({ ...defaults });
}

/** Undelivered utterances held across a step's retries, oldest evicted first. */
const MAX_HELD_UTTERANCES = 16;

/** Synthesized audio by utterance, held only while its delivery is being retried. */
const held = new Map<string, Uint8Array>();

function utteranceKey(text: string, sampleRate: number, voice?: string, language?: string) {
  // `\u0000`, never a raw NUL: a literal one makes the file binary to `git grep`.
  return [text, sampleRate, voice ?? "", language ?? ""].join("\u0000");
}

function hold(key: string, pcm: Uint8Array): void {
  held.delete(key);
  held.set(key, pcm);
  while (held.size > MAX_HELD_UTTERANCES) {
    const oldest = held.keys().next().value;
    if (oldest === undefined) break;
    held.delete(oldest);
  }
}

/**
 * Say `text` on the device connected to `WS /inbox` as `clientId`: synthesize
 * it, push the audio with `data.said = text`, and resolve with the text once
 * the device acks.
 *
 * Throws `ClientUnreachableError` (retryable) when the device is offline, busy
 * or slow to ack — call it from ONE step and let the step's retries redeliver;
 * `DEFAULT_CLIENT_DELIVERY_ATTEMPTS` as that step's `maxAttempts` rides out an
 * hour. A retry re-uses the audio it already synthesized.
 *
 * @example
 * ```ts
 * import type { WorkflowContext } from "@alexkroman1/aai";
 * import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS, stepSayOnClient } from "@alexkroman1/aai/step";
 *
 * export async function remindFlow(
 *   input: { clientId: string; text: string; dueAt: number },
 *   ctx: WorkflowContext,
 * ) {
 *   await ctx.sleep("due", new Date(input.dueAt));
 *   const { runId } = ctx;
 *   await ctx.step(
 *     "deliver",
 *     () =>
 *       stepSayOnClient(input.clientId, {
 *         id: runId,
 *         event: "reminder",
 *         text: `Reminder: ${input.text}`,
 *         data: { text: input.text },
 *       }),
 *     { maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS },
 *   );
 * }
 * ```
 *
 * @param clientId - The device's `?client=` id.
 * @param options - The notice (`id`, `event`, `text`, `data`) and how to speak it.
 * @returns The text that was said.
 * @public
 */
export async function stepSayOnClient(
  clientId: string,
  options: StepSayOnClientOptions,
): Promise<string> {
  const { text, voice, language, signal } = options;
  const sampleRate =
    options.sampleRate ??
    (globalThis as ClientInboxSlot)[CLIENT_INBOX_SLOT]?.sampleRate ??
    STEP_SPEAK_SAMPLE_RATE;
  const key = utteranceKey(text, sampleRate, voice, language);
  const pcm = held.get(key) ?? (await stepSpeak(text, { sampleRate, voice, language, signal })).pcm;
  try {
    await stepNotifyClient(
      clientId,
      { id: options.id, event: options.event, data: { ...options.data, said: text }, audio: pcm },
      omitUndefined({
        ackTimeoutMs: options.ackTimeoutMs,
        retryAfterMs: options.retryAfterMs,
        signal,
      }),
    );
  } catch (err: unknown) {
    // Held only for the retry that will come: an unreachable device. Any other
    // failure (a malformed id, no inbox at all) is fatal, so nothing will ask again.
    if (err instanceof ClientUnreachableError) hold(key, pcm);
    else held.delete(key);
    throw err;
  }
  held.delete(key);
  return text;
}
