// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Structure check: the studio's tool row should read as the same component as
// the deployed agent UI's (aai-ui ToolCallBlock) — outlined TOOL chip, mono
// name, truncated args preview, rotating chevron.

import { cleanup, fireEvent, render as renderDom, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, test } from "vitest";
import { prettyToolName, summarizeArgs, ToolRow } from "./tool-row.tsx";

afterEach(cleanup);

const render = (part: Record<string, unknown> & { type: string }): string =>
  renderToStaticMarkup(<ToolRow part={part} />);

describe("ToolRow", () => {
  test("shows a TOOL chip, a friendly tool name, and an args preview", () => {
    const html = render({
      type: "tool-read_file",
      state: "output-available",
      input: { path: "agent.ts" },
      output: "ok",
    });
    expect(html).toContain("Tool");
    // No raw snake_case in the row — the prettified fallback renders.
    expect(html).toContain("Read file");
    expect(html).not.toContain("read_file<");
    // Args ride on the collapsed row, as they do in the agent UI.
    expect(html).toContain("agent.ts");
  });

  test("prefers the sandbox-served label over the prettified fallback", () => {
    const html = renderToStaticMarkup(
      <ToolRow
        part={{ type: "tool-bash", state: "output-available", input: { command: "ls" } }}
        labels={{ bash: "Run command" }}
      />,
    );
    expect(html).toContain("Run command");
    expect(html).not.toContain(">bash<");
  });

  test("prettyToolName humanizes snake_case", () => {
    expect(prettyToolName("write_file")).toBe("Write file");
    expect(prettyToolName("test_agent")).toBe("Test agent");
    expect(prettyToolName("grep")).toBe("Grep");
  });

  test("a pending call shimmers instead of showing a spinner glyph", () => {
    const html = render({ type: "tool-test_agent", state: "input-available" });
    expect(html).toContain("tool-shimmer");
    expect(html).not.toContain("⏳");
  });

  test("a pending call stops shimmering once the turn is over", () => {
    // A call abandoned by Stop (or a dropped stream) never reaches
    // output-available — it must not flash forever.
    const html = renderToStaticMarkup(
      <ToolRow part={{ type: "tool-test_agent", state: "input-available" }} active={false} />,
    );
    expect(html).not.toContain("tool-shimmer");
  });

  test("a completed call is expandable; one with nothing to show is not", () => {
    const done = render({ type: "tool-x", state: "output-available", output: "result" });
    expect(done).toContain("▶");
    const bare = render({ type: "tool-x", state: "input-streaming" });
    expect(bare).not.toContain("▶");
  });

  test("dynamic tools use their toolName, or a generic fallback without one", () => {
    const named = render({ type: "dynamic-tool", toolName: "web_search" });
    expect(named).toContain("Web search");
    // No toolName → the generic "tool" name (proved via the label lookup).
    const bare = renderToStaticMarkup(
      <ToolRow part={{ type: "dynamic-tool" }} labels={{ tool: "Generic tool" }} />,
    );
    expect(bare).toContain("Generic tool");
  });

  test("expanding shows the args and the output; a string output renders verbatim", () => {
    renderDom(
      <ToolRow
        part={{
          type: "tool-bash",
          state: "output-available",
          input: { command: "ls" },
          output: "agent.ts\nclient.tsx",
        }}
      />,
    );
    expect(screen.queryByText(/client\.tsx/)).toBeNull();
    fireEvent.click(screen.getByRole("button"));
    // The collapsed row carries the summary; the expansion carries the
    // pretty-printed record.
    expect(screen.getByText(/"command": "ls"/)).toBeTruthy();
    expect(screen.getByText(/client\.tsx/)).toBeTruthy();
    // Clicking again collapses.
    fireEvent.click(screen.getByRole("button"));
    expect(screen.queryByText(/client\.tsx/)).toBeNull();
  });

  test("a non-string output is JSON-stringified in the expansion", () => {
    renderDom(
      <ToolRow
        part={{
          type: "tool-test_agent",
          state: "output-available",
          input: {},
          output: { built: true },
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/"built":true/)).toBeTruthy();
  });

  test("an empty argument record is shown nowhere — not as `{}` twice", () => {
    const { container } = renderDom(
      <ToolRow
        part={{ type: "tool-list_files", state: "output-available", input: {}, output: "agent.ts" }}
      />,
    );
    expect(container.textContent).not.toContain("{}");
    fireEvent.click(screen.getByRole("button"));
    expect(container.textContent).not.toContain("{}");
    // The output is still there — only the empty record went away.
    expect(screen.getByText("agent.ts")).toBeTruthy();
  });

  test("an empty output says so rather than opening an empty panel", () => {
    renderDom(
      <ToolRow
        part={{
          type: "tool-write_file",
          state: "output-available",
          input: { path: "a.ts" },
          output: "  ",
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText("(no output)")).toBeTruthy();
  });

  test("a clipped payload says how much was cut", () => {
    renderDom(
      <ToolRow
        part={{
          type: "tool-grep",
          state: "output-available",
          input: { pattern: "x" },
          output: "y".repeat(700),
        }}
      />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/more characters/)).toBeTruthy();
  });

  test("an in-flight call with args expands to the args alone — no output block", () => {
    const { container } = renderDom(
      <ToolRow part={{ type: "tool-grep", state: "input-available", input: { pattern: "x" } }} />,
    );
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getByText(/"pattern": "x"/)).toBeTruthy();
    expect(container.querySelector("pre")).toBeNull();
  });
});

describe("summarizeArgs", () => {
  test("no arguments summarize to nothing, so the row shows no `{}`", () => {
    expect(summarizeArgs(undefined)).toBe("");
    expect(summarizeArgs({})).toBe("");
    expect(summarizeArgs({ todos: [] })).toBe("");
  });

  test("leads with the identifying argument, not the whole record", () => {
    // write_file's `content` is the entire file; only the path is readable.
    expect(summarizeArgs({ path: "agent.ts", content: "export default {};" })).toBe("agent.ts");
    expect(summarizeArgs({ template: "web-researcher" })).toBe("web-researcher");
    expect(summarizeArgs({ pattern: "tool\\(", path: "src" })).toBe("tool\\(");
  });

  test("a lone value needs no key; several unrecognized ones read as a list", () => {
    expect(summarizeArgs({ thought: "hmm" })).toBe("hmm");
    expect(summarizeArgs({ a: 1, b: true })).toBe("a: 1, b: true");
  });

  test("collapses whitespace and ellipsizes — the row is one line", () => {
    expect(summarizeArgs({ command: "ls -la\n  | head" })).toBe("ls -la | head");
    const long = summarizeArgs({ command: "x".repeat(200) });
    expect(long.endsWith("…")).toBe(true);
    expect(long.length).toBeLessThanOrEqual(64);
  });
});
