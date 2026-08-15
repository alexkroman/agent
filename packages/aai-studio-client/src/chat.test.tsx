// Copyright 2026 the AAI authors. MIT license.
// toBlocks owns React key stability for streamed messages — a key collision
// makes tool rows swap expanded/collapsed state mid-stream. The pre-project
// states (hero prompt box, status unknown vs. no key) live in home.test.tsx.

import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ChatPanel } from "./chat.tsx";
import { notifyDispatch } from "./chat-notify.ts";
import { Composer } from "./composer.tsx";
import { toBlocks } from "./tool-row.tsx";

function message(parts: Record<string, unknown>[]): UIMessage {
  return { id: "m1", role: "assistant", parts } as UIMessage;
}

describe("toBlocks", () => {
  test("merges consecutive text parts into one block", () => {
    const blocks = toBlocks(
      message([
        { type: "text", text: "Hello " },
        { type: "text", text: "world" },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "text", text: "Hello world" });
  });

  test("merges text runs across skipped parts (step-start, reasoning)", () => {
    const blocks = toBlocks(
      message([
        { type: "text", text: "before" },
        { type: "step-start" },
        { type: "reasoning", text: "hidden" },
        { type: "text", text: " after" },
      ]),
    );
    expect(blocks).toHaveLength(1);
    expect(blocks[0]).toMatchObject({ kind: "text", text: "before after" });
  });

  test("keys tool blocks on toolCallId and text runs on the tool they follow", () => {
    const blocks = toBlocks(
      message([
        { type: "text", text: "lead" },
        { type: "tool-read_file", toolCallId: "call-1", state: "output-available" },
        { type: "text", text: "tail" },
      ]),
    );
    expect(blocks.map((b) => b.key)).toEqual(["text-lead", "call-1", "text-call-1"]);
  });

  test("recognizes dynamic-tool parts as tool blocks", () => {
    const blocks = toBlocks(
      message([{ type: "dynamic-tool", toolName: "web_search", toolCallId: "call-9" }]),
    );
    expect(blocks).toEqual([expect.objectContaining({ kind: "tool", key: "call-9" })]);
  });

  test("keys never collide, even for tool parts with no toolCallId", () => {
    const blocks = toBlocks(
      message([
        { type: "tool-a" },
        { type: "text", text: "between" },
        { type: "tool-b" },
        { type: "text", text: "end" },
      ]),
    );
    const keys = blocks.map((b) => b.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

const noop = (): void => undefined;

describe("Composer", () => {
  const composerProps = {
    disabled: false,
    placeholder: "p",
    value: "",
    onValueChange: noop,
    onSend: noop,
  };

  test("idle: shows an enabled Send button and no Stop", () => {
    const html = renderToStaticMarkup(<Composer {...composerProps} />);
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop"');
  });

  test("while a turn streams, the button becomes an enabled Stop", () => {
    // The whole point of the stop button: a hung turn used to leave the
    // composer with nothing to click.
    const html = renderToStaticMarkup(<Composer {...composerProps} busy={true} onStop={noop} />);
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Send"');
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("the input stays live while a turn streams, so a follow-up can be queued", () => {
    // It used to be disabled, which silently swallowed anything typed
    // mid-turn — the whole reason the queue exists.
    const html = renderToStaticMarkup(<Composer {...composerProps} busy={true} onStop={noop} />);
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=/);
  });

  test("the LLM being down is what disables the composer", () => {
    const html = renderToStaticMarkup(<Composer {...composerProps} disabled={true} />);
    expect(html).toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*\sdisabled=/);
  });

  test("a sandbox still starting holds the send button but leaves the field live", () => {
    // Distinct from `disabled`: the wait is finite, so the message can be
    // written while it runs out. Only sending waits.
    const html = renderToStaticMarkup(<Composer {...composerProps} sendDisabled={true} />);
    expect(html).not.toMatch(/<textarea[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*\sdisabled=/);
  });

  test("queued follow-ups render with a per-message dismiss", () => {
    const html = renderToStaticMarkup(
      <Composer
        {...composerProps}
        busy={true}
        onStop={noop}
        queued={[
          { id: "q0", text: "add tests" },
          { id: "q1", text: "fix lint" },
        ]}
      />,
    );
    expect(html).toContain("add tests");
    expect(html).toContain("fix lint");
    expect(html).toContain('aria-label="Remove queued message 1"');
    expect(html).toContain('aria-label="Remove queued message 2"');
  });
});

describe("ChatPanel session failure", () => {
  const panelProps = {
    chatHistory: [] as UIMessage[],
    chatStatus: { provider: "assemblyai", model: "gpt-5.5" },
    chatSession: undefined,
    onSessionStale: () => Promise.resolve(undefined),
    initialPrompt: null,
    onInitialPromptSent: noop,
    onWorkspaceChanged: noop,
  };

  test("shows the server's reason, not just the generic line", () => {
    // The platform answers a sandbox that would not start with a 503 whose
    // body says why (capacity, boot timeout). Dropping it left every failure
    // reading as "Could not start the project's sandbox." — the one string
    // that tells the user nothing about whether retrying will help.
    const html = renderToStaticMarkup(
      <ChatPanel {...panelProps} sessionError={new Error("the platform is at capacity")} />,
    );
    expect(html).toContain("Could not start the project&#x27;s sandbox.");
    expect(html).toContain("the platform is at capacity");
    expect(html).toContain("Try again");
  });

  test("no error means the booting state, not the failure state", () => {
    const html = renderToStaticMarkup(<ChatPanel {...panelProps} sessionError={null} />);
    expect(html).toContain("Starting sandbox…");
    expect(html).not.toContain("Try again");
  });

  test("the restored conversation stays up through both", () => {
    // A sandbox that is booting — or that refused to — says nothing about the
    // transcript, which loaded from a different request and reads fine
    // without one. Replacing it threw away the only thing that had arrived.
    const history = [
      { id: "m1", role: "user", parts: [{ type: "text", text: "build a pizza bot" }] },
    ] as UIMessage[];
    const booting = renderToStaticMarkup(
      <ChatPanel {...panelProps} chatHistory={history} sessionError={null} />,
    );
    expect(booting).toContain("build a pizza bot");
    expect(booting).toContain("Starting sandbox…");

    const failed = renderToStaticMarkup(
      <ChatPanel {...panelProps} chatHistory={history} sessionError={new Error("at capacity")} />,
    );
    expect(failed).toContain("build a pizza bot");
    expect(failed).toContain("Try again");
  });

  test("a conversation that has not loaded yet has nothing to show but the wait", () => {
    // The one state with no transcript to hold: the history request is still
    // in flight, so the panel must not claim the conversation is empty.
    const html = renderToStaticMarkup(
      <ChatPanel {...panelProps} chatHistory={undefined} sessionError={null} />,
    );
    expect(html).toContain("Loading conversation…");
    expect(html).not.toContain("Welcome to AssemblyAI Build");
  });
});

describe("notifyDispatch", () => {
  const ready = { busy: false, chatReady: true };

  test("a plain note is appended, never a turn", () => {
    // Publish success and secret changes: visible in the transcript and
    // carried into the next turn, but not worth spending a turn on.
    expect(notifyDispatch(undefined, ready)).toBe("append");
    expect(notifyDispatch({}, ready)).toBe("append");
    expect(notifyDispatch({ respond: false }, ready)).toBe("append");
  });

  test("respond runs a turn so the agent engages with a failed publish", () => {
    expect(notifyDispatch({ respond: true }, ready)).toBe("turn");
  });

  test("a busy chat DEFERS — appending mid-turn corrupts the transcript", () => {
    // The regression this replaced: `"append"` was chosen as the safe fallback
    // for a turn in flight, and it is the one case where it is not. The SDK's
    // streaming writer compares its message id against `lastMessage`, so a note
    // pushed underneath a streaming message makes the NEXT chunk push the
    // assistant message a second time — one object at two indices under one
    // React key, in the array that gets persisted.
    expect(notifyDispatch({ respond: true }, { busy: true, chatReady: true })).toBe("defer");
    expect(notifyDispatch(undefined, { busy: true, chatReady: true })).toBe("defer");
    expect(notifyDispatch({ respond: true }, { busy: true, chatReady: false })).toBe("defer");
  });

  test("an LLM that isn't up appends rather than dropping the message", () => {
    // Nothing is streaming, so the transcript is safe to write to — and a
    // publish failure still reaches the agent on its next turn.
    expect(notifyDispatch({ respond: true }, { busy: false, chatReady: false })).toBe("append");
  });
});
