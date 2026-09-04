// Copyright 2026 the AAI authors. MIT license.
/**
 * WHEN `createRuntime` resolves provider credentials, which is a different
 * question from which ones it needs (`providers/resolve.test.ts`) and from what
 * it does with them once resolved (`runtime-transport.test.ts`).
 *
 * The split runs between a voice agent, which must fail at construction so
 * `aai dev` reports a missing key at startup rather than at whatever moment
 * someone first speaks, and a WORKFLOW APP, which declines `/websocket`,
 * defaults telephony off, and so must never resolve the default pipeline
 * injected into it.
 */

import type { AgentDef } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createRuntime } from "./runtime.ts";

describe("createRuntime provider resolution", () => {
  /**
   * An agent declaring NO providers — the shape both workflow-app templates
   * ship, and the one `makeAgent` deliberately does not produce (it injects an
   * `s2s` descriptor, which resolves no LLM and so cannot reach this at all).
   */
  function providerless(over: Partial<AgentDef>): AgentDef {
    return { name: "desk", systemPrompt: "sp", greeting: "hi", maxSteps: 5, tools: {}, ...over };
  }

  test("a workflow app with no credential anywhere still builds", () => {
    // `page: "static"` declines /websocket and defaults telephony off, so the
    // injected default pipeline is never dialled — but resolving it eagerly
    // threw "AssemblyAI LLM: missing API key" and took the whole runtime with
    // it. Under `aai dev` that is a workflow app that cannot start; deployed,
    // it is a 500 on the workflow API of an app whose workflows are fine.
    expect(() =>
      createRuntime({ agent: providerless({ page: "static" }), env: {}, logger: makeLogger() }),
    ).not.toThrow();
  });

  test("a VOICE agent with no credential still fails at construction", () => {
    // The other half, and the reason this is a deferral rather than a skip: a
    // missing key must be reported when `aai dev` starts, not when someone
    // first speaks.
    expect(() => createRuntime({ agent: providerless({}), env: {}, logger: makeLogger() })).toThrow(
      /missing API key/,
    );
  });

  test("a workflow app resolves nothing until something asks for a transport", () => {
    // Deferred, not skipped — the difference matters for the one path that can
    // still open a session on a static agent (an embedder passing
    // `createRuntimeServer({ telephony: true })`), which must report the real
    // credential error rather than "no transport for session". That the thunk
    // still throws when finally called is
    // `runtime-transport.test.ts`'s "a pipelineProviders thunk that throws".
    const logger = makeLogger();
    createRuntime({ agent: providerless({ page: "static" }), env: {}, logger });
    // The runtime was built and reported ITSELF; only the credential-bearing
    // resolution was left undone. A workflow app's line is its own, and says
    // only what resolved — printing `mode: pipeline` plus three stages' settings
    // here would describe the very resolution this test asserts did not happen.
    expect(logger.info).toHaveBeenCalledWith(
      "Workflow app resolved",
      expect.objectContaining({ sessionState: expect.anything() }),
    );
  });
});
