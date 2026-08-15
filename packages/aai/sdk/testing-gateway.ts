// Copyright 2026 the AAI authors. MIT license.
/**
 * A fake LLM gateway, for testing a `"use step"` function that calls one.
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

import { isRecord } from "./utils.ts";

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
   * error body, which is what `stepGenerate` (`@alexkroman1/aai/utils`)
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
  opts: StubGatewayOptions = {},
): StubGateway {
  const scripted = typeof replies === "string" ? [replies] : replies;
  const status = opts.status ?? 200;
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
        new Response(
          status === 200
            ? JSON.stringify({ choices: [{ message: { content } }] })
            : JSON.stringify({ error: { message: `stub gateway: HTTP ${status}` } }),
          { status, headers: { "Content-Type": "application/json", ...opts.headers } },
        ),
      );
    },
  };
}

/** The request body as an object, whatever the caller encoded it as. */
function decodeBody(body: RequestInit["body"]): Record<string, unknown> {
  if (typeof body !== "string") return {};
  const parsed: unknown = JSON.parse(body);
  return isRecord(parsed) ? parsed : {};
}

/** The chat messages the request carried, with anything malformed dropped. */
function readMessages(body: Record<string, unknown>): { role: string; content: string }[] {
  const messages = body.messages;
  if (!Array.isArray(messages)) return [];
  return messages.flatMap((message: unknown) => {
    if (typeof message !== "object" || message === null) return [];
    const { role, content } = message as { role?: unknown; content?: unknown };
    return typeof role === "string" && typeof content === "string" ? [{ role, content }] : [];
  });
}

/** The last message of `role` — the one a single-shot call carries. */
function contentOf(messages: readonly { role: string; content: string }[], role: string): string {
  return messages.findLast((message) => message.role === role)?.content ?? "";
}
