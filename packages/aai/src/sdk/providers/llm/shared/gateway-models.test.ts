// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { ASSEMBLYAI_GATEWAY_MODELS, gatewayModelIds } from "./gateway-models.ts";

const entries = Object.entries(ASSEMBLYAI_GATEWAY_MODELS);

describe("ASSEMBLYAI_GATEWAY_MODELS", () => {
  test("gives every model a positive context window", () => {
    for (const [id, model] of entries) expect(model.context, id).toBeGreaterThan(0);
  });
});

describe("gatewayModelIds", () => {
  test("lists exactly the live models a voice agent can use — tools and streaming", () => {
    const usable = entries.filter(([, m]) => m.live && m.tools && m.stream).map(([id]) => id);
    expect(gatewayModelIds()).toEqual(usable);
    expect(usable.length).toBeGreaterThan(0);
  });

  test("narrows to the EU-served models when asked", () => {
    const eu = gatewayModelIds({ eu: true });
    for (const id of eu) {
      expect(ASSEMBLYAI_GATEWAY_MODELS[id].eu, id).toBe(true);
    }
    expect(eu.every((id) => gatewayModelIds().includes(id))).toBe(true);
    expect(gatewayModelIds({ eu: false })).toEqual(gatewayModelIds());
  });
});
