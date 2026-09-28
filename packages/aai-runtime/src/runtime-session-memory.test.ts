// Copyright 2026 the AAI authors. MIT license.

import { type SessionEndContext, sessionClientLocation } from "@alexkroman1/aai";
import { setSessionClient, setSessionLocation } from "@alexkroman1/aai/host-internal";
import { createStubWorkflows } from "@alexkroman1/aai/testing";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { openSessionMemory } from "./runtime-session-memory.ts";
import { bindClientSession } from "./session-client-history.ts";
import { createSessionEventStream } from "./session-event-stream.ts";
import { createMemoryStateBackend } from "./session-state/store.ts";

/** A fresh session id per case: the client map it reads is process-global. */
let n = 0;
const nextSid = () => `memory-spec-${process.pid}-${n++}`;

function wire(agent: Parameters<typeof openSessionMemory>[0]["agent"] = {}) {
  const backend = createMemoryStateBackend();
  const stream = createSessionEventStream({ backend });
  const logger = makeLogger();
  const prompt = { setContext: vi.fn<(text: string) => void>() };
  const sessionId = nextSid();
  const history = { backend, stream, logger };
  const memory = openSessionMemory({
    agent,
    env: { MEMORY_URL: "http://memory" },
    workflows: undefined,
    history,
    prompt,
    sessionId,
    logger,
  });
  return { backend, stream, logger, prompt, sessionId, history, memory };
}

describe("openSessionMemory", () => {
  test("a session that named no client binds nothing, loads nothing, but is still asked for context", async () => {
    const sessionContext = vi.fn(() => ({ instructions: "Be brief." }));
    const { memory, prompt, backend } = wire({ sessionContext });

    expect(await memory.open()).toEqual([]);

    expect(sessionContext).toHaveBeenCalledWith(
      expect.not.objectContaining({ clientId: expect.anything() }),
    );
    expect(prompt.setContext).toHaveBeenCalledWith("Be brief.");
    expect(await backend.clientSessions?.("anyone", { limit: 10 })).toEqual([]);
  });

  test("a client's session is BOUND, told its client, and seeded with its client's prior sessions", async () => {
    const sessionContext = vi.fn(() => undefined);
    const { memory, backend, stream, sessionId, history } = wire({ sessionContext });
    // A previous session of the same speaker.
    await bindClientSession(history, "earlier", "porch");
    stream.append("earlier", { type: "user-transcript.committed", text: "remind me at six" });
    await stream.flush("earlier");
    setSessionClient(sessionId, "porch");

    const prior = await memory.open();

    expect(prior.map((e) => e.type)).toEqual(["user-transcript.committed"]);
    expect(sessionContext).toHaveBeenCalledWith(expect.objectContaining({ clientId: "porch" }));
    const listed = await backend.clientSessions?.("porch", { limit: 10 });
    expect(listed?.map((s) => s.sessionId).sort()).toEqual(["earlier", sessionId].sort());
  });

  test("the context's `historySince` narrows what is loaded", async () => {
    const { memory, stream, sessionId, history } = wire({
      sessionContext: () => ({ historySince: Date.now() + 60_000 }),
    });
    await bindClientSession(history, "earlier", "porch");
    stream.append("earlier", { type: "user-transcript.committed", text: "summarized already" });
    await stream.flush("earlier");
    setSessionClient(sessionId, "porch");

    expect(await memory.open()).toEqual([]);
  });

  test("the context's `location` replaces the one the socket reported", async () => {
    const { memory, sessionId } = wire({
      sessionContext: () => ({ location: "2 App Ave, Springfield" }),
    });
    setSessionLocation(sessionId, "1 Device Rd, Springfield");
    await memory.open();
    expect(sessionClientLocation({ sessionId })).toBe("2 App Ave, Springfield");
  });

  test("onSessionEnd is told the session, its client, the last index and a workflow client", async () => {
    const onSessionEnd = vi.fn<(ctx: SessionEndContext) => unknown>();
    const { memory, sessionId } = wire({ onSessionEnd });
    setSessionClient(sessionId, "porch");

    memory.ended(7);

    const ctx = onSessionEnd.mock.calls[0]?.[0];
    expect(ctx).toMatchObject({
      sessionId,
      clientId: "porch",
      lastEventIndex: 7,
      env: { MEMORY_URL: "http://memory" },
    });
    // No workflows declared: the same rejecting client a tool would get.
    await expect(ctx?.workflows.start("memorize", {})).rejects.toThrow();
  });

  test("onSessionEnd gets the runtime's workflow client when there is one", () => {
    const onSessionEnd = vi.fn<(ctx: SessionEndContext) => unknown>();
    const workflows = createStubWorkflows();
    const backend = createMemoryStateBackend();
    const logger = makeLogger();
    const memory = openSessionMemory({
      agent: { onSessionEnd },
      env: {},
      workflows,
      history: { backend, stream: createSessionEventStream({ backend }) },
      prompt: { setContext: () => undefined },
      sessionId: nextSid(),
      logger,
    });
    memory.ended(-1);
    expect(onSessionEnd.mock.calls[0]?.[0].workflows).toBe(workflows);
  });

  test("a throwing or rejecting onSessionEnd is logged, never thrown", async () => {
    const thrower = wire({
      onSessionEnd: () => {
        throw new Error("boom");
      },
    });
    expect(() => thrower.memory.ended(0)).not.toThrow();
    expect(thrower.logger.warn).toHaveBeenCalledWith(
      "onSessionEnd failed",
      expect.objectContaining({ error: "boom" }),
    );

    const rejecter = wire({ onSessionEnd: () => Promise.reject(new Error("later")) });
    rejecter.memory.ended(0);
    await vi.waitFor(() =>
      expect(rejecter.logger.warn).toHaveBeenCalledWith(
        "onSessionEnd failed",
        expect.objectContaining({ error: "later" }),
      ),
    );
  });
});
