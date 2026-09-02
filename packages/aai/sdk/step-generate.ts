// Copyright 2026 the AAI authors. MIT license.
/**
 * One model call, from inside a step.
 *
 * `ctx.generate` is the SDK's answer for tool code, and a step cannot use it: a
 * workflow body is replayed and may hold nothing live, so a step is handed
 * no `ToolContext`. So every workflow that wanted a model hand-rolled the same
 * forty lines — the gateway URL, the bearer, the message array, the reasoning
 * setting, a deadline, the retryable/terminal split, and the "the gateway
 * answered 200 with an empty completion" case that only shows up in production.
 * Two templates had written it before this existed, and they had already
 * diverged on the last two.
 *
 * ## Why this is a `fetch` and not `ctx.generate`'s AI SDK client
 *
 * Everything a `workflows/*.ts` module names at module scope rides into the
 * agent bundle, which is built and shipped on every deploy. Pulling `ai` plus an
 * `@ai-sdk/*` provider in for one chat completion would be megabytes of it. The
 * AssemblyAI LLM Gateway is OpenAI-compatible, so one `fetch` covers it, and
 * this module stays dependency-free — the budget `@alexkroman1/aai/step` keeps
 * for every one of its exports, see `sdk/step-barrel.ts`'s own doc.
 *
 * The cost is that this is deliberately NOT `ctx.generate`: no tools, no
 * structured output, no provider choice beyond the gateway's own catalog. A step
 * that needs those should import the AI SDK itself and accept the bundle.
 *
 * ## The credential
 *
 * `ASSEMBLYAI_API_KEY` out of the agent env, via {@link stepEnv} — so a voice
 * agent's workflow authenticates with the same key its pipeline already uses and
 * needs no second secret. Under `aai dev` that means `.env`, not the shell; see
 * `sdk/step-env.ts` for why the parity rule is drawn there.
 */

import { omitUndefined } from "./omit-undefined.ts";
import {
  ASSEMBLYAI_LLM_API_KEY_ENV,
  ASSEMBLYAI_LLM_DEFAULT_MODEL,
  ASSEMBLYAI_LLM_GATEWAY_URL,
} from "./providers/llm/assemblyai.ts";
import { previewBody } from "./response-body.ts";
import { safeJsonParse } from "./safe-json-parse.ts";
import { requireStepEnv } from "./step-env.ts";
import { stepFetch } from "./step-fetch.ts";
import { isTransientStatus, retryAfter } from "./step-retry.ts";

/** A model call's deadline. `fetch` has none, and a hung step never ends. */
const DEFAULT_TIMEOUT_MS = 60_000;

/** Options for {@link stepGenerate}. */
export type StepGenerateOptions = {
  /**
   * The system instruction. Omitted entirely when unset, rather than sent
   * empty — an empty system message is a message the model still reads.
   */
  system?: string;
  /**
   * Gateway model id. Defaults to `ASSEMBLYAI_LLM_DEFAULT_MODEL`, the same one
   * an agent's own pipeline resolves, so a workflow and its agent do not
   * silently run on different models.
   */
  model?: string;
  /**
   * Env key holding the AssemblyAI API key. Defaults to `ASSEMBLYAI_API_KEY`
   * — the same name every AssemblyAI stage reads.
   */
  apiKeyEnv?: string;
  /** Gateway base URL, e.g. `ASSEMBLYAI_LLM_GATEWAY_EU_URL` for EU residency. */
  gatewayUrl?: string;
  /** Request deadline in milliseconds. Defaults to 60s. */
  timeoutMs?: number;
  /**
   * Sampling temperature, forwarded only when set. Left to the model's own
   * default otherwise, which is what an unset knob should mean.
   */
  temperature?: number;
  /** Cap on the reply, forwarded only when set. */
  maxTokens?: number;
};

/**
 * A model call that failed, with the one thing a step has to decide from.
 *
 * `retryable` is the whole point. The engine retries a step that throws
 * and a caller has to choose between letting it (a rate limit, a 5xx) and
 * refusing (a bad key, a rejected request) — and getting that backwards is
 * either five pointless attempts against a 401 or one attempt against a blip.
 *
 * It is a BOOLEAN on the error rather than a `FatalError` thrown for you,
 * because `FatalError` lives on `@alexkroman1/aai/step-errors` and reaching for
 * it is the caller's opt-in: whether a terminal failure should burn a step's
 * remaining attempts is not this module's call. The mapping is one line at
 * the call site:
 *
 * ```ts no-check
 * try {
 *   return await stepGenerate(prompt, { system });
 * } catch (err) {
 *   if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
 *   throw err;
 * }
 * ```
 *
 * @public
 */
export class StepGenerateError extends Error {
  /** The gateway's status, when there was a response at all. */
  readonly status: number | undefined;
  /** Will another attempt plausibly answer differently? */
  readonly retryable: boolean;
  /**
   * When the gateway asked to be called back, from its own `Retry-After`.
   *
   * Present on a rate limit that named a delay, and what a caller should hand
   * to `RetryableError` — the engine's default delay is a guess, and this is
   * the number the far side chose.
   */
  readonly retryAfter: Date | undefined;

  constructor(
    message: string,
    opts: {
      status?: number | undefined;
      retryable: boolean;
      retryAfter?: Date | undefined;
      cause?: unknown;
    },
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "StepGenerateError";
    this.status = opts.status;
    this.retryable = opts.retryable;
    this.retryAfter = opts.retryAfter;
  }
}

/**
 * Ask the AssemblyAI LLM Gateway one question and return its reply.
 *
 * **From a step, prefer `stepGenerateClassified` (`@alexkroman1/aai/step-errors`).**
 * It is this call plus `throwStepError`, and the engine decides its retry policy
 * from WHICH error a step throws: raw, a terminal failure burns every remaining
 * attempt and a rate limit backs off for one second while the delay the far side
 * named sits unread. Reach for the raw call where the failure is not simply a
 * failure — a `404` that means "already deleted".
 *
 * @example
 * ```ts
 * import { stepGenerate, StepGenerateError } from "@alexkroman1/aai/step";
 * import { FatalError } from "@alexkroman1/aai/step-errors";
 *
 * export async function summarize(text: string): Promise<string> {
 *   try {
 *     return await stepGenerate(text, { system: "Summarize in two sentences." });
 *   } catch (err) {
 *     if (err instanceof StepGenerateError && !err.retryable) throw new FatalError(err.message);
 *     throw err;
 *   }
 * }
 * ```
 *
 * @param prompt - The user message.
 * @returns The reply, trimmed. Never empty — a 200 carrying no content is a
 *   {@link StepGenerateError} with `retryable: true`, because it is a real and
 *   transient thing a gateway does and a step returning `""` would file a blank
 *   report and report success.
 * @throws {StepGenerateError} On EVERY failure of this call, which is the point
 *   of the class: a non-2xx, an empty completion, a reply that is not JSON, a
 *   request that never got an answer (a reset, a DNS failure, this call's own
 *   deadline), and a missing API key. Only the last is `retryable: false` —
 *   three more attempts find the same gap.
 * @public
 */
export async function stepGenerate(
  prompt: string,
  opts: StepGenerateOptions = {},
): Promise<string> {
  const base = opts.gatewayUrl ?? ASSEMBLYAI_LLM_GATEWAY_URL;
  // `stepFetch`, not `fetch`: this is a step's outbound call like any other, and
  // a fan-out that calls the model once per item is exactly the shape HTTP/2
  // multiplexing punishes. It also turns a connection failure into a
  // `StepTransportError` naming its cause, where `fetch` raises
  // `TypeError: fetch failed` — indistinguishable from a bad gateway URL. See
  // `sdk/step-fetch.ts`.
  const response = await gatewayFetch(`${base}/chat/completions`, {
    method: "POST",
    headers: {
      // The gateway is OpenAI-compatible, so the key is a BEARER here — unlike
      // AssemblyAI's streaming sockets, which take it raw. Getting this wrong is
      // a 401 that reads like a wrong key.
      Authorization: `Bearer ${apiKey(opts.apiKeyEnv ?? ASSEMBLYAI_LLM_API_KEY_ENV)}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      model: opts.model ?? ASSEMBLYAI_LLM_DEFAULT_MODEL,
      messages: [
        // An ARRAY, so `omitUndefined` does not apply: an empty system message
        // is a message the model still reads, so an unset one is dropped rather
        // than sent blank.
        ...(opts.system === undefined ? [] : [{ role: "system", content: opts.system }]),
        { role: "user", content: prompt },
      ],
      // The same setting the shipped voice pipeline sends, and for the same
      // measured reason: on a hybrid-thinking model, reasoning roughly doubles
      // time to first token for no gain on work shaped like this. See
      // `packages/aai/CLAUDE.md`'s `assemblyAILlm` rows.
      reasoning_effort: "none",
      // `omitUndefined` rather than two spread-ternaries: an unset knob must be
      // ABSENT from the body, not present as `undefined`, and this is the one
      // spelling of that (`guard-invariants.mjs` rule 2).
      ...omitUndefined({ temperature: opts.temperature, max_tokens: opts.maxTokens }),
    }),
    signal: AbortSignal.timeout(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS),
  });
  if (!response.ok) throw await gatewayFailure(response);

  const body = await gatewayCompletion(response);
  const content = body.choices?.[0]?.message?.content?.trim();
  if (!content) {
    throw new StepGenerateError("The gateway returned an empty completion.", {
      status: response.status,
      retryable: true,
    });
  }
  return content;
}

/**
 * {@link stepFetch}, with its transport failure re-reported as this module's
 * own error class.
 *
 * **The deadline this function sets is the reason.** `stepFetch` catches
 * everything the request throws — including our own `AbortSignal.timeout` — and
 * rethrows a `StepTransportError`, so `stepGenerate`'s single most advertised
 * failure mode escaped as a class the documented `catch` does not recognise:
 * `err instanceof StepGenerateError && !err.retryable` is what two templates
 * copy verbatim, and `toStepError` classifies anything else by falling through
 * to "no verdict available". A timeout has a verdict — the far side was slow,
 * not wrong — so it is `retryable: true`, and the transport error stays as the
 * `cause` because its message carries the whole code chain (`ECONNRESET`,
 * `UND_ERR_SOCKET`, `TimeoutError`) that identifies which failure it was.
 */
async function gatewayFetch(url: string, init: Parameters<typeof stepFetch>[1]): Promise<Response> {
  try {
    return await stepFetch(url, init);
  } catch (err: unknown) {
    throw new StepGenerateError(
      `LLM gateway request failed: ${err instanceof Error ? err.message : String(err)}`,
      { retryable: true, cause: err },
    );
  }
}

/**
 * The completion envelope, or this module's error rather than a bare
 * `SyntaxError`.
 *
 * A 200 does not promise JSON: a proxy, a CDN or a saturated gateway answers
 * HTML with any status it likes, and `response.json()` rejects with a
 * `SyntaxError` naming neither the gateway nor the status. Retryable, on the
 * same reasoning as an empty completion — it is a real and transient thing an
 * intermediary does.
 */
async function gatewayCompletion(
  response: Response,
): Promise<{ choices?: { message?: { content?: string } }[] }> {
  const text = await response.text().catch(() => "");
  const parsed = safeJsonParse(text);
  if (parsed === undefined) {
    throw new StepGenerateError(`The gateway's reply was not JSON: ${previewBody(text)}`, {
      status: response.status,
      retryable: true,
    });
  }
  return parsed as { choices?: { message?: { content?: string } }[] };
}

/** The key, or the one failure a retry cannot fix. */
function apiKey(name: string): string {
  try {
    return requireStepEnv(name);
  } catch (err: unknown) {
    throw new StepGenerateError(err instanceof Error ? err.message : String(err), {
      retryable: false,
      cause: err,
    });
  }
}

/**
 * The gateway's failure, with whatever it said about it.
 *
 * The split every retrying caller has to make: a 401 or a 400 answers the same
 * way on the fourth attempt, while a rate limit or a 5xx is exactly what retries
 * are for. A 408 counts as transient — it is the far side saying "too slow",
 * not "no".
 */
async function gatewayFailure(response: Response): Promise<StepGenerateError> {
  const body = previewBody(await response.text().catch(() => ""));
  const status = response.status;
  return new StepGenerateError(`LLM gateway failed: HTTP ${status}${body ? ` — ${body}` : ""}`, {
    status,
    retryable: isTransientStatus(status),
    // `omitUndefined` because the field is optional under
    // `exactOptionalPropertyTypes` and most failures name no delay.
    ...omitUndefined({ retryAfter: retryAfter(response) }),
  });
}
