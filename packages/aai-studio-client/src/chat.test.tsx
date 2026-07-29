// Copyright 2026 the AAI authors. MIT license.
// toBlocks owns React key stability for streamed messages — a key collision
// makes tool rows swap expanded/collapsed state mid-stream. The ChatPanel
// tests pin the pre-project states (guided start, status unknown vs. no key).

import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ChatPanel, Composer, ModelPicker, toBlocks } from "./chat.tsx";

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

const panelProps = {
  apiKey: "k",
  project: null,
  creating: false,
  initialPrompt: null,
  onInitialPromptSent: noop,
  onStartWithPrompt: noop,
  onWorkspaceChanged: noop,
  onUnauthorized: noop,
};

describe("Composer", () => {
  const composerProps = { disabled: false, placeholder: "p", onSend: noop };

  test("idle: shows an enabled Send button and no Stop", () => {
    const html = renderToStaticMarkup(<Composer {...composerProps} />);
    expect(html).toContain('aria-label="Send"');
    expect(html).not.toContain('aria-label="Stop"');
  });

  test("while a turn streams, the button becomes an enabled Stop", () => {
    // The whole point of the stop button: a hung turn used to leave the
    // composer fully disabled with nothing to click.
    const html = renderToStaticMarkup(<Composer {...composerProps} busy={true} onStop={noop} />);
    expect(html).toContain('aria-label="Stop"');
    expect(html).not.toContain('aria-label="Send"');
    // The input locks, but the Stop button itself stays clickable.
    expect(html).toMatch(/<input[^>]*\sdisabled=/);
    expect(html).not.toMatch(/<button[^>]*\sdisabled=/);
  });

  test("busy with no stop handler falls back to a disabled Send", () => {
    const html = renderToStaticMarkup(<Composer {...composerProps} busy={true} />);
    expect(html).toContain('aria-label="Send"');
    expect(html).toMatch(/<button[^>]*\sdisabled=/);
  });
});

describe("ChatPanel (pre-project)", () => {
  test("shows starters and an enabled composer when the server has an LLM", () => {
    const html = renderToStaticMarkup(<ChatPanel {...panelProps} llmStatus={{ llm: true }} />);
    expect(html).toContain("Try one of these");
    expect(html).toContain("Describe your agent or workflow…");
    // The `disabled` attribute — Tailwind `disabled:` variant classes also
    // contain the word, so match the attribute shape.
    expect(html).not.toMatch(/<input[^>]*\sdisabled=/);
    expect(html).not.toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
  });

  test("while the guided-start project is being created, everything disables", () => {
    // A second Enter or starter click here would create a second, orphan
    // project — the whole panel must go inert until the mutation settles.
    const html = renderToStaticMarkup(
      <ChatPanel {...panelProps} creating={true} llmStatus={{ llm: true }} />,
    );
    expect(html).toContain("Creating your project…");
    expect(html).toMatch(/<input[^>]*\sdisabled=/);
    expect(html).toMatch(/<button[^>]*class="starter"[^>]*\sdisabled=/);
  });

  test("unknown status reads as 'checking', not as a misconfigured server", () => {
    // /studio/status still loading or unreachable — a network blip must not
    // claim the server has no LLM key.
    const html = renderToStaticMarkup(<ChatPanel {...panelProps} llmStatus={undefined} />);
    // renderToStaticMarkup escapes the apostrophe — match around it.
    expect(html).toContain("chat status…");
    expect(html).not.toContain("Chat is disabled");
  });

  test("a definite no-LLM status shows the configuration message", () => {
    const html = renderToStaticMarkup(<ChatPanel {...panelProps} llmStatus={{ llm: false }} />);
    expect(html).toContain("Chat is disabled");
    expect(html).not.toContain("Try one of these");
  });

  test("shows the host-configured model as a header chip", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        {...panelProps}
        llmStatus={{ llm: true, provider: "assemblyai", model: "gpt-5.5" }}
      />,
    );
    expect(html).toContain("gpt-5.5");
    expect(html).toContain("Model: gpt-5.5 (assemblyai)");
  });

  test("no model in the status means no chip", () => {
    const html = renderToStaticMarkup(<ChatPanel {...panelProps} llmStatus={{ llm: false }} />);
    expect(html).not.toContain("Model:");
  });

  test("a multi-model status renders the picker with every option", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        {...panelProps}
        llmStatus={{
          llm: true,
          provider: "assemblyai",
          model: "gpt-5.5",
          models: ["gpt-5.5", "claude-opus-4-7", "gemini-2.5-pro"],
        }}
      />,
    );
    expect(html).toContain('aria-label="Model"');
    expect(html).toContain(">claude-opus-4-7</option>");
    expect(html).toContain(">gemini-2.5-pro</option>");
  });
});

describe("ModelPicker", () => {
  const status = {
    llm: true,
    provider: "assemblyai",
    model: "gpt-5.5",
    models: ["gpt-5.5", "claude-opus-4-7"],
  };

  test("a single-model list stays the read-only chip", () => {
    const html = renderToStaticMarkup(
      <ModelPicker
        status={{ llm: true, provider: "anthropic", model: "claude-sonnet-5" }}
        value={null}
        onChange={noop}
      />,
    );
    expect(html).not.toContain("<select");
    expect(html).toContain("claude-sonnet-5");
  });

  test("null value selects the server default; a choice selects itself", () => {
    const asDefault = renderToStaticMarkup(
      <ModelPicker status={status} value={null} onChange={noop} />,
    );
    expect(asDefault).toMatch(/<option[^>]*selected[^>]*>gpt-5\.5<\/option>/);
    const picked = renderToStaticMarkup(
      <ModelPicker status={status} value="claude-opus-4-7" onChange={noop} />,
    );
    expect(picked).toMatch(/<option[^>]*selected[^>]*>claude-opus-4-7<\/option>/);
    expect(picked).toContain("Model: claude-opus-4-7 (assemblyai)");
  });

  test("unconfigured status renders nothing", () => {
    const html = renderToStaticMarkup(
      <ModelPicker status={{ llm: false }} value={null} onChange={noop} />,
    );
    expect(html).toBe("");
  });
});
