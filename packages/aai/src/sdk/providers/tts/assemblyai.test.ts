// Copyright 2026 the AAI authors. MIT license.
// The VOICE half of this descriptor's checking: a voice id is never refused
// (the catalog is the service's and goes stale between releases), so a wrong
// one is warned about — ONCE, off the descriptor, by `agentConfigWarnings`.
// A voice has one spelling (the descriptor's option), so the raw `AgentDef`
// the CLI hands that function already carries it.
//
// The `language` rules are exercised through `toAgentConfig` in
// `config-rules.test.ts`.

import { describe, expect, test, vi } from "vitest";
import { agent } from "../../define.ts";
import type { AgentConfig } from "../../manifest-barrel.ts";
import { agentConfigWarnings, toAgentConfig } from "../../manifest-barrel.ts";
import type { TtsProvider } from "../../providers.ts";
import { assemblyAITts, assemblyAIVoiceWarning } from "./assemblyai.ts";

/** Build a config the way an AUTHOR does — through `agent()`. */
function configTts(tts: TtsProvider): AgentConfig {
  return toAgentConfig(agent({ name: "x", systemPrompt: "p", tts }));
}

/** The warnings `aai build` / `aai dev` print for an agent with this stage. */
function warningsFor(tts: TtsProvider): string[] {
  return agentConfigWarnings(agent({ name: "x", systemPrompt: "p", tts }));
}

describe("assemblyAIVoiceWarning", () => {
  test("names the catalog voices a typo is closest to", () => {
    // The reader of this line has 40-odd names to search and the one they
    // meant is one character away. "Look it up" is the version that costs an
    // afternoon.
    const warning = assemblyAIVoiceWarning(assemblyAITts({ voice: "michal" }));
    expect(warning).toContain('"michal" is not in this release\'s catalog');
    expect(warning).toContain('Did you mean "michael"');
  });

  test("suggests nothing when nothing is close, rather than the nearest name", () => {
    // Past the bound the "nearest" catalog entry is a different voice, and
    // offering it would be worse than the honest "check the catalog".
    const warning = assemblyAIVoiceWarning(assemblyAITts({ voice: "voice-shipped-last-week" }));
    expect(warning).toContain("not in this release's catalog");
    expect(warning).not.toContain("Did you mean");
  });

  test("a DEPRECATED voice gets its own sentence and no correction", () => {
    // It works today, so "not in the catalog" would be wrong, and there is
    // nothing to have meant instead.
    const warning = assemblyAIVoiceWarning(assemblyAITts({ voice: "emma" }));
    expect(warning).toContain("scheduled for removal");
    expect(warning).not.toContain("Did you mean");
  });

  test("says nothing about a listed voice, or a stage it does not own", () => {
    expect(assemblyAIVoiceWarning(assemblyAITts({ voice: "michael" }))).toBeUndefined();
    expect(assemblyAIVoiceWarning(assemblyAITts())).toBeUndefined();
    expect(assemblyAIVoiceWarning({ kind: "cartesia", options: { voice: "x" } })).toBeUndefined();
  });
});

describe("the voice warning is computed once, off the descriptor", () => {
  test("agentConfigWarnings carries it for an author-written descriptor", () => {
    const voiceLines = warningsFor(assemblyAITts({ voice: "michal" })).filter((line) =>
      line.includes('"michal"'),
    );
    expect(voiceLines).toHaveLength(1);
    expect(voiceLines[0]).toContain('Did you mean "michael"');
  });

  test("with no `language` set, which is the common shape", () => {
    const lines = warningsFor(assemblyAITts({ voice: "estele" }));
    expect(lines.some((line) => line.includes('Did you mean "estelle"'))).toBe(true);
  });

  test("toAgentConfig prints nothing — the CLI's warning list is the one channel", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    configTts(assemblyAITts({ voice: "michal" }));
    expect(warn).not.toHaveBeenCalled();
  });

  test("a WARNING and never a throw — a voice shipped after this release still runs", () => {
    expect(() => configTts(assemblyAITts({ voice: "voice-shipped-last-week" }))).not.toThrow();
    expect(warningsFor(assemblyAITts({ voice: "voice-shipped-last-week" })).length).toBeGreaterThan(
      0,
    );
  });

  test("says nothing about a listed voice", () => {
    expect(warningsFor(assemblyAITts({ voice: "michael" })).some((l) => l.includes("voice"))).toBe(
      false,
    );
  });

  test("the language rules still THROW — only the voice check is a warning", () => {
    // The early return for the language half is unmoved: this is the
    // translation this SDK owns, so a code it cannot send is a refusal.
    expect(() => configTts(assemblyAITts({ language: "xx" as never }))).toThrow(
      /unsupported language/,
    );
  });
});
