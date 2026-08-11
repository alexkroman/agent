// Copyright 2026 the AAI authors. MIT license.
/**
 * A `page: "static"` runtime and its providers.
 *
 * Its own file rather than another describe in `runtime.test.ts`, which is at the
 * 700-line test cap. The seam is coherent on its own anyway: every spec here is
 * about the ONE case where a missing provider credential is not a build failure,
 * and about the two ways that must not over-reach — a voice agent still failing
 * loudly, and a static agent that really can serve a session still getting a
 * transport.
 */

import { describe, expect, test, vi } from "vitest";
import { createRuntime } from "./runtime.ts";

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

const staticAgent = {
  name: "Transcription Desk",
  systemPrompt: "x",
  greeting: "",
  maxSteps: 1,
  tools: {},
  page: "static" as const,
};

const PROVIDER_KEYS = { ASSEMBLYAI_API_KEY: "k" };

describe("createRuntime — a STATIC page and its providers", () => {
  test("builds with NO provider credentials at all", () => {
    // The papercut this closes: a static app declares no providers, so
    // `defaultProviders` filled the AssemblyAI pipeline and resolving it demanded
    // a key the app never uses — which failed the whole runtime, and for a
    // workflow app the runtime IS the front door. Reverting the tolerance throws
    // "AssemblyAI LLM: missing API key" here.
    expect(() =>
      createRuntime({ agent: staticAgent, env: {}, logger: makeLogger() }),
    ).not.toThrow();
  });

  test("says so at debug rather than warning on every boot", () => {
    // A static app having no session transport is its NORMAL state, so it must
    // not look like a misconfiguration in the log — but it must be findable when
    // someone asks why `/phone` is silent.
    const logger = makeLogger();
    createRuntime({ agent: staticAgent, env: {}, logger });
    expect(logger.warn).not.toHaveBeenCalled();
    expect(logger.debug).toHaveBeenCalledWith(expect.stringContaining("no session transport"));
  });

  test("a VOICE agent still needs them — the gate is the page, not the absence", () => {
    // The mirror image, so the fix cannot be read as "credentials are optional":
    // an agent that really does serve sessions must fail loudly at BUILD, which
    // is what makes a missing key a deploy-time failure instead of a first-call
    // one.
    expect(() =>
      createRuntime({
        agent: { ...staticAgent, page: "voice" as const },
        env: {},
        logger: makeLogger(),
      }),
    ).toThrow(/missing API key/);
  });

  test("STILL resolves a transport when the credentials are present", () => {
    // The reason this tolerates a failure instead of skipping the resolve.
    // `page: "static"` is not a promise that no session can begin — `createServer`
    // reads it as the DEFAULT for telephony and not a veto, so an explicit
    // `telephony: true` still routes `/phone`. Skipping left that combination
    // with no providers and failed the call inside `buildTransport`; a session
    // this runtime can serve must still get one.
    const logger = makeLogger();
    createRuntime({ agent: staticAgent, env: PROVIDER_KEYS, logger });
    // Resolution succeeding is observable as the ABSENCE of the degradation
    // notice — the same line the no-credentials spec above asserts is present.
    expect(logger.debug).not.toHaveBeenCalledWith(expect.stringContaining("no session transport"));
    expect(logger.info).toHaveBeenCalledWith(
      "Session mode resolved",
      expect.objectContaining({ mode: "pipeline" }),
    );
  });
});
