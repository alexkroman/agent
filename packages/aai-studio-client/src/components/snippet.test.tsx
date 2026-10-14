// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// A CopyLine copies its text verbatim and shares its caller's flash rather
// than owning one.

import { useCopy } from "@alexkroman1/aai-ui";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, test, vi } from "vitest";
import { CopyLine } from "./snippet.tsx";

function stubClipboard() {
  const writeText = vi.fn(async (_text: string) => undefined);
  vi.stubGlobal("navigator", { clipboard: { writeText } });
  return writeText;
}

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
    expect(await screen.findByText("Copied")).toBeInTheDocument();
    expect(screen.getByLabelText("Copy one")).toHaveTextContent(/^Copied$/);
    expect(screen.getByLabelText("Copy two").textContent).not.toBe("Copied");
  });
});
