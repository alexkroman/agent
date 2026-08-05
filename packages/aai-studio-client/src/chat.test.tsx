// Copyright 2026 the AAI authors. MIT license.
// toBlocks owns React key stability for streamed messages — a key collision
// makes tool rows swap expanded/collapsed state mid-stream. The pre-project
// states (hero prompt box, status unknown vs. no key) live in home.test.tsx.

import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { Composer, notifyDispatch } from "./chat.tsx";
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

describe("notifyDispatch", () => {
  const ready = { busy: false, llmReady: true };

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

  test("falls back to appending rather than dropping the message", () => {
    // A turn mid-flight or an LLM that isn't up must not lose a publish
    // failure — an appended message still reaches the agent next turn.
    expect(notifyDispatch({ respond: true }, { busy: true, llmReady: true })).toBe("append");
    expect(notifyDispatch({ respond: true }, { busy: false, llmReady: false })).toBe("append");
  });
});
