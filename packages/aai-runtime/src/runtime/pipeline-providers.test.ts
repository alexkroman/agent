// Copyright 2026 the AAI authors. MIT license.
/**
 * The runtime's pipeline-provider resolver: eager for a voice agent (a missing
 * key fails at creation), deferred for a workflow app, memoized either way —
 * `null`, an S2S agent's answer, included.
 */

import { describe, expect, test } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  registerFakeProviders,
} from "../_pipeline-test-fakes.ts";
import { createPipelineProviderResolver } from "./pipeline-providers.ts";

function fakes() {
  return registerFakeProviders({
    stt: createFakeSttProvider(),
    tts: createFakeTtsProvider(),
    llm: createFakeLanguageModel({ script: [] }),
  });
}

describe("createPipelineProviderResolver", () => {
  test("a pipeline agent's providers resolve once, and every call answers the same", () => {
    const registered = fakes();
    const resolve = createPipelineProviderResolver({
      agent: {},
      effectiveProviders: { mode: "pipeline", ...registered },
      providerEnv: registered.env,
    });
    const first = resolve();
    expect(first?.stt.envVar).toBe("FAKE_STT_API_KEY");
    expect(first?.tts.envVar).toBe("FAKE_TTS_API_KEY");
    expect(resolve()).toBe(first);
  });

  test("a voice agent with a missing key fails at creation, not at first use", () => {
    const registered = fakes();
    expect(() =>
      createPipelineProviderResolver({
        agent: {},
        effectiveProviders: { mode: "pipeline", ...registered },
        providerEnv: {},
      }),
    ).toThrow(/missing API key/);
  });

  test("a workflow app defers the resolution until something asks", () => {
    const registered = fakes();
    const resolve = createPipelineProviderResolver({
      agent: { mode: "workflow-app" },
      effectiveProviders: { mode: "pipeline", ...registered },
      providerEnv: {},
    });
    expect(resolve).toThrow(/missing API key/);
  });

  test("an S2S agent, or a pipeline missing a stage, resolves to null", () => {
    const registered = fakes();
    const s2s = createPipelineProviderResolver({
      agent: {},
      effectiveProviders: { mode: "s2s", ...registered },
      providerEnv: registered.env,
    });
    expect(s2s()).toBeNull();
    const partial = createPipelineProviderResolver({
      agent: {},
      effectiveProviders: { mode: "pipeline", ...registered, tts: undefined },
      providerEnv: registered.env,
    });
    expect(partial()).toBeNull();
  });
});
