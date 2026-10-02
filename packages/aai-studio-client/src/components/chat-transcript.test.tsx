// Copyright 2026 the AAI authors. MIT license.
// The transcript half of the chat panel: how each message renders, where the
// lead and footer go, and the empty-state welcome.
//
// Static markup, because the transcript is rendered TWICE (restored history,
// then the live conversation) and what has to match between the two is the
// markup; stick-to-bottom itself is aai-ui's `AutoScroll`, specced there.

import type { UIMessage } from "ai";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { EmptyStateBody, Transcript } from "./chat-transcript.tsx";

const USER: UIMessage = {
  id: "u1",
  role: "user",
  parts: [
    { type: "text", text: "  build a " },
    { type: "text", text: "pizza bot  " },
  ],
};

const ASSISTANT: UIMessage = {
  id: "a1",
  role: "assistant",
  parts: [
    { type: "text", text: "Reading the **agent** first." },
    {
      type: "dynamic-tool",
      toolName: "bash",
      toolCallId: "call-1",
      state: "output-available",
      input: { command: "ls" },
      output: "agent.ts",
    },
  ],
};

describe("Transcript", () => {
  test("a user message is its text parts joined and trimmed, in one bubble", () => {
    const html = renderToStaticMarkup(<Transcript messages={[USER]} />);
    expect(html).toContain(">build a pizza bot</div>");
  });

  test("an assistant message renders its markdown and its tool rows, in order", () => {
    const html = renderToStaticMarkup(
      <Transcript messages={[ASSISTANT]} labels={{ bash: "Run command" }} />,
    );
    expect(html).toContain("<strong>agent</strong>");
    expect(html).toContain("Run command");
    expect(html.indexOf("<strong>agent</strong>")).toBeLessThan(html.indexOf("Run command"));
  });

  test("the lead goes above the messages and the footer below, inside the scroller", () => {
    const html = renderToStaticMarkup(
      <Transcript messages={[USER]} lead={<p>LEAD</p>} footer={<p>FOOTER</p>} />,
    );
    const lead = html.indexOf("LEAD");
    const message = html.indexOf("build a pizza bot");
    const footer = html.indexOf("FOOTER");
    expect(lead).toBeGreaterThan(-1);
    expect(lead).toBeLessThan(message);
    expect(message).toBeLessThan(footer);
    // One log region: the footer is pinned with the messages, not outside them.
    expect(html.match(/role="log"/g)).toHaveLength(1);
  });

  test("shows a native scrollbar, not aai-ui's hidden default", () => {
    const html = renderToStaticMarkup(<Transcript messages={[]} />);
    expect(html).toContain("overflow-y-auto");
    expect(html).not.toContain("scrollbar-width:none");
  });
});

describe("EmptyStateBody", () => {
  test("welcomes a new chat, and says so while the chat status is still loading", () => {
    const html = renderToStaticMarkup(<EmptyStateBody status={undefined} />);
    expect(html).toContain("Welcome to AssemblyAI Build");
    expect(html).toContain("Checking the server");
  });

  test("once the status has landed only the welcome remains", () => {
    const html = renderToStaticMarkup(
      <EmptyStateBody status={{ provider: "assemblyai", model: "gpt-5.5" }} />,
    );
    expect(html).toContain("Welcome to AssemblyAI Build");
    expect(html).not.toContain("Checking the server");
  });
});
