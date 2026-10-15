// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// A run of tool calls folded into one step row: the settled summary, the
// running call while a turn streams, and the expansion to per-call rows.

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import { stepSummary, ToolGroup } from "./tool-group.tsx";
import type { ToolPart } from "./tool-row.tsx";

const done = (name: string, id: string, input: unknown = {}): ToolPart => ({
  type: `tool-${name}`,
  toolCallId: id,
  state: "output-available",
  input,
  output: "ok",
});

const PARTS = [
  done("read_file", "t1", { path: "agent.ts" }),
  done("write_file", "t2", { path: "agent.ts" }),
  done("write_file", "t3", { path: "client.tsx" }),
];

describe("stepSummary", () => {
  test("names each distinct tool once, in first-use order", () => {
    expect(stepSummary(PARTS)).toBe("Read file, Write file");
  });

  test("prefers the sandbox-served labels", () => {
    expect(stepSummary(PARTS, { write_file: "Edit" })).toBe("Read file, Edit");
  });
});

describe("ToolGroup", () => {
  test("a settled run reads as a count and a summary, collapsed", () => {
    render(<ToolGroup parts={PARTS} active={false} />);
    const row = screen.getByRole("button");
    expect(row).toHaveTextContent("3 steps");
    expect(row).toHaveTextContent("Read file, Write file");
    expect(row).toHaveAttribute("aria-expanded", "false");
    // The per-call args are not on screen until it opens.
    expect(screen.queryByText("client.tsx")).toBeNull();
  });

  test("one call says one step", () => {
    render(<ToolGroup parts={PARTS.slice(0, 1)} active={false} />);
    expect(screen.getByRole("button")).toHaveTextContent("1 step ·");
  });

  test("opening it lists every call", () => {
    render(<ToolGroup parts={PARTS} active={false} />);
    fireEvent.click(screen.getByRole("button"));
    expect(screen.getAllByRole("button")[0]).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("client.tsx")).toBeInTheDocument();
  });

  test("while the turn streams, the row names the call still running", () => {
    const running: ToolPart = {
      type: "tool-write_file",
      toolCallId: "t4",
      state: "input-available",
      input: { path: "x.ts" },
    };
    render(<ToolGroup parts={[...PARTS, running]} active={true} />);
    const row = screen.getByRole("button");
    expect(row).toHaveTextContent("Write file");
    expect(row).toHaveTextContent("x.ts");
    expect(row).not.toHaveTextContent("steps");
  });

  test("a call abandoned by Stop does not keep the row running", () => {
    const abandoned: ToolPart = {
      type: "tool-write_file",
      toolCallId: "t4",
      state: "input-available",
      input: {},
    };
    render(<ToolGroup parts={[...PARTS, abandoned]} active={false} />);
    expect(screen.getByRole("button")).toHaveTextContent("4 steps");
  });

  test("failed calls are counted on the summary", () => {
    const failed: ToolPart = {
      type: "tool-run_check",
      toolCallId: "t5",
      state: "output-error",
      input: {},
      errorText: "check failed",
    };
    render(<ToolGroup parts={[...PARTS, failed]} active={false} />);
    expect(screen.getByRole("button")).toHaveTextContent("1 failed");
  });
});
