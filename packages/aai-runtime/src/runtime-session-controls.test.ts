// Copyright 2026 the AAI authors. MIT license.
// Everything ONE session is wired with before its transport exists. It is a
// single function rather than four exports because of the ORDER — the emitter
// needs the dialogs' observer, the dialogs need the prompt, and the controls
// need the emitter — so what this file claims is that the wiring really is
// wired: what the meter measures and what a guardrail decides both come out on
// the session's one publishing path, and every author function is looking at
// the SAME slots.

import type { AgentGuardrail, SlotStore } from "@alexkroman1/aai";
import type { SessionEvent } from "@alexkroman1/aai/protocol";
import { describe, expect, test, vi } from "vitest";
import { makeAgent, makeClientSink, makeConfig, makeLogger } from "./_test-utils.ts";
import { openSessionWiring } from "./runtime-session-controls.ts";
import type { RuntimeSessionState } from "./runtime-session-state.ts";
import { createSystemPromptResolver } from "./runtime-system-prompt.ts";
import { createSessionEventStream } from "./session-event-stream.ts";
import { createMemoryStateBackend, createSessionStateStore } from "./session-state/store.ts";
import { createStateSweeps } from "./session-state/sweeps.ts";
import type { Transport } from "./transports/types.ts";

const SID = "s-1";

/**
 * A transport that does nothing, resolved LATE like the real one.
 *
 * The dialogs take a thunk because the transport is built AFTER this wiring —
 * it takes the prompt thunk the dialogs install into — so nothing here may
 * construct one. Nothing in these cases reaches it; the value exists so the
 * seam is typed rather than cast.
 */
function stubTransport(): Transport {
  return {
    start: () => Promise.resolve(),
    stop: () => Promise.resolve(),
    sendUserAudio: vi.fn(),
    sendToolResult: vi.fn(),
    cancelReply: vi.fn(),
  };
}

/** The runtime's state shape, over a memory backend the case holds. */
function makeState(): RuntimeSessionState {
  const backend = createMemoryStateBackend();
  const store = createSessionStateStore({ backend, logger: makeLogger() });
  return {
    store,
    stream: createSessionEventStream({ backend }),
    sweeps: createStateSweeps(store),
    describe: { backend: backend.name, durable: backend.durable },
  };
}

/** One session's wiring, plus the events it published to the client. */
function wire(
  overrides: Partial<Parameters<typeof openSessionWiring>[0]> = {},
): ReturnType<typeof openSessionWiring> & { events: SessionEvent[]; state: RuntimeSessionState } {
  const events: SessionEvent[] = [];
  const state = overrides.state ?? makeState();
  const wiring = openSessionWiring({
    agent: makeAgent(),
    env: {},
    sessionId: SID,
    client: makeClientSink({ event: (event: SessionEvent) => void events.push(event) }),
    prompt: createSystemPromptResolver({
      agentConfig: makeConfig(),
      hasTools: false,
      toolGuidance: undefined,
    }),
    limits: undefined,
    transport: stubTransport,
    logger: makeLogger(),
    ...overrides,
    state,
  });
  return { ...wiring, events, state };
}

/** Every event of one type the client received. */
function eventsOf<T extends SessionEvent["type"]>(
  events: readonly SessionEvent[],
  type: T,
): Extract<SessionEvent, { type: T }>[] {
  return events.filter((event): event is Extract<SessionEvent, { type: T }> => event.type === type);
}

describe("openSessionWiring", () => {
  test("answers all four collaborators, built for one session", () => {
    const { dialogs, emitter, usage, guardrails } = wire();
    expect(dialogs).toBeDefined();
    expect(emitter).toBeDefined();
    expect(usage.snapshot()).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      steps: 0,
    });
    expect(guardrails.holdsSpeech).toBe(false);
  });

  test("the METER publishes through the emitter — that is the whole wiring", () => {
    // The meter is built with `onUpdate` pointed at the emitter, which is why
    // the emitter has to exist first. Measured usage that never reached the
    // client would be a control nobody can audit.
    const { usage, events } = wire({ limits: { totalTokens: 1000 } });
    usage.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(eventsOf(events, "usage.updated")[0]).toMatchObject({
      inputTokens: 10,
      outputTokens: 5,
      totalTokens: 15,
      steps: 1,
    });
  });

  test("the meter carries the session's declared limit", () => {
    const { usage } = wire({ limits: { totalTokens: 12 } });
    expect(usage.exhausted()).toBeUndefined();
    usage.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(usage.exhausted()).toContain("budget of 12");
  });

  test("a budget is enforced from the RECORD, not from the event", () => {
    // The gate below decides who hears about a step; it must not decide whether
    // one was counted. An agent with a cap and no `events` handler still trips
    // it — that is the whole feature, and it is enforced off `snapshot()`.
    const { usage, events } = wire({ limits: { totalTokens: 12 } });
    usage.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(usage.snapshot().totalTokens).toBe(15);
    expect(usage.exhausted()).toContain("budget of 12");
    // And it is announced, because a declared budget is a reader.
    expect(eventsOf(events, "usage.updated")).toHaveLength(1);
  });

  test("an UNOBSERVED session is metered and announces NOTHING", () => {
    // `record()` runs once per model STEP — every step of every turn, plus
    // every `ctx.generate` and every step of every `ctx.delegate` — so a
    // default `maxSteps: 10` tool turn would mint eleven ULIDs, append eleven
    // entries to the retained stream and send eleven frames competing with
    // audio, for an event that is cumulative and that nothing here reads.
    const { usage, events } = wire({ limits: undefined });
    usage.record({ inputTokens: 1_000_000, outputTokens: 1_000_000, totalTokens: 2_000_000 });
    // Still MEASURED: `snapshot()` is what `ctx.generate` and a subagent read.
    expect(usage.snapshot()).toMatchObject({ totalTokens: 2_000_000, steps: 1 });
    expect(usage.exhausted()).toBeUndefined();
    expect(eventsOf(events, "usage.updated")).toEqual([]);
  });

  test("a declared `usage.updated` handler is a reader, and turns the frames back on", () => {
    const seen: number[] = [];
    const { usage, events } = wire({
      agent: makeAgent({
        events: { "usage.updated": (event) => void seen.push(event.totalTokens) },
      }),
    });
    usage.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(seen).toEqual([15]);
    expect(eventsOf(events, "usage.updated")).toHaveLength(1);
  });

  test('a `"*"` handler counts as one too — it receives every type by declaration', () => {
    const { usage, events } = wire({
      agent: makeAgent({ events: { "*": () => undefined } }),
    });
    usage.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(eventsOf(events, "usage.updated")).toHaveLength(1);
  });

  test("a handler for some OTHER event is not a reader of this one", () => {
    const { usage, events } = wire({
      agent: makeAgent({ events: { "tool.called": () => undefined } }),
    });
    usage.record({ inputTokens: 10, outputTokens: 5, totalTokens: 15 });
    expect(eventsOf(events, "usage.updated")).toEqual([]);
  });

  test("a BLOCK is published as `guardrail.blocked`, with its direction", () => {
    const block: AgentGuardrail = () => "I can't help with that.";
    const { guardrails, events } = wire({
      agent: makeAgent({ inputGuardrails: [block], outputGuardrails: [block] }),
    });
    expect(guardrails.holdsSpeech).toBe(true);
    return Promise.all([guardrails.checkInput("ssn?"), guardrails.checkOutput("300mg")]).then(
      ([input, output]) => {
        expect([input, output]).toEqual(["I can't help with that.", "I can't help with that."]);
        expect(eventsOf(events, "guardrail.blocked").map((event) => event.direction)).toEqual([
          "input",
          "output",
        ]);
      },
    );
  });

  test("a guardrail that THREW is reported NON-fatally, naming the direction", async () => {
    // The text went through, and taking the call down on top of a check that
    // could not decide helps nobody — but `fatal: true` in this codebase means
    // the session is over and a browser client hangs up on one.
    const { guardrails, events } = wire({
      agent: makeAgent({
        outputGuardrails: [
          () => {
            throw new Error("classifier timed out");
          },
        ],
      }),
    });
    await expect(guardrails.checkOutput("anything")).resolves.toBeUndefined();
    const [reported] = eventsOf(events, "error.reported");
    expect(reported).toMatchObject({ code: "internal", fatal: false });
    expect(reported?.message).toContain("An output guardrail threw and was skipped");
    expect(reported?.message).toContain("classifier timed out");
    expect(eventsOf(events, "guardrail.blocked")).toEqual([]);
  });

  test("an s2s agent gets an UNCAPPED meter and an empty guardrail set", async () => {
    // Both are refused at config time (`assertSamplingScope`,
    // `assertGuardrailScope`), so neither is built conditionally here — an
    // agent that declared none gets exactly what its declarations say. The
    // meter is real, and every tool call carries it: what s2s cannot feed it is
    // the conversational loop's tokens, not a tool's `ctx.generate`.
    const { usage, guardrails } = wire({ agent: makeAgent() });
    expect(usage.exhausted()).toBeUndefined();
    expect(guardrails.holdsSpeech).toBe(false);
    await expect(guardrails.checkInput("anything")).resolves.toBeUndefined();
    await expect(guardrails.checkOutput("anything")).resolves.toBeUndefined();
  });

  test("ONE slot view is shared by the dialogs and the author functions", async () => {
    // A resolver and a guardrail reading two views of one session would be
    // reading two caches of one value, and the bug has no symptom on a machine
    // running one session at a time.
    const seen: { slots: SlotStore; sessionId: string; env: unknown }[] = [];
    const record: AgentGuardrail = (_text, ctx) => {
      seen.push({ slots: ctx.slots, sessionId: ctx.sessionId, env: ctx.env });
      return true;
    };
    const state = makeState();
    const env = { TIER: "gold" };
    const { guardrails } = wire({
      state,
      env,
      agent: makeAgent({ inputGuardrails: [record], outputGuardrails: [record] }),
    });
    await guardrails.checkInput("a");
    await guardrails.checkOutput("b");
    expect(seen).toHaveLength(2);
    // The same OBJECT across both guardrails, and both directions.
    expect(seen[0]?.slots).toBe(seen[1]?.slots);
    expect(seen[0]).toMatchObject({ sessionId: SID, env });
    // And it is THIS session's storage, not a detached one: a write through the
    // author's view is visible to the runtime's own reader.
    seen[0]?.slots?.write("strikes", 2, true);
    expect(state.store.viewFor(SID).read("strikes")).toBe(2);
  });

  test("commitSessionState is optional, and never awaited when present", () => {
    // Fire-and-forget on purpose: the emit path is synchronous, and a hook's
    // write must not put a backend round trip in front of the next frame on a
    // live call.
    const commitSessionState = vi.fn(() => new Promise<void>(() => undefined));
    expect(() => wire({ commitSessionState })).not.toThrow();
    expect(() => wire({ commitSessionState: undefined })).not.toThrow();
  });
});
