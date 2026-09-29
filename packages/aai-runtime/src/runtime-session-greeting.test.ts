// Copyright 2026 the AAI authors. MIT license.
/**
 * `sessionContext`'s `greeting`, end to end through a real runtime: the line
 * the app answered for ONE session is the one spoken, instead of the agent's.
 *
 * The ordering is the substance. The transport is built before `start()`, and
 * `sessionContext` answers INSIDE `start()` — so these specs are what show the
 * transport read the answer late (a thunk, resolved when the greeting fires)
 * rather than the agent's line at construction. Over fake pipeline providers,
 * where what reached TTS and what the next model request carries are both
 * observable; the AssemblyAI S2S branch, which sends its greeting in
 * `session.update`, has its own spec at the end.
 */

import type { AgentDef, SessionContext } from "@alexkroman1/aai";
import { sleep } from "@alexkroman1/aai/internal";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { afterEach, describe, expect, test, vi } from "vitest";
import {
  createFakeLanguageModel,
  createFakeSttProvider,
  createFakeTtsProvider,
  FAKE_STT_API_KEY_ENV,
  FAKE_TTS_API_KEY_ENV,
  registerFakeProviders,
} from "./_pipeline-test-fakes.ts";
import { makeAgent, makeClientSink, makeMockHandle, silentLogger, tick } from "./_test-utils.ts";
import { createRuntimeWithSeams } from "./runtime.ts";
import { MAX_SESSION_GREETING_CHARS, SESSION_CONTEXT_TIMEOUT_MS } from "./session-context.ts";
import { _internals } from "./transports/s2s-transport.ts";

const AGENT_GREETING = "Hello there.";
const CALL_GREETING = "Hi, this is an AI assistant calling on behalf of Sam. Do you have a moment?";

let unregister: (() => void) | undefined;
afterEach(() => {
  unregister?.();
  unregister = undefined;
  vi.useRealTimers();
});

/** A pipeline session of an agent greeting {@link AGENT_GREETING}, started. */
async function startSession(
  sessionContext: AgentDef["sessionContext"],
  opts: { skipGreeting?: boolean; advanceMs?: number } = {},
) {
  const stt = createFakeSttProvider();
  const tts = createFakeTtsProvider();
  const llm = createFakeLanguageModel({ script: [{ type: "text", text: "Sure." }] });
  const fakes = registerFakeProviders({ stt, tts, llm });
  unregister = fakes.unregister;
  const client = makeClientSink();
  const runtime = createRuntimeWithSeams({
    agent: makeAgent({ greeting: AGENT_GREETING, ...omitUndefined({ sessionContext }) }),
    env: { ...fakes.env, [FAKE_STT_API_KEY_ENV]: "stt-key", [FAKE_TTS_API_KEY_ENV]: "tts-key" },
    logger: silentLogger,
    stt: fakes.stt,
    llm: fakes.llm,
    tts: fakes.tts,
  });
  const session = runtime.createSession({
    id: `greet-${Math.random().toString(36).slice(2)}`,
    agent: "test-agent",
    client,
    ...omitUndefined({ skipGreeting: opts.skipGreeting }),
  });
  const started = session.start();
  if (opts.advanceMs !== undefined) await vi.advanceTimersByTimeAsync(opts.advanceMs);
  await started;
  /** Everything TTS was asked to synthesize, joined. */
  const spoken = (): string => tts.sessions.flatMap((s) => s.textChunks).join("");
  /** The `agent-transcript.committed` texts the client was sent. */
  const committed = (): string[] =>
    vi
      .mocked(client.event)
      .mock.calls.map(([event]) => event)
      .flatMap((e) => (e.type === "agent-transcript.committed" ? [e.text] : []));
  return { session, stt, llm, spoken, committed };
}

/** Let a greeting that is going to fire, fire. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) await tick();
}

describe("sessionContext greeting, through the runtime (pipeline)", () => {
  test("the answered greeting is spoken instead of the agent's, with no model call, and recorded", async () => {
    const s = await startSession(() => ({ greeting: CALL_GREETING }));
    await vi.waitFor(() => {
      expect(s.committed()).toEqual([CALL_GREETING]);
    });
    expect(s.spoken()).toBe(CALL_GREETING);
    expect(s.spoken()).not.toContain(AGENT_GREETING);
    // Synthesized as written: nothing asked the model to say it.
    expect(s.llm.calls).toHaveLength(0);

    // Recorded as the agent's opening line: the first real turn's request
    // carries it as an assistant message.
    s.stt.last()?.fireFinal("yes, go ahead");
    await vi.waitFor(() => {
      expect(s.llm.calls).toHaveLength(1);
    });
    expect(JSON.stringify(s.llm.calls[0])).toContain(CALL_GREETING);
    await s.session.stop();
  });

  test('an empty greeting means no greeting this session, not "the agent\'s"', async () => {
    const s = await startSession(() => ({ greeting: "" }));
    await settle();
    expect(s.spoken()).toBe("");
    expect(s.committed()).toEqual([]);
    await s.session.stop();
  });

  test("an answer without a greeting keeps the agent's", async () => {
    const s = await startSession(() => ({ instructions: "The caller is Sam." }));
    await vi.waitFor(() => {
      expect(s.committed()).toEqual([AGENT_GREETING]);
    });
    await s.session.stop();
  });

  test("a resume still skips it — the greeting replaces the text, never the decision", async () => {
    const hook = vi.fn((): SessionContext => ({ greeting: CALL_GREETING }));
    const s = await startSession(hook, { skipGreeting: true });
    await settle();
    expect(hook).toHaveBeenCalledOnce();
    expect(s.spoken()).toBe("");
    expect(s.committed()).toEqual([]);
    await s.session.stop();
  });

  test("control characters become spaces and an over-long greeting is cut at the cap", async () => {
    const s = await startSession(() => ({
      greeting: `\u0007Hi\nSam.\u001b ${"a".repeat(MAX_SESSION_GREETING_CHARS * 2)}`,
    }));
    await vi.waitFor(() => {
      expect(s.committed()).toHaveLength(1);
    });
    const [line] = s.committed();
    expect(line?.startsWith("Hi Sam.")).toBe(true);
    expect(line).toHaveLength(MAX_SESSION_GREETING_CHARS);
    expect(line).not.toMatch(/\p{Cc}/u);
    expect(s.spoken()).toBe(line);
    await s.session.stop();
  });

  test("a sessionContext slower than its deadline falls back to the agent's greeting", async () => {
    vi.useFakeTimers();
    const late = SESSION_CONTEXT_TIMEOUT_MS * 2;
    const s = await startSession(
      async (): Promise<SessionContext> => {
        await sleep(late);
        return { greeting: CALL_GREETING };
      },
      { advanceMs: SESSION_CONTEXT_TIMEOUT_MS },
    );
    await vi.waitFor(() => {
      expect(s.committed()).toEqual([AGENT_GREETING]);
    });
    // The answer that lands after the deadline is dropped, not spoken later.
    await vi.advanceTimersByTimeAsync(late);
    expect(s.spoken()).not.toContain(CALL_GREETING);
    await s.session.stop();
  });
});

describe("sessionContext greeting, through the runtime (AssemblyAI S2S)", () => {
  test("the answered greeting is the one sent in session.update", async () => {
    const handle = makeMockHandle();
    vi.spyOn(_internals, "connectS2s").mockResolvedValue(handle);
    const runtime = createRuntimeWithSeams({
      agent: makeAgent({ sessionContext: () => ({ greeting: CALL_GREETING }) }),
      env: {},
      logger: silentLogger,
    });
    const session = runtime.createSession({
      id: "s2s-greet",
      agent: "test-agent",
      client: makeClientSink(),
    });
    await session.start();
    expect(handle.updateSession).toHaveBeenCalledWith(
      expect.objectContaining({ greeting: CALL_GREETING }),
    );
    await session.stop();
  });
});
