// Copyright 2026 the AAI authors. MIT license.

import type { SessionEvent, SessionEventBody } from "@alexkroman1/aai";
import { agent, dialog, roster, type SlotStore, speaker, tool } from "@alexkroman1/aai";
import { createDetachedSlotStore } from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import { z } from "zod";
import { makeConfig, makeSessionContext } from "../_agent-test-utils.ts";
import { makeLogger } from "../_logger-test-utils.ts";
import { OPENAI_REALTIME_CAPABILITIES, PIPELINE_CAPABILITIES } from "../transports/capabilities.ts";
import type { Transport } from "../transports/types.ts";
import { openSessionDialogs } from "./dialogs.ts";
import { openSessionPersonas, PERSONA_SUFFIX_KEY } from "./personas.ts";
import { createSystemPromptResolver } from "./system-prompt.ts";

const SID = "s-persona";

const triage = speaker({
  name: "triage",
  speaks: true,
  description: "Answers the phone",
  systemPrompt: "Find out what the caller needs.",
});
const billing = speaker({
  name: "billing",
  speaks: true,
  description: "Invoices and refunds",
  systemPrompt: "You are the billing desk.",
  tools: {
    lookup_invoice: tool({
      description: "Look up an invoice",
      inputSchema: z.object({ id: z.string() }),
      execute: ({ id }) => id,
    }),
  },
  temperature: 0.1,
});
/** A roster whose personas differ in prose and TOOLS only — nothing for the request. */
const { temperature: _billingTemperature, ...billingWithoutKnobs } = billing;
const proseOnly = roster([
  { ...triage, name: "front" },
  { ...billingWithoutKnobs, name: "back" },
]);

function makeTransport(capabilities = OPENAI_REALTIME_CAPABILITIES): {
  transport: Transport;
  refreshes: () => number;
} {
  const refreshSystemPrompt = vi.fn();
  const transport: Transport = {
    capabilities,
    start: async () => undefined,
    stop: async () => undefined,
    sendUserAudio: () => undefined,
    sendToolResult: () => undefined,
    cancelReply: () => undefined,
    refreshSystemPrompt,
  };
  return { transport, refreshes: () => refreshSystemPrompt.mock.calls.length };
}

let stamped = 0;
function event(body: SessionEventBody): SessionEvent {
  stamped += 1;
  return { ...body, meta: { id: `evt_${stamped}`, at: stamped } } as SessionEvent;
}
const configured = () =>
  event({
    type: "session.configured",
    audioFormat: "pcm_s16le",
    sampleRate: 16_000,
    ttsSampleRate: 24_000,
    sessionId: "sess_1",
  });
const toolDone = () => event({ type: "tool.completed", toolCallId: "call_1", result: "{}" });
const heard = () => event({ type: "userTranscript.committed", text: "hello" });

function setup(
  roster: Parameters<typeof openSessionPersonas>[0],
  slots?: SlotStore,
  capabilities = OPENAI_REALTIME_CAPABILITIES,
) {
  const { transport, refreshes } = makeTransport(capabilities);
  const logger = makeLogger();
  const store = slots ?? createDetachedSlotStore();
  const prompts = createSystemPromptResolver({
    agentConfig: makeConfig({ name: "Desk", systemPrompt: "Be brief." }),
    hasTools: false,
    toolGuidance: undefined,
  });
  const prompt = prompts.forSession(makeSessionContext({ sessionId: SID, slots: store }));
  const bound = openSessionPersonas(roster, SID, {
    prompt,
    slots: store,
    transport: () => transport,
    logger,
  });
  return { bound, prompt, slots: store, logger, refreshes, base: prompts.base() };
}

describe("an agent that declares no roster", () => {
  test("installs no suffix, so `resolve()` is the base string ITSELF", () => {
    const { bound, prompt, base } = setup(undefined);
    bound.observe(configured());
    expect(prompt.resolve()).toBe(base);
    expect(bound.turnKnobs).toBeUndefined();
  });
});

describe("the active persona's section", () => {
  test("is the entry persona's until a handoff, under a heading naming it", () => {
    const desk = roster([triage, billing]);
    const { prompt, base } = setup(desk);
    const text = prompt.resolve();
    expect(text.startsWith(base)).toBe(true);
    expect(text).toContain("## Active persona: triage\nFind out what the caller needs.");
    expect(text).not.toContain("billing desk");
  });

  test("changes at the next resolve after a handoff, and carries who from and the note", () => {
    const desk = roster([triage, billing]);
    const { prompt, slots } = setup(desk);
    desk.handoff({ slots, sessionId: SID }, billing, { note: "Account 4471 is verified." });
    const text = prompt.resolve();
    expect(text).toContain("## Active persona: billing\nYou are the billing desk.");
    expect(text).toContain("handed to you by triage, who noted: Account 4471 is verified.");
    expect(text).not.toContain("Find out what the caller needs.");
  });

  test("sorts AHEAD of the dialogs' suffix — who is speaking, then where in the script", () => {
    const desk = roster([triage, billing]);
    const script = dialog("script", {
      initial: "open",
      states: {
        open: { instruction: "Ask for the account number.", on: { X: "done" } },
        done: { final: true },
      },
    });
    // Bound through `agent()`, as a real roster is — that is what installs the
    // pin reader; the dialog here pins nothing and only contributes a suffix.
    agent({ name: "Scripted", roster: desk, dialogs: [script] });
    const slots = createDetachedSlotStore();
    const { transport } = makeTransport();
    const prompts = createSystemPromptResolver({
      agentConfig: makeConfig({ systemPrompt: "Be brief." }),
      hasTools: false,
      toolGuidance: undefined,
    });
    const prompt = prompts.forSession(makeSessionContext({ sessionId: SID, slots }));
    const dialogs = openSessionDialogs([script], SID, {
      prompt,
      slots,
      transport: () => transport,
      logger: makeLogger(),
    });
    openSessionPersonas(desk, SID, {
      prompt,
      slots,
      transport: () => transport,
      logger: makeLogger(),
    });
    dialogs.observe(configured());
    const text = prompt.resolve();
    expect(PERSONA_SUFFIX_KEY.localeCompare("dialogs")).toBeLessThan(0);
    expect(text.indexOf("## Active persona")).toBeLessThan(
      text.indexOf("Ask for the account number."),
    );
  });
});

describe("the push to a transport holding its prompt as session state", () => {
  test("primes on the first event and pushes only when the section CHANGED", () => {
    const desk = roster([triage, billing]);
    const { bound, slots, refreshes } = setup(desk);
    bound.observe(configured());
    expect(refreshes()).toBe(0);
    // A tool call that handed nobody off: same section, no frame.
    bound.observe(toolDone());
    expect(refreshes()).toBe(0);

    desk.handoff({ slots, sessionId: SID }, billing);
    // The handoff landed inside a tool call; its completion is the moment.
    bound.observe(heard());
    expect(refreshes()).toBe(0);
    bound.observe(toolDone());
    expect(refreshes()).toBe(1);
    bound.observe(toolDone());
    expect(refreshes()).toBe(1);
  });

  test("a transport that resolves the prompt per request is never pushed to", () => {
    const desk = roster([triage, billing]);
    const { bound, slots, refreshes } = setup(desk, undefined, PIPELINE_CAPABILITIES);
    bound.observe(configured());
    desk.handoff({ slots, sessionId: SID }, billing);
    bound.observe(toolDone());
    expect(refreshes()).toBe(0);
  });

  test("a stale slot — a persona the roster no longer has — answers as the entry persona and warns", () => {
    const desk = roster([triage, billing]);
    const slots = createDetachedSlotStore();
    // What a session resumed across a rename looks like: the slot names a
    // persona nobody declares any more.
    slots.write("aai.speaker", { active: "renamed", from: null, note: null }, true);
    const { prompt, logger } = setup(desk, slots);
    expect(prompt.resolve()).toContain("## Active persona: triage");
    expect(logger.warn).toHaveBeenCalledWith(
      "Persona position unreadable; answering as the entry persona",
      expect.objectContaining({ sessionId: SID }),
    );
  });
});

describe("the per-step knobs", () => {
  test("are absent when no persona declares a knob — tools alone change nothing about the request", () => {
    const { bound } = setup(proseOnly);
    expect(bound.turnKnobs).toBeUndefined();
  });

  test("carry the SPEAKER's knobs, re-read on every step", () => {
    const desk = roster([triage, billing]);
    const { bound, slots } = setup(desk);
    const knobs = bound.turnKnobs;
    if (!knobs) throw new Error("expected turn knobs");
    expect(knobs()).toEqual({});
    desk.handoff({ slots, sessionId: SID }, billing);
    expect(knobs()).toEqual({ temperature: 0.1 });
  });
});

describe("the persona's interruption group", () => {
  test("is absent when no persona declares one", () => {
    const { bound } = setup(roster([triage, billing]));
    expect(bound.interruption).toBeUndefined();
  });

  test("answers the SPEAKER's group in transport units, re-read after a handoff", () => {
    const disclosure = speaker({
      name: "disclosure",
      speaks: true,
      description: "Reads the terms",
      systemPrompt: "Read the terms in full.",
      interruption: "off",
    });
    const desk = roster([triage, disclosure]);
    const { bound, slots } = setup(desk);
    const read = bound.interruption;
    if (!read) throw new Error("expected an interruption source");
    expect(read()).toEqual({});
    desk.handoff({ slots, sessionId: SID }, disclosure);
    expect(read()).toEqual({ minBargeInWords: Number.POSITIVE_INFINITY });
  });
});
