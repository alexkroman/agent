// Copyright 2026 the AAI authors. MIT license.
/**
 * `ctx.sayOnClient` — a workflow body's announcement on a device, as ONE
 * journaled step.
 *
 * Every app that said a run's result on a speaker wrote the same call at every
 * announcement: `ctx.step(name, () => stepSayOnClient(clientId, { id: runId, …
 * }), { maxAttempts: DEFAULT_CLIENT_DELIVERY_ATTEMPTS })`. One app carried eight.
 * The parts a copy gets wrong are the two defaults: the delivery `id` (the run
 * id, so a redelivery after a lost ack is a repeat the device drops) and the
 * step's attempt budget (the budget IS the redelivery — a device unplugged for
 * an hour is 120 attempts; the generic step default gives up in seconds).
 *
 * Composed ENTIRELY of `ctx.step`, so it has no journal shape of its own: a
 * `sayOnClient("announce", …)` journals `announce#0`, exactly as the
 * hand-written step did, and a run started under the hand-written step replays
 * under this. Every `WorkflowContext` (the replay engine's, the `/testing`
 * recorder, an eval's) implements it by calling {@link sayOnClientWorkflow}, as
 * they do `ctx.poll`.
 *
 * The failure half — a run that failed saying so — is `sayFailureOnClient` on
 * `@alexkroman1/aai/step`, which is a `workflow({ onFailure })` handler rather
 * than a context method because the engine, not the body, decides a run failed.
 */

import { DEFAULT_CLIENT_DELIVERY_ATTEMPTS, stepSayOnClient } from "./step-say-on-client.ts";
import type { StepOptions } from "./workflow-ctx-options.ts";

/**
 * What `ctx.sayOnClient` says: `stepSayOnClient`'s options (from
 * `@alexkroman1/aai/step`) with the delivery `id` optional — it defaults to the
 * run id — plus the step's `maxAttempts`.
 *
 * Spelled out rather than derived with `Omit`, so the root surface that
 * `WorkflowContext` lives on does not reach into `/step`'s types;
 * `workflow-say-on-client.test-d.ts` pins the two key sets together.
 *
 * @public
 */
export type SayOnClientNotice = {
  /**
   * Identifies the DELIVERY, so the device drops a repeat. Defaults to the run
   * id — right for a run's one announcement. A run that announces twice gives
   * the second its own (`${ctx.runId}:progress`), or the device drops it.
   */
  id?: string | undefined;
  /** What the device should do with it, e.g. `"reminder"`. */
  event: string;
  /** What to say. Also sent as `data.said`. */
  text: string;
  /** Anything JSON-serializable the device reads alongside `event`; `said` is set on top. */
  data?: Record<string, unknown> | undefined;
  /** Samples per second; defaults to the agent's `clientInbox.sampleRate`. */
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
  /**
   * The step's attempt budget, which is the redelivery budget. Defaults to
   * `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`, an hour at the 30-second retry.
   */
  maxAttempts?: number | undefined;
};

/**
 * The one context method an announcement is made of, with the NAME
 * unconstrained — the `PollHost` shape, for the same reason.
 *
 * @internal
 */
export type SayOnClientHost = {
  readonly runId: string;
  step<T>(name: string, fn: () => Promise<T> | T, options?: StepOptions): Promise<T>;
};

/**
 * Run one `ctx.sayOnClient` over `host`.
 *
 * @internal — reached by a host through `@alexkroman1/aai/host-internal`; an
 * author calls `ctx.sayOnClient`.
 */
export function sayOnClientWorkflow(
  host: SayOnClientHost,
  name: string,
  clientId: string,
  notice: SayOnClientNotice,
): Promise<string> {
  const { id = host.runId, maxAttempts = DEFAULT_CLIENT_DELIVERY_ATTEMPTS, ...say } = notice;
  return host.step(name, () => stepSayOnClient(clientId, { ...say, id }), { maxAttempts });
}
