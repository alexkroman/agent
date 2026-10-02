// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom
/**
 * `useConversationLog` over a mock session: the live session is logged as it
 * grows and persisted, a reload reads it back, notes and spoken lines go in
 * order, the client's OTHER sessions are mirrored from inbox frames while the
 * page's own is skipped — and `<ConversationView log>` renders all of it with
 * the kit's own slots.
 */

import { act, render, renderHook, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, test } from "vitest";
import { createMockSessionCore } from "./_react-test-utils.ts";
import { ConversationView } from "./components/conversation-view.tsx";
import { SessionProvider } from "./context.ts";
import type { ChatMessage } from "./types.ts";
import { useConversationLog } from "./use-conversation-log.ts";

const KEY = "test:log";
let sid: string | undefined;

function setup() {
  const core = createMockSessionCore(
    { running: true },
    { sessionId: () => sid, clientId: () => "browser-1" },
  );
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SessionProvider value={core}>{children}</SessionProvider>
  );
  const hook = renderHook(() => useConversationLog({ storageKey: KEY }), { wrapper });
  return { core, hook, wrapper };
}

const msg = (id: number, role: ChatMessage["role"], content: string): ChatMessage => ({
  id,
  role,
  content,
});
const frame = (sessionId: string, event: { type: string } & Record<string, unknown>) =>
  ({ type: "session_event", sessionId, event }) as const;

beforeEach(() => {
  localStorage.clear();
  sid = undefined;
});

describe("useConversationLog", () => {
  test("logs the live session as it grows, persists it, and reads it back on reload", () => {
    const { core, hook } = setup();
    act(() => {
      sid = "s1";
      core.update({ messages: [msg(0, "user", "hi")] });
    });
    act(() => core.update({ messages: [msg(0, "user", "hi"), msg(1, "assistant", "hello")] }));
    expect(hook.result.current.entries).toHaveLength(1);
    expect(hook.result.current.entries[0]).toMatchObject({
      kind: "session",
      sessionId: "s1",
      clientId: "browser-1",
    });
    expect(JSON.parse(localStorage.getItem(KEY) ?? "[]")).toHaveLength(1);

    const again = setup();
    expect(again.hook.result.current.entries).toEqual(hook.result.current.entries);
  });

  test("notes and spoken lines go in the order they happened; clear forgets everything", () => {
    const { hook } = setup();
    act(() => hook.result.current.addNote("New session"));
    act(() => hook.result.current.addSpoken("Your timer is done."));
    expect(hook.result.current.entries.map((e) => e.kind)).toEqual(["note", "spoken"]);
    act(() => hook.result.current.clear());
    expect(hook.result.current.entries).toEqual([]);
    expect(localStorage.getItem(KEY)).toBe("[]");
  });

  test("mirrors another session of the client, skipping the page's own", () => {
    const { core, hook } = setup();
    act(() => {
      sid = "mine";
      core.update({ contentVersion: 1 });
    });
    act(() =>
      hook.result.current.mirror(frame("mine", { type: "userTranscript.committed", text: "x" })),
    );
    expect(hook.result.current.entries).toEqual([]);

    act(() =>
      hook.result.current.mirror(
        frame("speaker", { type: "userTranscript.committed", text: "lights off" }),
      ),
    );
    act(() =>
      hook.result.current.mirror(
        frame("speaker", { type: "tool.called", toolCallId: "t", toolName: "lights", args: {} }),
      ),
    );
    act(() =>
      hook.result.current.mirror(frame("speaker", { type: "tool.completed", toolCallId: "t" })),
    );
    act(() =>
      hook.result.current.mirror(frame("speaker", { type: "userTranscript.updated", text: "th" })),
    );
    const [entry] = hook.result.current.entries;
    expect(entry).toMatchObject({ kind: "session", sessionId: "speaker" });
    expect(entry?.kind === "session" && entry.items).toMatchObject([
      { kind: "message", message: { content: "lights off" } },
      { kind: "tool", toolCall: { name: "lights", status: "done" } },
    ]);
  });
});

describe("<ConversationView log>", () => {
  test("renders notes, spoken lines, session headers and items instead of the live items", () => {
    const { core, hook, wrapper } = setup();
    act(() => {
      sid = "s1";
      core.update({ messages: [msg(0, "user", "hi"), msg(1, "assistant", "hello")] });
    });
    act(() => hook.result.current.addNote("Continuing"));
    act(() => hook.result.current.addSpoken("Reminder: plants"));
    const entries = hook.result.current.entries;
    render(
      <ConversationView
        log={entries}
        renderMessage={(m) => <p>{`${m.role}:${m.content}`}</p>}
        renderSessionHeader={(e) => <h3>{`session ${e.sessionId}`}</h3>}
        empty={<p>nothing yet</p>}
      />,
      { wrapper },
    );
    expect(screen.getByText("session s1")).toBeInTheDocument();
    // Once each: the log carries the live session, which is not rendered twice.
    expect(screen.getAllByText("user:hi")).toHaveLength(1);
    expect(screen.getByText("Continuing")).toBeInTheDocument();
    expect(screen.getByText("assistant:Reminder: plants")).toBeInTheDocument();
    expect(screen.queryByText("nothing yet")).toBeNull();
  });

  test("an empty log shows the empty state even while the live session has items", () => {
    const { core, wrapper } = setup();
    act(() => core.update({ messages: [msg(0, "user", "live only")] }));
    render(
      <ConversationView
        log={[]}
        renderMessage={(m) => <p>{m.content}</p>}
        empty={<p>nothing yet</p>}
      />,
      { wrapper },
    );
    expect(screen.getByText("nothing yet")).toBeInTheDocument();
    expect(screen.queryByText("live only")).toBeNull();
  });
});
