// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// H7: a note appended into the transcript WHILE a turn streams corrupts it —
// the SDK pushes the streaming message a second time rather than replacing it,
// leaving one object at two indices under one React key, and that array is what
// the end-of-turn sync persists. So the busy case must not reach the transcript
// at all; it waits for the settle.

import { act, renderHook } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import type { NotifyChat } from "./chat-notify.ts";
import { useNotifyRegistration } from "./use-notify-registration.ts";

type Harness = {
  notify: NotifyChat;
  appendMessage: ReturnType<typeof vi.fn>;
  sendMessage: ReturnType<typeof vi.fn>;
  rerender: (props: { pending: boolean }) => void;
};

function harness(initialPending = false): Harness {
  const appendMessage = vi.fn();
  const sendMessage = vi.fn();
  let registered: NotifyChat | null = null;
  const { rerender } = renderHook(
    ({ pending }: { pending: boolean }) =>
      useNotifyRegistration({
        registerNotify: (fn) => {
          registered = fn;
        },
        pending,
        chatReady: true,
        sendMessage,
        appendMessage,
      }),
    { initialProps: { pending: initialPending } },
  );
  return {
    notify: (text, opts) => act(() => registered?.(text, opts)),
    appendMessage,
    sendMessage,
    rerender,
  };
}

describe("useNotifyRegistration", () => {
  test("an idle chat takes a plain note straight into the transcript", () => {
    const h = harness();
    h.notify("published fine");
    expect(h.appendMessage).toHaveBeenCalledWith("published fine");
    expect(h.sendMessage).not.toHaveBeenCalled();
  });

  test("an idle chat runs a respond note as its own turn", () => {
    const h = harness();
    h.notify("deploy failed", { respond: true });
    expect(h.sendMessage).toHaveBeenCalledWith({ text: "deploy failed" });
    expect(h.appendMessage).not.toHaveBeenCalled();
  });

  test("a note that arrives mid-turn touches NOTHING until the turn settles", () => {
    const h = harness(true);
    h.notify("I set the secret OPENAI_API_KEY");
    // The whole bug in one assertion: this must not reach `setMessages`.
    expect(h.appendMessage).not.toHaveBeenCalled();
    expect(h.sendMessage).not.toHaveBeenCalled();

    act(() => h.rerender({ pending: false }));
    expect(h.appendMessage).toHaveBeenCalledWith("I set the secret OPENAI_API_KEY");
  });

  test("a deferred respond note becomes a real turn on the settle", () => {
    const h = harness(true);
    h.notify("deploy failed", { respond: true });
    act(() => h.rerender({ pending: false }));
    expect(h.sendMessage).toHaveBeenCalledWith({ text: "deploy failed" });
  });

  test("deferred notes are delivered in order, one per settle", () => {
    const h = harness(true);
    h.notify("first");
    h.notify("second");
    act(() => h.rerender({ pending: false }));
    // Both land: the first flush drops the head, and that state change is what
    // re-runs the flush for the next one.
    expect(h.appendMessage.mock.calls.map((c) => c[0])).toEqual(["first", "second"]);
  });

  test("at most one deferred note becomes a turn — the rest append", () => {
    // Two `sendMessage` calls in one window would run two turns against one
    // guest session, which is what chat-queue.ts exists to prevent. Degrading
    // to an append loses nothing: the message rides the turn just started.
    const h = harness(true);
    h.notify("deploy failed", { respond: true });
    h.notify("and this one too", { respond: true });
    act(() => h.rerender({ pending: false }));
    expect(h.sendMessage).toHaveBeenCalledTimes(1);
    expect(h.sendMessage).toHaveBeenCalledWith({ text: "deploy failed" });
    expect(h.appendMessage).toHaveBeenCalledWith("and this one too");
  });
});
