// Copyright 2026 the AAI authors. MIT license.
/**
 * `sayFailureOnClient` — a run that failed for good says so on the device
 * that asked for it, as a `workflow({ onFailure })` handler.
 *
 * A workflow that says its result on a speaker owes the speaker its failure,
 * or a failed run is silence. Every app that did this wrote the same hook per
 * workflow: resolve the device from the input, cut the error down with
 * `spokenErrorReason`, `stepSayOnClient` with the id `${runId}:failed` (so it
 * cannot be dropped as a repeat of the run's success notice) and
 * `data.failed: true` (so a screen can tell the two apart), under
 * `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`. This is that hook, declared once.
 *
 * It is a HANDLER rather than a context method because the engine, not the
 * body, decides a run failed — see `workflow-failure.ts`. The hook runs as the
 * journaled step `onFailure`, so it calls `stepSayOnClient` directly: it is
 * already inside a step. The success half is `ctx.sayOnClient`.
 */

import { spokenErrorReason } from "./spoken-error-reason.ts";
import {
  DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  type StepSayOnClientOptions,
  stepSayOnClient,
} from "./step-say-on-client.ts";
import type { WorkflowFailureHook } from "./workflow-failure.ts";

/**
 * Options for {@link sayFailureOnClient}.
 *
 * @typeParam I - The workflow's parsed input.
 * @public
 */
export type SayFailureOnClientOptions<I> = Pick<
  StepSayOnClientOptions,
  "event" | "sampleRate" | "voice" | "language" | "ackTimeoutMs" | "retryAfterMs"
> & {
  /**
   * The device to say it on, from the run's input — `undefined` (or `""`) says nothing,
   * for a run started without one (a page, not a speaker).
   */
  clientId: (input: I) => string | undefined;
  /**
   * What to say. `reason` is `spokenErrorReason(error)` — the first sentence,
   * credentials redacted, URLs out — which is what to put in a sentence a
   * person hears; `error` is there for a branch on its type.
   */
  text: (error: Error, input: I, reason: string) => string;
  /**
   * What the device reads beside the text. `failed: true` is set on top of it,
   * and `said` on top of that (by `stepSayOnClient`).
   */
  data?: Record<string, unknown> | ((input: I) => Record<string, unknown>) | undefined;
  /**
   * The hook step's attempt budget. Defaults to
   * `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`, an hour's outage.
   */
  maxAttempts?: number | undefined;
};

/**
 * A `workflow({ onFailure })` handler that says a failed run's reason on the
 * device its input names: delivery id `${runId}:failed`, `data.failed: true`,
 * the step's budget `DEFAULT_CLIENT_DELIVERY_ATTEMPTS`. A no-op when
 * `clientId` resolves `undefined` or `""`.
 *
 * **Write the input type as the type argument** (`sayFailureOnClient<Input>`):
 * tsc cannot infer it through `workflow({ … })`, whose own inference of the
 * schema is still open when this call is checked, so the callbacks would see
 * `unknown`.
 *
 * Also accepted as `deepResearchWorkflow({ onFailure })`
 * (`@alexkroman1/aai/experimental`), where it is handed to the engine the same
 * way.
 *
 * @example
 * ```ts
 * import { workflow } from "@alexkroman1/aai";
 * import { sayFailureOnClient } from "@alexkroman1/aai/step";
 * import { z } from "zod";
 *
 * declare function research(topic: string): Promise<string>;
 *
 * type DigestInput = { clientId?: string | undefined; topic: string };
 *
 * export const digest = workflow({
 *   input: z.object({ clientId: z.string().optional(), topic: z.string() }),
 *   run: async ({ topic }) => ({ summary: await research(topic) }),
 *   onFailure: sayFailureOnClient<DigestInput>({
 *     clientId: (input) => input.clientId,
 *     event: "research",
 *     text: (_err, input, reason) => `Sorry, the research on ${input.topic} didn't finish. ${reason}`,
 *     data: (input) => ({ topic: input.topic }),
 *   }),
 * });
 * ```
 *
 * @public
 */
export function sayFailureOnClient<I>(options: SayFailureOnClientOptions<I>): {
  run: WorkflowFailureHook<I>;
  maxAttempts: number;
} {
  const { clientId, text, data, maxAttempts, ...say } = options;
  return {
    maxAttempts: maxAttempts ?? DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
    run: async (error, { runId, input }) => {
      const client = clientId(input);
      // An empty id is no device either: a run started from a page carries `""`.
      if (!client) return;
      const extra = typeof data === "function" ? data(input) : data;
      await stepSayOnClient(client, {
        ...say,
        id: `${runId}:failed`,
        text: text(error, input, spokenErrorReason(error)),
        data: { ...extra, failed: true },
      });
    },
  };
}
