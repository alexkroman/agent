import { afterEach, describe, expect, test, vi } from "vitest";
import {
  flush,
  loadFixture,
  makeClient,
  makeMockHandle,
  makeSessionOpts,
  replayFixtureMessages,
} from "./_test-utils.ts";
import { _internals, createS2sSession, type S2sSessionOptions } from "./session.ts";

// ─── Session-level fixture replay tests ─────────────────────────────────────
//
// These replay real AssemblyAI S2S messages (recorded with Kokoro TTS audio)
// through the full session orchestration layer — the same setupListeners /
// handleToolCall / handleReplyDone code path that production uses.

describe("fixture replay through session", () => {
  let connectSpy: ReturnType<typeof vi.spyOn>;

  function setupReplay(overrides?: Partial<S2sSessionOptions>) {
    const mockHandle = makeMockHandle();
    connectSpy = vi.spyOn(_internals, "connectS2s").mockResolvedValue(mockHandle);
    const client = makeClient();
    const opts = makeSessionOpts({ client, ...overrides });
    const session = createS2sSession(opts);
    return { session, client, mockHandle, opts };
  }

  afterEach(() => {
    connectSpy?.mockRestore();
  });

  test("greeting session: client receives speech events and chat messages", async () => {
    const { session, client, mockHandle } = setupReplay();
    await session.start();

    const messages = loadFixture("greeting-session-sequence.json");
    replayFixtureMessages(mockHandle, messages);

    // Client should have received speech_started/stopped for the greeting
    const types = client.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("agent_transcript"); // final agent transcript
    expect(types).toContain("reply_done"); // reply completed
  });

  test("simple question: user transcript builds conversation history", async () => {
    const { session, client, mockHandle } = setupReplay();
    await session.start();

    const messages = loadFixture("simple-question-sequence.json");
    replayFixtureMessages(mockHandle, messages);
    await flush();

    // Client should see both greeting and answer as final agent_transcript events
    const chatEvents = client.events.filter(
      (e) =>
        (e as { type: string }).type === "agent_transcript" &&
        (e as { isFinal: boolean }).isFinal === true,
    );
    expect(chatEvents.length).toBe(2); // greeting + answer
  });

  test("tool call: session executes tool, buffers result, sends after replyDone", async () => {
    const executeTool = vi.fn(async () =>
      JSON.stringify({ city: "San Francisco", temperature: "72°F", condition: "sunny" }),
    );

    const { session, client, mockHandle } = setupReplay({ executeTool });
    await session.start();

    const messages = loadFixture("tool-call-sequence.json");
    replayFixtureMessages(mockHandle, messages);

    // Wait for tool execution to complete
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    await session.waitForTurn();

    // Tool was called with the right name and args
    expect(executeTool).toHaveBeenCalledWith(
      "get_weather",
      expect.objectContaining({ city: "San Francisco" }),
      expect.any(String), // session ID
      expect.any(Array), // messages
    );

    // Client received tool_call and tool_call_done events
    const toolStart = client.events.find((e) => (e as { type: string }).type === "tool_call") as
      | { toolName: string; args: Record<string, unknown> }
      | undefined;
    expect(toolStart).toBeDefined();
    expect(toolStart?.toolName).toBe("get_weather");

    const toolDone = client.events.find((e) => (e as { type: string }).type === "tool_call_done") as
      | { result: string }
      | undefined;
    expect(toolDone).toBeDefined();

    // Tool result was sent back to S2S after replyDone
    await vi.waitFor(() => expect(mockHandle.sendToolResult).toHaveBeenCalled());
  });

  test("tool call: conversation messages accumulate correctly", async () => {
    const executeTool = vi.fn(async () => JSON.stringify({ result: "ok" }));
    const { session, mockHandle } = setupReplay({ executeTool });
    await session.start();

    const messages = loadFixture("tool-call-sequence.json");
    replayFixtureMessages(mockHandle, messages);
    await vi.waitFor(() => expect(executeTool).toHaveBeenCalled());
    await session.waitForTurn();

    // The conversation messages passed to executeTool should include
    // the user's transcript (from STT recognition of Kokoro audio)
    const call = executeTool.mock.calls[0] as unknown as [
      string,
      unknown,
      string,
      { role: string; content: string }[],
    ];
    const userMsg = call[3]?.find((m) => m.role === "user");
    expect(userMsg?.content.toLowerCase()).toContain("weather");
  });

  test("user speech recognition events reach the client", async () => {
    const { session, client, mockHandle } = setupReplay();
    await session.start();

    const messages = loadFixture("user-speech-recognition.json");
    replayFixtureMessages(mockHandle, messages);
    await flush();

    const types = client.events.map((e) => (e as { type: string }).type);
    expect(types).toContain("speech_started");
    expect(types).toContain("speech_stopped");
    expect(types).toContain("user_transcript"); // triggers orchestration
  });
});
