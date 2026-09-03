// Copyright 2025 the AAI authors. MIT license.
/**
 * What the AssemblyAI STT adapter DIALS — every value that lands on the
 * streaming connect URL: the speech model, the contextual-biasing prompt,
 * Voice Focus, the endpointing pair, EU data residency, and the connect
 * budget. Split from `assemblyai.test.ts`, which covers what the adapter does
 * with a live stream once connected; the two share `_assemblyai-test-utils.ts`.
 *
 * These are the defaults a bad session gets blamed on, and most of them are
 * measured — see each constant's doc. A default that silently stops reaching
 * the wire is invisible at every level anyone looks at, which is what this
 * file exists to prevent.
 */

import {
  ASSEMBLYAI_STT_DEFAULT_MODEL,
  DEFAULT_SESSION_START_TIMEOUT_MS,
  DEFAULT_SPEECH_IDLE_TIMEOUT_MS,
  DEFAULT_VOICE_FOCUS_THRESHOLD,
  STT_CONNECT_MAX_RETRIES,
  STT_CONNECT_RETRY_DELAY_MS,
  STT_CONNECT_TIMEOUT_MS,
} from "@alexkroman1/aai/host-internal";
import {
  DEFAULT_MAX_TURN_SILENCE_MS,
  DEFAULT_MIN_TURN_SILENCE_MS,
  DEFAULT_STT_PROMPT,
} from "@alexkroman1/aai/internal";
import { ASSEMBLYAI_STT_EU_URL, assemblyAIStt } from "@alexkroman1/aai/stt";
import { describe, expect, test, vi } from "vitest";
import { fakeOf, openSessionWith } from "./_assemblyai-test-utils.ts";
import { type AssemblyAISession, openAssemblyAI } from "./assemblyai.ts";

vi.mock("assemblyai", async () => {
  const { assemblyAIModuleMock } = await import("./_assemblyai-test-utils.ts");
  return assemblyAIModuleMock();
});

async function openSession(
  providerOpts: Parameters<typeof openAssemblyAI>[0],
  openOpts: Partial<Parameters<ReturnType<typeof openAssemblyAI>["open"]>[0]> = {},
): Promise<AssemblyAISession> {
  return openSessionWith(openAssemblyAI, providerOpts, openOpts);
}

describe("assemblyAIStt STT adapter — speech model", () => {
  test("a descriptor naming no model still dials universal-3-5-pro", async () => {
    // The only DIRECT pin on what `speech_model` carries. The settings log
    // (`runtime.test.ts`, "logs each stage's effective settings") asserts the
    // same id, but it reads `resolveAssemblyAISttSettings` — so it stays green
    // if the resolver is right and the mapping onto the SDK's parameter name
    // is not. Every other test in this file passes `model` explicitly, which
    // is exactly the case that cannot see a broken default.
    const session = await openSession({});
    expect(fakeOf(session).params.speechModel).toBe("universal-3-5-pro");
    expect(ASSEMBLYAI_STT_DEFAULT_MODEL).toBe("universal-3-5-pro");
    await session.close();
  });

  test("the parameter is never omitted — the SDK skips it when undefined", async () => {
    // `assemblyai`'s transcriber only sets the query param under
    // `speechModel !== undefined`, so an omitted key is a session running on
    // whatever the service defaults to, with nothing on our side to show for
    // it. Unlike `prompt`/`languageCodes`, this key is unconditional.
    const session = await openSession({});
    expect("speechModel" in fakeOf(session).params).toBe(true);
    await session.close();
  });

  test("an agent's own model replaces the default", async () => {
    const session = await openSession({ model: "u3-rt-pro" });
    expect(fakeOf(session).params.speechModel).toBe("u3-rt-pro");
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — prompt default", () => {
  test("sends no prompt when the agent configures none (default is empty)", async () => {
    // Biasing is opt-in: a generic identifier prompt measured no better than
    // none, and an off-target one steers the transcript toward vocabulary the
    // caller never used. Agents that need it supply their own.
    expect(DEFAULT_STT_PROMPT).toBe("");
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    expect("prompt" in fake.params).toBe(false);
    await session.close();
  });

  test("an agent's own sttPrompt replaces the default", async () => {
    const session = await openSession(
      { model: "universal-3-5-pro" },
      { sttPrompt: "Terms: dosage names." },
    );
    const fake = fakeOf(session);
    expect(fake.params.prompt).toBe("Terms: dosage names.");
    await session.close();
  });

  test("sttPrompt: '' opts out — no prompt param at all", async () => {
    const session = await openSession({ model: "universal-3-5-pro" }, { sttPrompt: "" });
    const fake = fakeOf(session);
    expect("prompt" in fake.params).toBe(false);
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — voice focus", () => {
  test("defaults voiceFocus to near-field at connect", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    expect(fake.params.voiceFocus).toBe("near-field");
    await session.close();
  });

  test("respects an explicit voiceFocus and disables on 'off'", async () => {
    const far = await openSession({ model: "universal-3-5-pro", voiceFocus: "far-field" });
    expect(fakeOf(far).params.voiceFocus).toBe("far-field");
    await far.close();

    const off = await openSession({ model: "universal-3-5-pro", voiceFocus: "off" });
    const offFake = fakeOf(off);
    expect(offFake.params.voiceFocus).toBeUndefined();
    expect("voiceFocus" in offFake.params).toBe(false);
    await off.close();
  });

  test("sends voiceFocusThreshold, defaulting ABOVE the service's own 0.7", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    // The whole point of the default is that it is more aggressive than the
    // service's — inheriting 0.7 is the regression this pins.
    expect(fake.params.voiceFocusThreshold).toBe(DEFAULT_VOICE_FOCUS_THRESHOLD);
    expect(DEFAULT_VOICE_FOCUS_THRESHOLD).toBeGreaterThan(0.7);
    await session.close();
  });

  test("respects an explicit voiceFocusThreshold", async () => {
    const session = await openSession({ model: "universal-3-5-pro", voiceFocusThreshold: 0.5 });
    const fake = fakeOf(session);
    expect(fake.params.voiceFocusThreshold).toBe(0.5);
    await session.close();
  });

  test("omits the threshold when voice focus is off — it tunes a filter that isn't running", async () => {
    const off = await openSession({
      model: "universal-3-5-pro",
      voiceFocus: "off",
      voiceFocusThreshold: 0.9,
    });
    const fake = fakeOf(off);
    expect("voiceFocusThreshold" in fake.params).toBe(false);
    await off.close();
  });
});

describe("assemblyAIStt STT adapter — endpointing (min/max_turn_silence)", () => {
  test("always sets BOTH halves; defaults to the DEFAULT_*_TURN_SILENCE_MS pair", async () => {
    // Endpointing is the provider's job — the pipeline transport commits a
    // turn on every final. Both halves are sent because the service defaults
    // them independently (min from the `mode` preset, max to 1536), so sending
    // only one is how they end up inverted.
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);
    expect(fake.params.minTurnSilence).toBe(DEFAULT_MIN_TURN_SILENCE_MS);
    expect(fake.params.minTurnSilence).toBe(1600);
    expect(fake.params.maxTurnSilence).toBe(DEFAULT_MAX_TURN_SILENCE_MS);
    // 3500 is the measured half of the pair (tau2-bench retail reward 0.68,
    // twice); the 3000 trim was reverted when the asymmetry its own doc named
    // as the revert condition showed up — splits on hesitant, non-spelling
    // utterances while spelled identifiers stayed whole.
    expect(fake.params.maxTurnSilence).toBe(3500);
    await session.close();
  });

  test("the default minimum stays BELOW the default maximum", () => {
    // The bug this pair replaced: min was raised 1500 -> 2000 -> 3000 to stop
    // utterances splitting, while max was never set and sat at the service
    // default 1536. Above 1536 the completeness check can no longer fire
    // before the content-blind force-end closes the turn, so every ending came
    // from the acoustic fallback — the very mechanism that splits utterances.
    // An inverted pair is silently wrong on the wire, so assert it here.
    expect(DEFAULT_MIN_TURN_SILENCE_MS).toBeLessThan(DEFAULT_MAX_TURN_SILENCE_MS);
  });

  test("the speaking-edge idle deadline stays ABOVE the endpointing ceiling", () => {
    // The coupling the false-interruption rework made explicit. The idle
    // watchdog closing the speaking edge is what fires a false-interruption
    // resume, so an utterance force-ended by `max_turn_silence` must deliver
    // its final BEFORE that deadline — otherwise the agent resumes a reply the
    // caller really did interrupt. The transport cannot check this itself: it
    // receives an already-resolved SttOpener and never sees the endpointing
    // window. It used to be pinned only in prose, in the opposite direction
    // (max_turn_silence above the old 2000 ms recovery window), which is how
    // it stayed invisible. Note the margin covers final-emission latency, so
    // an agent raising maxTurnSilenceMs must raise `speechIdleTimeoutMs` too.
    expect(DEFAULT_SPEECH_IDLE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_MAX_TURN_SILENCE_MS);
  });

  test("each override is independent", async () => {
    const session = await openSession({
      model: "universal-3-5-pro",
      minTurnSilenceMs: 400,
      maxTurnSilenceMs: 5000,
    });
    const fake = fakeOf(session);
    expect(fake.params.minTurnSilence).toBe(400);
    expect(fake.params.maxTurnSilence).toBe(5000);
    await session.close();
  });

  test("overriding one leaves the other at its default", async () => {
    const session = await openSession({ model: "universal-3-5-pro", minTurnSilenceMs: 200 });
    const fake = fakeOf(session);
    expect(fake.params.minTurnSilence).toBe(200);
    expect(fake.params.maxTurnSilence).toBe(DEFAULT_MAX_TURN_SILENCE_MS);
    await session.close();
  });
});

describe("assemblyAIStt STT adapter — region (EU data residency)", () => {
  test("factory: region lands in the descriptor options and is absent by default", () => {
    expect(assemblyAIStt({ region: "eu" }).options.region).toBe("eu");
    expect("region" in assemblyAIStt().options).toBe(false);
  });

  test("region: 'eu' points the SDK's streaming socket at the EU endpoint", async () => {
    const session = await openSession({ model: "universal-3-5-pro", region: "eu" });
    const fake = fakeOf(session);
    expect(fake.params.websocketBaseUrl).toBe(ASSEMBLYAI_STT_EU_URL);
    expect(fake.params.websocketBaseUrl).toBe("wss://streaming.eu.assemblyai.com/v3/ws");
    await session.close();
  });

  test("no region (or 'us') leaves the SDK's own default endpoint in place", async () => {
    // Not pinned host-side: a stale copy of the SDK's versioned default path
    // would silently override an SDK path bump.
    const unset = await openSession({ model: "universal-3-5-pro" });
    expect("websocketBaseUrl" in fakeOf(unset).params).toBe(false);
    await unset.close();

    const us = await openSession({ model: "universal-3-5-pro", region: "us" });
    expect("websocketBaseUrl" in fakeOf(us).params).toBe(false);
    await us.close();
  });

  test("languages sets language_codes, and is absent unless asked for", async () => {
    // Universal-3.5 Pro code-switches across 18 languages when this is unset,
    // so the absent case must stay absent — sending a default would silently
    // disable multilingual transcription for every agent.
    const unset = await openSession({ model: "universal-3-5-pro" });
    expect("languageCodes" in fakeOf(unset).params).toBe(false);
    await unset.close();

    const pinned = await openSession({ model: "universal-3-5-pro", languages: ["en"] });
    expect(fakeOf(pinned).params.languageCodes).toEqual(["en"]);
    await pinned.close();

    const several = await openSession({
      model: "universal-3-5-pro",
      languages: ["en", "es"],
    });
    expect(fakeOf(several).params.languageCodes).toEqual(["en", "es"]);
    await several.close();

    // An empty list is a no-op, not "pin zero languages".
    const empty = await openSession({ model: "universal-3-5-pro", languages: [] });
    expect("languageCodes" in fakeOf(empty).params).toBe(false);
    await empty.close();
  });

  test("streamingUrl overrides the endpoint, and wins over region", async () => {
    const sandbox = "wss://streaming.sandbox000.assemblyai-labs.com/v3/ws";

    const session = await openSession({ model: "universal-3-5-pro", streamingUrl: sandbox });
    expect(fakeOf(session).params.websocketBaseUrl).toBe(sandbox);
    await session.close();

    // An explicit endpoint is a deliberate choice; the residency shorthand
    // must not silently overwrite it.
    const both = await openSession({
      model: "universal-3-5-pro",
      region: "eu",
      streamingUrl: sandbox,
    });
    expect(fakeOf(both).params.websocketBaseUrl).toBe(sandbox);
    await both.close();
  });
});

describe("assemblyAIStt STT adapter — connect budget", () => {
  test("overrides the SDK's 1000 ms connect deadline and pins the retry policy", async () => {
    const session = await openSession({ model: "universal-3-5-pro" });
    const fake = fakeOf(session);

    // The SDK default is 1000 ms for socket-open *plus* the server's `Begin`,
    // which a healthy connect can exceed; never inherit it.
    expect(fake.params.connectTimeout).toBe(STT_CONNECT_TIMEOUT_MS);
    expect(fake.params.connectTimeout).not.toBe(1000);
    expect(fake.params.maxConnectionRetries).toBe(STT_CONNECT_MAX_RETRIES);
    expect(fake.params.connectionRetryDelay).toBe(STT_CONNECT_RETRY_DELAY_MS);

    await session.close();
  });

  test("worst-case connect budget fits inside the session-start deadline", () => {
    // The STT open runs inside session.start(); a larger budget could only
    // surface as the less specific "session.start() timed out".
    const attempts = STT_CONNECT_MAX_RETRIES + 1;
    const worstCaseMs =
      attempts * STT_CONNECT_TIMEOUT_MS + STT_CONNECT_MAX_RETRIES * STT_CONNECT_RETRY_DELAY_MS;
    expect(worstCaseMs).toBeLessThan(DEFAULT_SESSION_START_TIMEOUT_MS);
  });

  test("forwards explicit connect overrides, including 0 to disable", async () => {
    const slow = await openSession({ connectTimeoutMs: 9000, maxConnectRetries: 0 });
    const slowFake = fakeOf(slow);
    expect(slowFake.params.connectTimeout).toBe(9000);
    expect(slowFake.params.maxConnectionRetries).toBe(0);
    await slow.close();

    // 0 is the SDK's "no deadline" value — it must survive as 0, not fall
    // back to the default via `??`-on-falsy.
    const unbounded = await openSession({ connectTimeoutMs: 0 });
    expect(fakeOf(unbounded).params.connectTimeout).toBe(0);
    await unbounded.close();
  });
});
