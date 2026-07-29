import type { ToolContext } from "@alexkroman1/aai";
import { toAgentConfig } from "@alexkroman1/aai/manifest";
import { describe, expect, test } from "vitest";
import agentDef from "./agent.ts";

describe("slack-translator template", () => {
  test("config passes manifest validation", () => {
    // Same conversion `aai build`/`aai deploy` run. Text-only mode rejects
    // holdPhrase-style tuning (assertTextOnlyTuning), so this is what catches
    // a `tts: none()` config that pairs with an illegal knob.
    expect(() => toAgentConfig(agentDef)).not.toThrow();
  });

  test("is text-only pipeline mode", () => {
    // tts: none() still counts toward the all-or-none stt/llm/tts rule.
    expect(agentDef.stt?.kind).toBe("assemblyai");
    expect(agentDef.llm?.kind).toBe("assemblyai");
    expect(agentDef.tts?.kind).toBe("none");
  });

  test("declares Slack as the send channel", () => {
    // `send` is what makes the runtime register the host-side send_message
    // builtin — without it the agent has no way to reach Slack at all, and
    // the failure is a silently missing tool rather than an error.
    expect(agentDef.send?.kind).toBe("slack");
  });

  test("prepare_french_translation echoes both sides of the translation", async () => {
    const prepare = agentDef.tools?.prepare_french_translation;
    expect(prepare).toBeDefined();
    // The tool is a pure function of its args — no kv, no env, no ctx.send —
    // so an empty context is enough and a full stub would be noise.
    const result = await prepare?.execute(
      { original_text: "See you tomorrow", french_text: "À demain" },
      {} as ToolContext,
    );
    expect(result).toEqual({ original_text: "See you tomorrow", french_text: "À demain" });
  });
});
