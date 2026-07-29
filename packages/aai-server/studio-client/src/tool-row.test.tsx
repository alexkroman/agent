// Copyright 2026 the AAI authors. MIT license.
// Structure check: the studio's tool row should read as the same component as
// the deployed agent UI's (aai-ui ToolCallBlock) — outlined TOOL chip, mono
// name, truncated args preview, rotating chevron.

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ToolRow } from "./chat.tsx";

const render = (part: Record<string, unknown> & { type: string }): string =>
  renderToStaticMarkup(<ToolRow part={part} />);

describe("ToolRow", () => {
  test("shows a TOOL chip, the tool name, and an args preview", () => {
    const html = render({
      type: "tool-read_file",
      state: "output-available",
      input: { path: "agent.ts" },
      output: "ok",
    });
    expect(html).toContain("Tool");
    expect(html).toContain("read_file");
    // Args ride on the collapsed row, as they do in the agent UI.
    expect(html).toContain("agent.ts");
  });

  test("a pending call shimmers instead of showing a spinner glyph", () => {
    const html = render({ type: "tool-test_agent", state: "input-available" });
    expect(html).toContain("tool-shimmer");
    expect(html).not.toContain("⏳");
  });

  test("a completed call is expandable; one with nothing to show is not", () => {
    const done = render({ type: "tool-x", state: "output-available", output: "result" });
    expect(done).toContain("▶");
    const bare = render({ type: "tool-x", state: "input-streaming" });
    expect(bare).not.toContain("▶");
  });
});
