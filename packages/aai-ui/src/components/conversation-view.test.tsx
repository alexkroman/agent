// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * The skeleton's own decisions — the ones every custom chrome had re-derived
 * around `useConversation()` and the ones a render slot cannot get wrong for
 * it: the order of the rows, the empty-state guard, the keys, the announced
 * thinking row, where the transcript goes, and what each slot defaults to.
 * `integration.test.tsx` keeps covering the stock bubbles through
 * `<MessageList>`, which is built on this.
 */

import { render, screen } from "@testing-library/react";
import { act } from "react";
import { describe, expect, test, vi } from "vitest";
import { createMockSessionCore } from "../_react-test-utils.ts";
import { SessionProvider, ThemeProvider } from "../context.ts";
import type { ChatMessage, ToolCallInfo } from "../types.ts";
import { ConversationView, type ConversationViewProps } from "./conversation-view.tsx";

const MESSAGES: ChatMessage[] = [
  { id: 1, role: "user", content: "hello" },
  { id: 2, role: "assistant", content: "hi there" },
];
const TOOL: ToolCallInfo = {
  callId: "1",
  name: "web_search",
  args: {},
  status: "done",
  result: "{}",
  seq: 1,
  afterMessageId: 1,
};

const renderMessage = ({ role, content }: ChatMessage) => (
  <p data-role={role} data-testid="message">
    {content}
  </p>
);

function mount(
  overrides: Parameters<typeof createMockSessionCore>[0] = {},
  props: Partial<ConversationViewProps> = {},
) {
  const core = createMockSessionCore({ started: true, state: "ready", ...overrides });
  const view = render(
    <ThemeProvider>
      <SessionProvider value={core}>
        <div style={{ height: 200 }}>
          <ConversationView renderMessage={renderMessage} {...props} />
        </div>
      </SessionProvider>
    </ThemeProvider>,
  );
  return { core, view };
}

describe("ConversationView", () => {
  test("renders each message through the slot, in order", () => {
    mount({ messages: MESSAGES });
    expect(screen.getAllByTestId("message").map((p) => p.textContent)).toEqual([
      "hello",
      "hi there",
    ]);
  });

  test("interleaves a tool call after its anchor message, through the default compact row", () => {
    mount({ messages: MESSAGES, toolCalls: [TOOL] });
    const tool = screen.getByText("web_search");
    const [first, second] = screen.getAllByTestId("message");
    expect(
      (first as Node).compareDocumentPosition(tool) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    expect(
      tool.compareDocumentPosition(second as Node) & Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
    // The default row is `ToolCallRow variant="compact"`, and it sits at the
    // start of a flex column rather than stretching across it.
    expect(tool.closest(".self-start")).not.toBeNull();
  });

  test("a pending tool call shimmers in the default row", () => {
    mount({ messages: MESSAGES, toolCalls: [{ ...TOOL, status: "pending" }] });
    expect(screen.getByText("web_search").className).toContain("tool-shimmer");
  });

  test("`renderTool` replaces the default row", () => {
    mount(
      { messages: MESSAGES, toolCalls: [TOOL] },
      { renderTool: (call) => <code data-testid="tool">[{call.name}]</code> },
    );
    expect(screen.getByTestId("tool").textContent).toBe("[web_search]");
  });

  test("shows `empty` only while there is nothing at all — no items and no streaming text", () => {
    const empty = <p data-testid="empty">Standing by.</p>;
    mount({}, { empty });
    expect(screen.getByTestId("empty")).toBeDefined();

    mount({ messages: MESSAGES }, { empty });
    expect(screen.queryAllByTestId("empty")).toHaveLength(1); // the first mount's

    mount({ agentTranscript: "I am" }, { empty });
    expect(screen.queryAllByTestId("empty")).toHaveLength(1);
  });

  test("renders the streaming reply through `renderMessage` as a synthetic assistant message by default", () => {
    mount({ agentTranscript: "half a sen" });
    const row = screen.getByText("half a sen");
    expect(row.dataset.role).toBe("assistant");
  });

  test("`renderStreaming` takes the streaming text instead", () => {
    mount({ agentTranscript: "half a sen" }, { renderStreaming: (text) => <i>{text}…</i> });
    expect(screen.getByText("half a sen…").tagName).toBe("I");
    expect(screen.queryAllByTestId("message")).toHaveLength(0);
  });

  test("the thinking row is announced, labelled by `thinkingLabel`, and carries the indicator", () => {
    mount(
      { state: "thinking", messages: [MESSAGES[0] as ChatMessage] },
      {
        thinkingLabel: "Dispatch is thinking",
        thinkingIndicator: <b>…</b>,
        thinkingClassName: "px-3",
      },
    );
    const row = screen.getByRole("status", { name: "Dispatch is thinking" });
    expect(row.className).toBe("px-3");
    expect(row.querySelector("b")?.textContent).toBe("…");
  });

  test("the thinking row is `Thinking` with pulsing dots by default", () => {
    mount({ state: "thinking", messages: [MESSAGES[0] as ChatMessage] });
    const row = screen.getByRole("status", { name: "Thinking" });
    expect(row.textContent).toBe("· · ·");
  });

  test("obeys the suppression rule — no thinking row behind a pending tool call", () => {
    mount({
      state: "thinking",
      messages: [MESSAGES[0] as ChatMessage],
      toolCalls: [{ ...TOOL, status: "pending" }],
    });
    expect(screen.queryByRole("status")).toBeNull();
  });

  test('renders the transcript only while speaking, through the slot, with the placeholder for `""`', () => {
    const renderTranscript = vi.fn(({ text }: { text: string }) => (
      <em data-testid="transcript">{text}</em>
    ));
    const { core } = mount({ userTranscript: null }, { renderTranscript });
    expect(screen.queryByTestId("transcript")).toBeNull();
    expect(renderTranscript).not.toHaveBeenCalled();

    // `""` is speech detected with no words yet — the row exists from the first
    // sound, with the package's placeholder, not from the first word.
    act(() => core.update({ userTranscript: "" }));
    expect(screen.getByTestId("transcript").textContent).not.toBe("");

    act(() => core.update({ userTranscript: "hel" }));
    expect(screen.getByTestId("transcript").textContent).toBe("hel");
  });

  test("the default transcript row is a muted italic line", () => {
    mount({ userTranscript: "so far" });
    const row = screen.getByText("so far");
    expect(row.tagName).toBe("P");
    expect(row.className).toContain("italic");
  });

  test("`transcriptPosition` puts the row inside the scroll region by default, and after it when `below`", () => {
    const inline = mount({ userTranscript: "words" });
    const log = inline.view.container.querySelector("[role='log']") as HTMLElement;
    expect(log.contains(screen.getByText("words"))).toBe(true);

    inline.view.unmount();
    const below = mount({ userTranscript: "words" }, { transcriptPosition: "below" });
    const log2 = below.view.container.querySelector("[role='log']") as HTMLElement;
    const row = screen.getByText("words");
    expect(log2.contains(row)).toBe(false);
    expect(log2.compareDocumentPosition(row) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  test("inside the scroll region the order is rows, streaming, transcript, thinking", () => {
    mount({
      state: "thinking",
      messages: [MESSAGES[0] as ChatMessage],
      agentTranscript: "stream",
      userTranscript: "speech",
    });
    const positions = [
      screen.getByText("hello"),
      screen.getByText("stream"),
      screen.getByText("speech"),
      screen.getByRole("status"),
    ];
    for (let i = 1; i < positions.length; i++) {
      const previous = positions[i - 1] as Node;
      const current = positions[i] as Node;
      expect(
        previous.compareDocumentPosition(current) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    }
  });

  test("keeps a row's DOM element when the window slides, and a message and a tool cannot share a key", () => {
    // A tool call whose `callId` is the digits of a message id: the keys are
    // prefixed so React never sees the two as one slot.
    const { core } = mount({
      messages: MESSAGES,
      toolCalls: [{ ...TOOL, callId: "2", afterMessageId: 2 }],
    });
    const second = screen.getByText("hi there");
    expect(screen.getByText("web_search")).toBeDefined();
    act(() =>
      core.update({
        messages: [MESSAGES[1] as ChatMessage, { id: 3, role: "user", content: "again" }],
      }),
    );
    expect(screen.getByText("hi there")).toBe(second);
    expect(screen.getByText("again")).toBeDefined();
  });

  test("forwards the container classes and style to the scroll region", () => {
    const { view } = mount(
      {},
      {
        className: "ring-1",
        contentClassName: "p-4",
        scrollClassName: "aai-scroll overflow-y-auto",
        style: { background: "rgb(1, 2, 3)" },
      },
    );
    const log = view.container.querySelector("[role='log']") as HTMLElement;
    expect(log.className).toContain("ring-1");
    expect(log.style.background).toBe("rgb(1, 2, 3)");
    expect(view.container.querySelector(".aai-scroll")).not.toBeNull();
    expect(view.container.querySelector(".p-4")).not.toBeNull();
  });
});
