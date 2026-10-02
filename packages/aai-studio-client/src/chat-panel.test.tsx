// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The queue driven through the REAL useChat and transport, because the whole
// risk lives in the SDK's timing: it has no queue of its own, and a second
// `sendMessage` while a turn is open starts a concurrent request rather than
// waiting. These tests assert on the requests that reach the sandbox — one at
// a time, in submit order — which is the only place that guarantee is visible.
// The ordering rules themselves are unit-tested in chat-queue.test.ts.

import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { userEvent } from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";
import { stubFetch } from "./_test-utils.ts";
import type { ChatSession } from "./api.ts";
import { ChatPanel } from "./panes/chat.tsx";

const SANDBOX_URL = "http://sandbox.test/studio/chat";

/** One controllable SSE turn: the guest's UI message stream, held open. */
function openTurn() {
  const encoder = new TextEncoder();
  let sink: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      sink = controller;
    },
  });
  const write = (chunk: object) => {
    sink?.enqueue(encoder.encode(`data: ${JSON.stringify(chunk)}\n\n`));
  };
  return {
    response: new Response(body, {
      status: 200,
      headers: { "content-type": "text/event-stream" },
    }),
    /** Stream a reply, but leave the turn open (no `finish`). */
    speak(text: string) {
      write({ type: "start" });
      write({ type: "text-start", id: "t1" });
      write({ type: "text-delta", id: "t1", delta: text });
      write({ type: "text-end", id: "t1" });
    },
    /** Settle the turn, as the guest does at the end of a reply. */
    finish() {
      write({ type: "finish" });
      sink?.close();
    },
    /** Break the stream mid-turn — an LLM error, or the sandbox dying. */
    fail() {
      sink?.error(new Error("stream broke"));
    },
  };
}

type Turn = ReturnType<typeof openTurn>;

/** Answer each chat POST with the next queued turn; record the sent messages. */
function stubChatTurns(count: number) {
  const pool = Array.from({ length: count }, () => openTurn());
  const sent: string[][] = [];
  let next = 0;
  const fetchMock = stubFetch((_input, init) => {
    const body = JSON.parse(String(init?.body)) as {
      messages: { role: string; parts: { type: string; text?: string }[] }[];
    };
    sent.push(
      body.messages
        .filter((m) => m.role === "user")
        .map((m) =>
          m.parts
            .filter((p) => p.type === "text")
            .map((p) => p.text ?? "")
            .join(""),
        ),
    );
    const turn = pool[next++];
    if (!turn) throw new Error(`unexpected chat request #${next}`);
    return turn.response;
  });
  /** The nth turn the sandbox will serve, 0-based. */
  const turn = (index: number): Turn => {
    const found = pool[index];
    if (!found) throw new Error(`no stubbed turn #${index}`);
    return found;
  };
  return { turn, sent, fetchMock };
}

function renderPanel(
  overrides: {
    onBusyChange?: (busy: boolean) => void;
    chatSession?: ChatSession;
    onSessionStale?: () => Promise<ChatSession | undefined>;
  } = {},
) {
  return render(
    <ChatPanel
      chatHistory={[]}
      chatStatus={{ provider: "assemblyai", model: "gpt-5.5" }}
      chatSession={overrides.chatSession ?? { url: SANDBOX_URL, token: "chat-token" }}
      toolLabels={{}}
      onSessionStale={overrides.onSessionStale ?? vi.fn()}
      initialPrompt={null}
      onInitialPromptSent={vi.fn()}
      onWorkspaceChanged={vi.fn()}
      onBusyChange={overrides.onBusyChange}
    />,
  );
}

function composer(): HTMLElement {
  return screen.getByPlaceholderText(/Describe your agent|Queue a follow-up/);
}

/** Type a message into the composer and send it with Enter. */
async function send(text: string): Promise<void> {
  await userEvent.type(composer(), `${text}{Enter}`);
}

describe("queued follow-ups", () => {
  test("a message typed mid-turn waits, then sends when the turn settles", async () => {
    const { turn, sent, fetchMock } = stubChatTurns(2);
    renderPanel();

    await send("build a greeter");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    turn(0).speak("on it");

    await send("also add tests");
    // Queued, not sent: the sandbox is still streaming the first turn.
    expect(await screen.findByLabelText("Queued messages")).toBeInTheDocument();
    expect(screen.getByText("also add tests")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);
    // The composer is cleared, so the next thought can be typed too.
    expect(composer()).toHaveValue("");

    turn(0).finish();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // The follow-up rides on the full conversation, and its row is gone.
    expect(sent[1]).toEqual(["build a greeter", "also add tests"]);
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
  });

  test("several follow-ups run one turn at a time, in submit order", async () => {
    const { turn, sent, fetchMock } = stubChatTurns(3);
    renderPanel();

    await send("first");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    turn(0).speak("working");
    await send("second");
    await send("third");
    expect(await screen.findByText("third")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledTimes(1);

    turn(0).finish();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // Only ONE of the two queued messages went out — the other is still shown.
    expect(sent[1]?.at(-1)).toBe("second");
    expect(screen.getByText("third")).toBeInTheDocument();

    turn(1).speak("still working");
    turn(1).finish();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(3));
    expect(sent[2]?.at(-1)).toBe("third");
    await waitFor(() => expect(screen.queryByLabelText("Queued messages")).toBeNull());
  });

  test("a queued message can be dismissed before it runs", async () => {
    const { turn, fetchMock } = stubChatTurns(1);
    renderPanel();

    await send("first");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    turn(0).speak("working");
    await send("never mind this");
    expect(await screen.findByText("never mind this")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Remove queued message 1"));
    await waitFor(() => expect(screen.queryByText("never mind this")).toBeNull());

    turn(0).finish();
    // Nothing left to flush: the stubbed transport would throw on a 2nd POST.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
  });

  test("Stop hands the queue back to the composer instead of running it", async () => {
    // An explicit interrupt must not start the next turn behind the user's
    // back — and must not eat what they typed while waiting either.
    const { turn, fetchMock } = stubChatTurns(1);
    renderPanel();

    await send("first");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    turn(0).speak("working");
    await send("queued one");
    await send("queued two");
    expect(await screen.findByText("queued two")).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText("Stop"));

    await waitFor(() => expect(composer()).toHaveValue("queued one\n\nqueued two"));
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a failed turn hands the queue back rather than parking it forever", async () => {
    // Every submit joins a non-empty queue, and an `error` status never flushes
    // — so a queue left parked on a failed turn wedges the composer for good.
    const { turn, fetchMock } = stubChatTurns(1);
    renderPanel();

    await send("first");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    turn(0).speak("working");
    await send("and then this");
    expect(await screen.findByText("and then this")).toBeInTheDocument();

    turn(0).fail();

    await waitFor(() => expect(composer()).toHaveValue("and then this"));
    expect(screen.queryByLabelText("Queued messages")).toBeNull();
    // Not auto-sent over the failure: the error is what the user needs to see.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  test("a sandbox that spun down is re-brokered and the message still lands", async () => {
    // The reported bug: type into a project whose sandbox had been idle-evicted
    // and the panel showed "Failed to fetch" — every retype too, because the
    // transport had captured the dead lease. Only a page reload fixed it.
    const live = openTurn();
    const dead: ChatSession = { url: "http://dead.sandbox.test/studio/chat", token: "dead-token" };
    const replacement: ChatSession = { url: SANDBOX_URL, token: "fresh-token" };
    const fetchMock = stubFetch((input) =>
      String(input).startsWith(dead.url)
        ? Promise.reject(new TypeError("Failed to fetch"))
        : live.response,
    );
    const onSessionStale = vi.fn(() => Promise.resolve(replacement));
    renderPanel({ chatSession: dead, onSessionStale });

    await send("build a greeter");

    // One request to the dead sandbox, one re-broker, one to the replacement.
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(onSessionStale).toHaveBeenCalledOnce();
    expect(String(fetchMock.mock.calls[1]?.[0])).toBe(replacement.url);

    live.speak("on it");
    live.finish();
    expect(await screen.findByText("on it")).toBeInTheDocument();
    // The user is never shown the failure the studio recovered from.
    expect(screen.queryByText(/Lost the connection/)).toBeNull();
  });

  test("the wait for a replacement sandbox says so, rather than 'Working…'", async () => {
    // A re-broker is a container boot: reporting it as the agent working is a
    // stall with no explanation, which is what sent people to the reload button.
    const live = openTurn();
    const dead: ChatSession = { url: "http://dead.sandbox.test/studio/chat", token: "dead-token" };
    stubFetch((input) =>
      String(input).startsWith(dead.url)
        ? Promise.reject(new TypeError("Failed to fetch"))
        : live.response,
    );
    const broker = Promise.withResolvers<ChatSession>();
    renderPanel({ chatSession: dead, onSessionStale: () => broker.promise });

    await send("build a greeter");

    expect(await screen.findByText("Restarting the sandbox…")).toBeInTheDocument();
    expect(screen.queryByText("Working…")).toBeNull();

    broker.resolve({ url: SANDBOX_URL, token: "fresh-token" });
    await waitFor(() => expect(screen.queryByText("Restarting the sandbox…")).toBeNull());
    expect(screen.getByText("Working…")).toBeInTheDocument();
  });

  test("Publish stays locked between queued turns", async () => {
    // The app gates Publish on this flag. It deploys the workspace written by
    // the END-OF-TURN sync, so the gap between two queued turns — a tree the
    // next follow-up is about to edit — must not read as idle.
    const onBusyChange = vi.fn();
    const { turn, fetchMock } = stubChatTurns(2);
    renderPanel({ onBusyChange });

    await send("first");
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    turn(0).speak("working");
    await send("second");
    expect(await screen.findByText("second")).toBeInTheDocument();

    onBusyChange.mockClear();
    turn(0).finish();
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(onBusyChange).not.toHaveBeenCalledWith(false);

    turn(1).speak("done");
    turn(1).finish();
    await waitFor(() => expect(onBusyChange).toHaveBeenCalledWith(false));
  });
});
