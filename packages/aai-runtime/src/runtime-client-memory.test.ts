// Copyright 2026 the AAI authors. MIT license.
/**
 * A client's ONE conversation across sessions, end to end through a real
 * runtime over fake pipeline providers: the second session of a device is
 * seeded with what the first one said, told what `sessionContext` answered,
 * and the first one's stop reached `onSessionEnd`.
 *
 * The pieces have their own specs (`session-client-history.test.ts`,
 * `session-context.test.ts`, `runtime-session-memory.test.ts`); this one
 * asserts only the WIRING — that declaring the two hooks on `agent()` and
 * naming a client on the socket is all it takes.
 */

import type { SessionEndContext, SessionEvent } from "@alexkroman1/aai";
import { setSessionClient } from "@alexkroman1/aai/host-internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  FAKE_STT_API_KEY_ENV,
  FAKE_TTS_API_KEY_ENV,
  registerFakeProviders,
} from "./_pipeline-test-fakes.ts";
import { makeAgent, makeClientSink, silentLogger } from "./_test-utils.ts";
import { createRuntimeWithSeams } from "./runtime.ts";

let unregister: (() => void) | undefined;
afterEach(() => unregister?.());

function runtimeFor(agent: Parameters<typeof makeAgent>[0]) {
  const llm = createFakeLanguageModel({
    script: [{ type: "text", text: "Sure." }],
    repeatLast: true,
  });
  const fakes = registerFakeProviders({
    stt: createFakeSttProvider(),
    tts: createFakeTtsProvider(),
    llm,
  });
  unregister = fakes.unregister;
  const runtime = createRuntimeWithSeams({
    agent: makeAgent(agent),
    env: { ...fakes.env, [FAKE_STT_API_KEY_ENV]: "stt-key", [FAKE_TTS_API_KEY_ENV]: "tts-key" },
    logger: silentLogger,
    stt: fakes.stt,
    llm: fakes.llm,
    tts: fakes.tts,
  });
  return { runtime, llm };
}

describe("a client's conversation across sessions, through the runtime", () => {
  test("session two remembers session one, gets its context, and session one's end was reported", async () => {
    const ended: SessionEndContext[] = [];
    const sessionContext = vi.fn(() => ({ instructions: "Household: the Riveras." }));
    const { runtime, llm } = runtimeFor({
      sessionContext,
      onSessionEnd: (ctx) => void ended.push(ctx),
    });
    const client = `kitchen-${process.pid}`;

    // Session one: the device says something and hangs up.
    setSessionClient("first-session", client);
    const first = runtime.createSession({
      id: "first-session",
      agent: "a",
      client: makeClientSink(),
    });
    await first.start();
    first.report({ type: "user-transcript.committed", text: "my name is Ana" });
    first.report({ type: "agent-transcript.committed", text: "Nice to meet you, Ana." });
    await first.stop();

    expect(ended).toHaveLength(1);
    expect(ended[0]).toMatchObject({ sessionId: "first-session", clientId: client });
    expect(ended[0]?.lastEventIndex).toBeGreaterThan(0);

    // Session two: a FRESH connect (no resume), same device.
    setSessionClient("second-session", client);
    const sink = makeClientSink();
    const second = runtime.createSession({ id: "second-session", agent: "a", client: sink });
    await second.start();

    expect(sessionContext).toHaveBeenLastCalledWith(
      expect.objectContaining({ sessionId: "second-session", clientId: client }),
    );
    const restored = (sink.event as ReturnType<typeof vi.fn>).mock.calls
      .map(([e]) => e as SessionEvent)
      .find((e) => e.type === "history.restored");
    expect(restored).toMatchObject({
      messages: [
        // Session one's greeting is part of what it said.
        { role: "assistant", content: "Hello!" },
        { role: "user", content: "my name is Ana" },
        { role: "assistant", content: "Nice to meet you, Ana." },
      ],
    });

    // And the model sees both: the prior turns, and the context block.
    expect(second.announce("Greet them by name.")).toBe(true);
    await vi.waitFor(() => expect(llm.calls.length).toBeGreaterThan(0));
    const request = JSON.stringify(llm.calls.at(-1));
    expect(request).toContain("Household: the Riveras.");
    expect(request).toContain("my name is Ana");
    await second.stop();
    await runtime.shutdown();
  });

  test("a session that named no client is seeded with nothing", async () => {
    const { runtime } = runtimeFor({});
    const sink = makeClientSink();
    const session = runtime.createSession({ id: "anonymous-session", agent: "a", client: sink });
    await session.start();
    const types = (sink.event as ReturnType<typeof vi.fn>).mock.calls.map(
      ([e]) => (e as SessionEvent).type,
    );
    expect(types).not.toContain("history.restored");
    await session.stop();
    await runtime.shutdown();
  });
});
