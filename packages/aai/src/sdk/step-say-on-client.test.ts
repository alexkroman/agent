// Copyright 2026 the AAI authors. MIT license.

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { publishStepEnv } from "./step-env.ts";
import {
  type ClientNotifier,
  ClientUnreachableError,
  publishClientNotifier,
} from "./step-notify-client.ts";
import {
  DEFAULT_CLIENT_DELIVERY_ATTEMPTS,
  publishClientInboxDefaults,
  stepSayOnClient,
} from "./step-say-on-client.ts";
import {
  publishSpeechSynthesizer,
  type SpeechSynthesizer,
  STEP_SPEAK_SAMPLE_RATE,
} from "./step-speak.ts";

let synthesize: ReturnType<typeof vi.fn<SpeechSynthesizer>>;

beforeEach(() => {
  publishStepEnv({ ASSEMBLYAI_API_KEY: "test-key" });
  synthesize = vi.fn<SpeechSynthesizer>(async ({ text }) => new TextEncoder().encode(text));
  publishSpeechSynthesizer(synthesize);
});

afterEach(() => {
  publishClientNotifier(undefined);
  publishSpeechSynthesizer(undefined);
  publishClientInboxDefaults(undefined);
  publishStepEnv(undefined);
});

describe("stepSayOnClient", () => {
  test("speaks the text and pushes it with data.said, resolving the text", async () => {
    const notify = vi.fn<ClientNotifier>(async () => "acked");
    publishClientNotifier(notify);
    const said = await stepSayOnClient("speaker", {
      id: "run-1",
      event: "reminder",
      text: "Reminder: feed Biscuit",
      data: { text: "feed Biscuit" },
    });
    expect(said).toBe("Reminder: feed Biscuit");
    const [clientId, notice] = notify.mock.calls[0] ?? [];
    expect(clientId).toBe("speaker");
    expect(notice).toMatchObject({
      id: "run-1",
      event: "reminder",
      data: { text: "feed Biscuit", said: "Reminder: feed Biscuit" },
    });
    expect(new TextDecoder().decode(notice?.audio)).toBe("Reminder: feed Biscuit");
  });

  test("synthesizes at the call's rate, then the agent's clientInbox rate, then stepSpeak's", async () => {
    publishClientNotifier(async () => "acked");
    await stepSayOnClient("speaker", { id: "a", event: "e", text: "one" });
    publishClientInboxDefaults({ sampleRate: 16_000 });
    await stepSayOnClient("speaker", { id: "b", event: "e", text: "two" });
    await stepSayOnClient("speaker", { id: "c", event: "e", text: "three", sampleRate: 8000 });
    expect(synthesize.mock.calls.map(([req]) => req.sampleRate)).toEqual([
      STEP_SPEAK_SAMPLE_RATE,
      16_000,
      8000,
    ]);
  });

  test("a retry after an unreachable device re-uses the audio instead of re-synthesizing", async () => {
    const notify = vi
      .fn<ClientNotifier>()
      .mockResolvedValueOnce("offline")
      .mockResolvedValueOnce("busy")
      .mockResolvedValue("acked");
    publishClientNotifier(notify);
    const say = () => stepSayOnClient("speaker", { id: "r", event: "e", text: "held" });
    await expect(say()).rejects.toBeInstanceOf(ClientUnreachableError);
    await expect(say()).rejects.toBeInstanceOf(ClientUnreachableError);
    await say();
    expect(synthesize).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledTimes(3);
    // Delivered, so released: saying it again is a new utterance.
    await say();
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  test("a failure that is not the device being unreachable holds nothing", async () => {
    // No notifier published: fatal, so no retry will come for the audio.
    const say = () => stepSayOnClient("speaker", { id: "r", event: "e", text: "fatal" });
    await expect(say()).rejects.toThrow(/no client inbox/i);
    await expect(say()).rejects.toThrow(/no client inbox/i);
    expect(synthesize).toHaveBeenCalledTimes(2);
  });

  test("the default delivery budget rides out an hour at the 30 s retry", () => {
    expect(DEFAULT_CLIENT_DELIVERY_ATTEMPTS).toBe(120);
  });
});
