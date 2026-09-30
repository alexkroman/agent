// Copyright 2026 the AAI authors. MIT license.
/**
 * `agent({ clientInbox })` survives the config boundary — it is serializable,
 * and a deployed guest reads it off the config — and a rate no device plays is
 * refused there rather than synthesized.
 */

import { describe, expect, test } from "vitest";
import { AgentConfigSchema, toAgentConfig } from "./agent-config.ts";
import { agent } from "./define.ts";

describe("agent({ clientInbox })", () => {
  test("carries the sample rate through toAgentConfig", () => {
    const config = toAgentConfig(agent({ name: "Speaker", clientInbox: { sampleRate: 16_000 } }));
    expect(config.clientInbox).toEqual({ sampleRate: 16_000 });
  });

  test("is absent from the config of an agent that declares none", () => {
    expect(toAgentConfig(agent({ name: "Plain" }))).not.toHaveProperty("clientInbox");
  });

  test.each([4000, 96_000, 16_000.5])("refuses a rate of %d", (sampleRate) => {
    const parsed = AgentConfigSchema.safeParse({ name: "Speaker", clientInbox: { sampleRate } });
    expect(parsed.success).toBe(false);
  });
});
