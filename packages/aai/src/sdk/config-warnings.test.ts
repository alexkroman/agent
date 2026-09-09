// Copyright 2026 the AAI authors. MIT license.
// The THIRD option this config layer has: a line that is neither an error nor
// silence. Every case here is a config that is legal and would otherwise ship
// with a failure nobody can see before a live call — a voice that mutes the
// agent, or audio leaving a region the author declared. So what the file claims
// is the boundary in both directions: what is warned about, and what is
// deliberately not.

import { describe, expect, test } from "vitest";
import { agentConfigWarnings } from "./config-warnings.ts";
import {
  ASSEMBLYAI_TTS_DEFAULT_VOICE,
  ASSEMBLYAI_TTS_HOST,
  assemblyAITts,
} from "./providers/tts/assemblyai.ts";
import { CARTESIA_DEFAULT_VOICE, cartesiaTts } from "./providers/tts/cartesia.ts";
import { RIME_DEFAULT_VOICE, rimeTts } from "./providers/tts/rime.ts";

/** A descriptor written by hand, for the shapes a factory would not produce. */
function descriptor(kind: string, options: Record<string, unknown>): unknown {
  return { kind, options };
}

describe("agentConfigWarnings", () => {
  test("a config with nothing to say about it produces NO lines", () => {
    // The shipped path for every template. A warning printed on every build is
    // a warning nobody reads, so silence here is load-bearing.
    expect(agentConfigWarnings({})).toEqual([]);
    expect(
      agentConfigWarnings({
        tts: assemblyAITts({ voice: ASSEMBLYAI_TTS_DEFAULT_VOICE }),
        stt: descriptor("assemblyai", {}),
      }),
    ).toEqual([]);
  });

  test("it returns lines rather than logging, so each caller decides where they go", () => {
    // `aai build` and `aai dev` print them; a config layer with nowhere to put
    // one ignores the array. That is only possible because nothing here writes.
    expect(Array.isArray(agentConfigWarnings({ tts: cartesiaTts({ voice: "not-a-uuid" }) }))).toBe(
      true,
    );
  });

  test("several warnings are all returned, not just the first", () => {
    const warnings = agentConfigWarnings({
      stt: descriptor("assemblyai", { region: "eu" }),
      tts: cartesiaTts({ voice: "not-a-uuid" }),
    });
    expect(warnings).toHaveLength(2);
    expect(warnings.some((line) => line.includes("Cartesia"))).toBe(true);
    expect(warnings.some((line) => line.includes(ASSEMBLYAI_TTS_HOST))).toBe(true);
  });
});

describe("an AssemblyAI voice outside this release's catalog", () => {
  test("is warned about on the TTS descriptor", () => {
    const [warning] = agentConfigWarnings({ tts: descriptor("assemblyai", { voice: "jain" }) });
    expect(warning).toContain('"jain"');
  });

  test("is warned about on the S2S descriptor too — same catalog, same failure", () => {
    // The S2S stage carries a voice from the same catalog, and it is read
    // because a typo there mutes the agent in exactly the same way.
    const [warning] = agentConfigWarnings({ s2s: descriptor("assemblyai", { voice: "jain" }) });
    expect(warning).toContain('"jain"');
  });

  test("a catalog voice says nothing", () => {
    expect(
      agentConfigWarnings({
        tts: descriptor("assemblyai", { voice: ASSEMBLYAI_TTS_DEFAULT_VOICE }),
      }),
    ).toEqual([]);
  });
});

describe("a voice on a provider this SDK carries no catalog for", () => {
  test("Cartesia: an author-chosen id is UNVALIDATED, and the line says what that hides", () => {
    // No catalog exists here and inventing one would go stale, refusing voices
    // the service ships. So the honest line names the failure instead: connect,
    // report ready, never speak.
    const [warning] = agentConfigWarnings({
      tts: cartesiaTts({ voice: "156fb8d2-335b-4950-9cb3-a2d33befec77" }),
    });
    expect(warning).toContain("Cartesia");
    expect(warning).toContain("no Cartesia voice catalog");
    expect(warning).toContain("never speak");
    // A well-formed id gets no shape complaint — that half is checkable and passed.
    expect(warning).not.toContain("UUID");
  });

  test("Cartesia: an id that is not a UUID gets the extra, CHECKABLE half", () => {
    // The only part of the question answerable offline: Cartesia issues UUIDs,
    // so a bare word is wrong without consulting anything.
    const [warning] = agentConfigWarnings({ tts: cartesiaTts({ voice: "cove" }) });
    expect(warning).toContain("it is not a UUID, which every Cartesia voice id is");
  });

  test("Rime: no shape is declared, so it gets the unvalidated line alone", () => {
    // Rime speaker ids are bare lowercase words — not a shape a typo violates —
    // so claiming one is malformed would be noise.
    const [warning] = agentConfigWarnings({ tts: rimeTts({ voice: "marsh" }) });
    expect(warning).toContain("Rime");
    expect(warning).not.toContain("which every");
  });

  test("the DEFAULT voice is exempt on both, because the SDK chose it", () => {
    // "We cannot vouch for this" about the value we supplied is noise. Every
    // template runs on these two.
    expect(agentConfigWarnings({ tts: cartesiaTts() })).toEqual([]);
    expect(agentConfigWarnings({ tts: rimeTts() })).toEqual([]);
    expect(agentConfigWarnings({ tts: cartesiaTts({ voice: CARTESIA_DEFAULT_VOICE }) })).toEqual(
      [],
    );
    expect(agentConfigWarnings({ tts: rimeTts({ voice: RIME_DEFAULT_VOICE }) })).toEqual([]);
  });

  test("a provider with no entry, a non-string voice and a non-record stage say nothing", () => {
    // It takes the DESCRIPTOR like its AssemblyAI sibling, so anything it does
    // not recognise is simply not warned about rather than crashing a build.
    expect(agentConfigWarnings({ tts: descriptor("elevenlabs", { voice: "whoever" }) })).toEqual(
      [],
    );
    expect(agentConfigWarnings({ tts: descriptor("cartesia", { voice: 42 }) })).toEqual([]);
    expect(agentConfigWarnings({ tts: descriptor("cartesia", { voice: "" }) })).toEqual([]);
    expect(agentConfigWarnings({ tts: "cartesia" })).toEqual([]);
    expect(agentConfigWarnings({ tts: { kind: "cartesia" } })).toEqual([]);
  });
});

describe('region: "eu" with a TTS stage that has no EU endpoint', () => {
  const EU_STT = descriptor("assemblyai", { region: "eu" });
  const EU_LLM = descriptor("assemblyai", { region: "eu" });

  test("warns from the STT stage, naming the host the audio really comes from", () => {
    // The one option on this surface that is a COMPLIANCE claim rather than a
    // preference, which is why a JSDoc was the wrong strength of statement.
    const [warning] = agentConfigWarnings({ stt: EU_STT, tts: assemblyAITts() });
    expect(warning).toContain(ASSEMBLYAI_TTS_HOST);
    expect(warning).toContain("outside the EU");
    expect(warning).toContain("Transcription and generation stay in-region");
  });

  test("warns from the LLM gateway stage too", () => {
    expect(agentConfigWarnings({ llm: EU_LLM, tts: assemblyAITts() })).toHaveLength(1);
  });

  test("says nothing when there is no TTS stage to route", () => {
    // An agent without synthesis has no audio to leak, which is the remedy the
    // line itself offers.
    expect(agentConfigWarnings({ stt: EU_STT })).toEqual([]);
    expect(agentConfigWarnings({ llm: EU_LLM })).toEqual([]);
  });

  test("says nothing when nothing declared the EU", () => {
    expect(
      agentConfigWarnings({ stt: descriptor("assemblyai", {}), tts: assemblyAITts() }),
    ).toEqual([]);
    expect(
      agentConfigWarnings({
        stt: descriptor("assemblyai", { region: "us" }),
        tts: assemblyAITts(),
      }),
    ).toEqual([]);
  });

  test("it is a WARNING, not a refusal — the configuration is legal", () => {
    // Residency rules that bind transcripts often do not bind synthesized
    // audio, and refusing would break every EU agent that already decided this.
    expect(() => agentConfigWarnings({ stt: EU_STT, tts: assemblyAITts() })).not.toThrow();
  });
});
