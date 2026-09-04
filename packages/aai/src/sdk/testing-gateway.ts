// Copyright 2026 the AAI authors. MIT license.
/**
 * A fake LLM gateway, for testing a step that calls one.
 *
 * `stepGenerate` is one `fetch` to an OpenAI-compatible endpoint, which makes it
 * trivially testable — and made every workflow template write the same fake:
 * record the call, answer `{choices:[{message:{content}}]}`, switch on a status.
 * Two of them had it verbatim, and each had also hand-rolled the reach into
 * `body.messages[n].content` that a spec needs to assert what the model was
 * ASKED, which is the part worth asserting and the part a bare `vi.fn()` makes
 * unreadable.
 *
 * Framework-agnostic like the rest of `sdk/testing.ts`: this returns a `fetch`
 * implementation rather than installing one, so it carries no test-runner
 * dependency and the spec stays in charge of the lifetime —
 * `vi.stubGlobal("fetch", gateway.fetch)`, undone by `unstubEnvs`/`restoreMocks`
 * or an explicit `vi.unstubAllGlobals()`.
 */

import type { StubStepAnswer, StubStepRequest } from "./_testing-step-fetch.ts";
import { isRecord } from "./is-record.ts";
import { omitUndefined } from "./omit-undefined.ts";
import { safeJsonParse } from "./safe-json-parse.ts";

/** One request a {@link StubGateway} answered. */
export interface StubGatewayCall {
  /** The endpoint the call went to, so a spec can assert the gateway URL. */
  url: string;
  /** The user message — what the step actually asked. */
  prompt: string;
  /** The system instruction, or `undefined` when the step sent none. */
  system: string | undefined;
  /** The whole decoded request body, for asserting model, temperature, … */
  body: Record<string, unknown>;
  /**
   * The request headers, lower-cased.
   *
   * Worth asserting rather than assuming: the gateway is OpenAI-compatible and
   * takes the key as a `Bearer`, where AssemblyAI's streaming sockets take it
   * raw — and getting that backwards is a 401 that reads like a wrong key.
   */
  headers: Record<string, string>;
}

/** Options for {@link stubGateway}. */
export interface StubGatewayOptions {
  /**
   * HTTP status to answer with. Defaults to 200. A non-2xx answers with an
   * error body, which is what `stepGenerate` (`@alexkroman1/aai/step`)
   * quotes back in its `StepGenerateError`.
   */
  status?: number;
  /** Extra response headers — `Retry-After` is the one specs reach for. */
  headers?: Record<string, string>;
}

/** A fake gateway: the `fetch` to install, and what it was asked. */
export interface StubGateway {
  /** Install with `vi.stubGlobal("fetch", gateway.fetch)`. */
  fetch: (url: string | URL | Request, init?: RequestInit) => Promise<Response>;
  /** Every request, in call order. */
  calls: StubGatewayCall[];
}

/**
 * Build a fake LLM gateway answering `replies` in order.
 *
 * The LAST reply repeats once the list runs out, so a spec names only the turns
 * it cares about — which is what makes this usable for a step whose model call
 * sits in a LOOP: a stub that says the same thing every turn can only ever drive
 * such a loop into its budget, and one that runs out mid-loop fails on the stub
 * rather than on the code.
 *
 * @param replies - Completion contents, in order. A bare string is one reply.
 *
 * @example
 * ```ts no-check
 * // `no-check`: the step under test is in another file, which is the point.
 * import { stubGateway } from "@alexkroman1/aai/testing";
 * import { expect, test, vi } from "vitest";
 * import { summarize } from "./workflows/digest.ts";
 *
 * test("summarize sends the article and returns the headline", async () => {
 *   const gateway = stubGateway(['{"headline":"Otters use tools"}']);
 *   vi.stubGlobal("fetch", gateway.fetch);
 *   vi.stubEnv("ASSEMBLYAI_API_KEY", "sk-test");
 *
 *   expect(await summarize("Otters use tools.")).toEqual({ headline: "Otters use tools" });
 *   expect(gateway.calls[0]?.prompt).toContain("Otters use tools.");
 * });
 * ```
 *
 * @public
 */
export function stubGateway(
  replies: string | readonly string[],
  options: StubGatewayOptions = {},
): StubGateway {
  const scripted = typeof replies === "string" ? [replies] : replies;
  const status = options.status ?? 200;
  const calls: StubGatewayCall[] = [];

  return {
    calls,
    fetch: (url, init = {}) => {
      const body = decodeBody(init.body);
      const messages = readMessages(body);
      calls.push({
        url: String(url),
        prompt: contentOf(messages, "user"),
        system: messages.some((message) => message.role === "system")
          ? contentOf(messages, "system")
          : undefined,
        body,
        headers: Object.fromEntries(new Headers(init.headers).entries()),
      });
      // The last reply repeats — see the doc above.
      const content = scripted.at(Math.min(calls.length - 1, scripted.length - 1)) ?? "";
      return Promise.resolve(
        new Response(JSON.stringify(completionBody(content, status)), {
          status,
          headers: { "Content-Type": "application/json", ...options.headers },
        }),
      );
    },
  };
}

/**
 * The path every OpenAI-compatible completion request ends in — what
 * `stepGenerate` dials, whatever base URL it was pointed at.
 *
 * The predicate is on the PATH and not on the host, and that is a correction
 * rather than a taste: template evals routing a model leg by URL had written
 * both `url.includes("/chat/completions")` and `url.includes("llm-gateway")`,
 * and the second is wrong for any caller passing `stepGenerate`'s own
 * `gatewayUrl` option at a host of their own — an OpenAI-compatible proxy, or a
 * local mock. This used to cite the EU endpoint as the example and that example
 * does not demonstrate the rule: `ASSEMBLYAI_LLM_GATEWAY_EU_URL` is
 * `https://llm-gateway.eu.assemblyai.com/v1`, which contains `llm-gateway` and
 * matches the host predicate fine. Both of AssemblyAI's own bases do, which is
 * exactly why two predicates could sit in the template evals for as long as they
 * did without either one failing.
 */
const COMPLETIONS_PATH = "/chat/completions";

/** A gateway answer for a `stepFetch`-published slot, plus what it was asked. */
export interface StubGatewayRoute {
  /**
   * Answers a completion request and `undefined` for anything else, so the
   * caller composes it: `?? { body: html }` for a flow that also fetches a
   * page, `?? someThrow()` for one where an unexpected request is a finding, or
   * straight into `stubTranscribe`'s `otherwise`.
   */
  route: (request: StubStepRequest) => StubStepAnswer | undefined;
  /** Every completion request this route answered, DECODED, in call order. */
  calls: StubGatewayCall[];
}

/**
 * A gateway reply for a step that goes through the PUBLISHED `stepFetch` slot
 * rather than the global `fetch`.
 *
 * {@link stubGateway} answers over `globalThis.fetch`, which is the wrong seam
 * whenever anything has published a `stepFetch`: publishing REPLACES, so a flow
 * that transcribes AND calls a model — or fetches a page and calls a model — can
 * install only one fake and has to route by URL inside it. Seven eval files did
 * exactly that, and each hand-typed the same two things:
 *
 * 1. **The envelope.** `{ body: { choices: [{ message: { content } }] } }`,
 *    written out six times in six spellings. It is a WIRE shape, so a typo in
 *    it does not fail — `stepGenerate` reads no content and reports an empty
 *    completion, i.e. the fake and the code under test disagree and the case
 *    blames the code.
 * 2. **The cursor.** `contents.at(Math.min(next, contents.length - 1))`,
 *    re-derived twice, because a model call inside a LOOP cannot know how many
 *    calls it will make: a script that repeats one line can only drive the loop
 *    into its budget, and one that runs out mid-loop fails on the script. The
 *    last reply repeats, which is {@link stubGateway}'s convention and now
 *    literally the same code.
 *
 * And it hands back DECODED calls — `prompt`, `system`, `body`, `headers` — which
 * is the half no hand-rolled version had. Reading what the model was ASKED off a
 * `StubStepRequest` means `String(call.body)`, i.e. the raw JSON of the whole
 * request; one eval asserted its prompts that way and was really asserting
 * against the serialized `model` and `temperature` too.
 *
 * ```ts no-check
 * // `no-check`: the step under test is in another file, which is the point.
 * import { stubGatewayRoute } from "@alexkroman1/aai/testing";
 * import { installStubStepFetch } from "@alexkroman1/aai/testing/vitest";
 *
 * const model = stubGatewayRoute(['{"verdict":"ship"}']);
 * installStubStepFetch((request) => model.route(request) ?? { body: PAGE_HTML });
 * // … run the workflow …
 * expect(model.calls[0]?.prompt).toContain("the brief");
 * ```
 *
 * @param replies - Completion contents, in order; the last repeats. A bare
 *   string is one reply.
 * @public
 */
export function stubGatewayRoute(
  replies: string | readonly string[],
  options: StubGatewayOptions = {},
): StubGatewayRoute {
  const scripted = typeof replies === "string" ? [replies] : replies;
  const status = options.status ?? 200;
  const calls: StubGatewayCall[] = [];
  return {
    calls,
    route: (request) => {
      if (!request.url.includes(COMPLETIONS_PATH)) return;
      calls.push(recordGatewayCall(request.url, request.body, request.headers));
      // The last reply repeats — see the doc above.
      const content = scripted.at(Math.min(calls.length - 1, scripted.length - 1)) ?? "";
      return {
        status,
        body: completionBody(content, status),
        ...omitUndefined({ headers: options.headers }),
      };
    },
  };
}

/**
 * The response body a gateway answers with, success or failure.
 *
 * Shared by both fakes so a spec that moves from one seam to the other cannot
 * find the envelope spelled differently — the same reason `toStepResponse` is
 * shared between `stubStepFetch` and `stubTranscribe`.
 */
function completionBody(content: string, status: number): unknown {
  return status === 200
    ? { choices: [{ message: { content } }] }
    : { error: { message: `stub gateway: HTTP ${status}` } };
}

/**
 * One recorded request, decoded the way {@link StubGatewayCall} promises.
 *
 * Shared for the same reason: `prompt` and `system` are what a spec asserts on,
 * and the reach into `body.messages[n].content` is exactly what a caller should
 * not be re-deriving.
 */
function recordGatewayCall(
  url: string,
  body: Uint8Array | string | undefined,
  headers: Record<string, string>,
): StubGatewayCall {
  const decoded = decodeBody(typeof body === "string" ? body : undefined);
  const messages = readMessages(decoded);
  return {
    url,
    prompt: contentOf(messages, "user"),
    system: messages.some((message) => message.role === "system")
      ? contentOf(messages, "system")
      : undefined,
    body: decoded,
    headers: Object.fromEntries(
      Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]),
    ),
  };
}

/**
 * The request body as an object, whatever the caller encoded it as.
 *
 * `safeJsonParse` rather than `JSON.parse`: this runs inside the fake the code
 * under test is dialling, so a throw here surfaces as a failure of that code
 * rather than of the request it made. A body this cannot read contributes no
 * `prompt` and no `system`, which is what the spec's assertion will say.
 */
function decodeBody(body: RequestInit["body"]): Record<string, unknown> {
  if (typeof body !== "string") return {};
  const parsed = safeJsonParse(body);
  return isRecord(parsed) ? parsed : {};
}

/** The chat messages the request carried, with anything malformed dropped. */
function readMessages(body: Record<string, unknown>): { role: string; content: string }[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    if (!isRecord(message)) return [];
    const { role, content } = message;
    return typeof role === "string" && typeof content === "string" ? [{ role, content }] : [];
  });
}

/** The last message of `role` — the one a single-shot call carries. */
function contentOf(messages: readonly { role: string; content: string }[], role: string): string {
  return messages.findLast((message) => message.role === role)?.content ?? "";
}
