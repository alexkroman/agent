// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The code-block atom the API docs are built of: the text is copied verbatim,
// and a CopyLine shares its caller's flash rather than owning one.

import { useCopy } from "@alexkroman1/aai-ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { CopyLine, Snippet } from "./snippet.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

const CODE = 'const run = await agent.start("summarize", {\n  url: "<url>",\n});';

describe("Snippet", () => {
  test("renders the code in a <pre>, whitespace intact", () => {
    const { container } = render(<Snippet code={CODE} label="Start a run" />);
    const pre = container.querySelector("pre");
    expect(pre?.textContent).toBe(CODE);
  });

  test("copies the code verbatim and flashes", async () => {
    const writeText = stubClipboard();
    render(<Snippet code={CODE} label="Start a run" />);
    fireEvent.click(screen.getByLabelText("Copy: Start a run"));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(await screen.findByText("Copied")).toBeTruthy();
  });
});

function TwoLines() {
  const copier = useCopy();
  return (
    <>
      <CopyLine text="https://a.test/one" label="Copy one" copier={copier} />
      <CopyLine text="https://a.test/two" label="Copy two" copier={copier} />
    </>
  );
}

describe("CopyLine", () => {
  test("renders its text and copies it under its own label", () => {
    const writeText = stubClipboard();
    render(<TwoLines />);
    expect(screen.getByText("https://a.test/one").tagName).toBe("CODE");
    fireEvent.click(screen.getByLabelText("Copy two"));
    expect(writeText).toHaveBeenCalledWith("https://a.test/two");
  });

  test("the flash lights only the row whose text was copied", async () => {
    stubClipboard();
    render(<TwoLines />);
    fireEvent.click(screen.getByLabelText("Copy one"));
    expect(await screen.findByText("Copied")).toBeTruthy();
    expect(screen.getByLabelText("Copy one").textContent).toBe("Copied");
    expect(screen.getByLabelText("Copy two").textContent).not.toBe("Copied");
  });
});
