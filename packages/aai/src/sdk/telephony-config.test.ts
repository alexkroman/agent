// Copyright 2026 the AAI authors. MIT license.
/**
 * The carrier names are a WIRE vocabulary, so this file pins them.
 *
 * Every one of them is three things at once: the `?carrier=` value a carrier's
 * media stream arrives with, the string a stored agent config carries across
 * the serialization boundary, and the key `aai-runtime`'s `CARRIER_CODECS`
 * answers with. Renaming one is therefore not a refactor — it silently stops
 * matching configs that are already deployed — which is exactly the kind of
 * change a co-located test exists to make deliberate.
 *
 * The type-level half (`TELEPHONY_CARRIERS` and `TelephonyCarrier` describing
 * the same set, which `satisfies` alone cannot check) is pinned in
 * `define.test-d.ts`, beside the declaration those two types make possible.
 */

import { describe, expect, test } from "vitest";
import { AgentConfigSchema } from "./agent-config.ts";
import { TELEPHONY_CARRIERS } from "./telephony-config.ts";

describe("TELEPHONY_CARRIERS", () => {
  test("is the two shipped carriers, spelled as they arrive on the wire", () => {
    expect(TELEPHONY_CARRIERS).toEqual(["twilio", "telnyx"]);
  });

  test("is what the config schema validates a declaration against", () => {
    // The list crosses the serialization boundary, so the schema is what stops
    // a carrier this build ships no codec for from becoming a route that mounts
    // and answers nothing.
    for (const carrier of TELEPHONY_CARRIERS) {
      expect(AgentConfigSchema.safeParse({ name: "A", telephony: [carrier] }).success).toBe(true);
    }
    expect(AgentConfigSchema.safeParse({ name: "A", telephony: ["vonage"] }).success).toBe(false);
  });

  test.each([
    ["true, every carrier", true],
    ["false, none", false],
    ["an empty allow-list", []],
  ])("accepts %s", (_label, telephony) => {
    // `false` and `[]` are the same refusal — an allow-list admitting nothing —
    // and both are legal declarations rather than a shape the schema rejects.
    expect(AgentConfigSchema.safeParse({ name: "A", telephony }).success).toBe(true);
  });
});
