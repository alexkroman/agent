// Copyright 2026 the AAI authors. MIT license.
// The VOICE half of this descriptor's checking: a voice id is never refused
// (the catalog is the service's and goes stale between releases), so a wrong
// one is warned about — and the warning has to reach the shape the docs lead
// with, `agent({ voice: "michael" })`.
//
// The `language` rules are exercised through `toAgentConfig` in
// `config-rules.test.ts`; what is here is what that file cannot see, since
// `agentConfigWarnings` reads the RAW `AgentDef` and the shorthand has no `tts`
// on it until `toAgentConfig` desugars one.

import { describe, expect, test, vi } from "vitest";
import type { AgentConfig } from "../../manifest-barrel.ts";
import { toAgentConfig } from "../../manifest-barrel.ts";
import { assemblyAITts, assemblyAIVoiceWarning } from "./assemblyai.ts";

function config(fields: Record<string, unknown>): AgentConfig {
  return toAgentConfig({ name: "x", systemPrompt: "p", ...fields } as never);
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

describe("toAgentConfig warns about the voice on EVERY authoring path", () => {
  test("the `agent({ voice })` shorthand — the shape the docs lead with", () => {
    // This is the case nothing checked: `agentConfigWarnings` runs on the raw
    // def, whose `tts` is undefined until the shorthand is desugared, so
    // `voice: "michal"` built clean, deployed, connected, reported ready and
    // never spoke.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config({ voice: "michal" });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('"michal"');
    expect(warn.mock.calls[0]?.[0]).toContain('Did you mean "michael"');
    warn.mockRestore();
  });

  test("with no `language` set, which is the common shape", () => {
    // The voice check used to sit behind the `language === undefined` early
    // return, so it ran for almost nobody — the server infers the language
    // from the voice, so hardly any config sets one.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config({ tts: assemblyAITts({ voice: "estele" }) });
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain('Did you mean "estelle"');
    warn.mockRestore();
  });

  test("once per sentence — a config is rebuilt per session, not per build", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config({ voice: "michalx" });
    config({ voice: "michalx" });
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  test("a WARNING and never a throw — a voice shipped after this release still runs", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    expect(() => config({ voice: "voice-shipped-last-week" })).not.toThrow();
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  test("says nothing about a listed voice", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    config({ voice: "michael" });
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  test("the language rules still THROW — only the voice check is a warning", () => {
    // The early return for the language half is unmoved: this is the
    // translation this SDK owns, so a code it cannot send is a refusal.
    expect(() => config({ tts: assemblyAITts({ language: "xx" } as never) })).toThrow(
      /unsupported language/,
    );
  });
});
