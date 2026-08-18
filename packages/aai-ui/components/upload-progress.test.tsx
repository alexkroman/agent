// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/**
 * Specs for `<UploadProgressBar>`.
 *
 * A pure render over one value, so what is asserted is the three rules the
 * component exists to hold — nothing to render, an indeterminate total, and the
 * file being named — plus the width, which is the whole product.
 */

import { render, screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";
import type { UploadStatus } from "../use-workflow-form.ts";
import { UploadProgressBar } from "./upload-progress.tsx";

function status(over: Partial<UploadStatus> = {}): UploadStatus {
  return {
    name: "standup.wav",
    index: 1,
    count: 1,
    loaded: 512 * 1024,
    total: 2 * 1024 * 1024,
    fraction: 0.25,
    ...over,
  };
}

/**
 * The fill inside the track.
 *
 * A `throw` rather than a non-null assertion: an absent fill means the component
 * rendered a track with no bar in it, which is the finding — and this runs
 * outside a test body, where an assertion is a biome finding.
 */
function fill(bar: HTMLElement): HTMLElement {
  const child = bar.firstElementChild;
  if (!(child instanceof HTMLElement)) throw new Error("the track rendered no fill");
  return child;
}

describe("UploadProgressBar", () => {
  test("renders nothing at all when there is no upload to describe", () => {
    const { container } = render(<UploadProgressBar upload={undefined} />);
    // Not an empty box: a page renders this unguarded, so a form with no files
    // must not reserve space for a bar that never appears.
    expect(container.innerHTML).toBe("");
    expect(screen.queryByRole("progressbar")).toBeNull();
  });

  test("sizes the fill from the fraction and states it to a screen reader", () => {
    render(<UploadProgressBar upload={status()} />);
    // Found BY ITS LABEL, which is the visible text rather than a second copy
    // of it in an `aria-label`.
    const bar = screen.getByRole("progressbar", { name: "Uploading standup.wav" });
    expect(bar.getAttribute("aria-valuenow")).toBe("25");
    expect(fill(bar).style.width).toBe("25%");
  });

  test("reads the sizes in the units the file was chosen in", () => {
    render(<UploadProgressBar upload={status()} />);
    expect(screen.getByText("512.0 KB of 2.0 MB")).toBeDefined();
    expect(screen.getByText("Uploading standup.wav")).toBeDefined();
  });

  test("an unknown total is INDETERMINATE, never a bar pinned at zero", () => {
    // A body whose length the transport cannot state up front has no honest
    // width, and 0% reads as an upload that is not moving.
    render(<UploadProgressBar upload={status({ total: undefined, fraction: undefined })} />);
    const bar = screen.getByRole("progressbar");
    expect(bar.hasAttribute("aria-valuenow")).toBe(false);
    expect(fill(bar).style.width).toBe("100%");
    // The loaded count is still worth showing — it is the only evidence of
    // movement an indeterminate bar has.
    expect(screen.getByText("512.0 KB")).toBeDefined();
  });

  test("counts the files when there is more than one", () => {
    // Files are sent one after another, so an uncounted bar appears to restart
    // from zero partway through with nothing to say why.
    render(<UploadProgressBar upload={status({ name: "two.wav", index: 2, count: 3 })} />);
    expect(screen.getByText("Uploading two.wav (2 of 3)")).toBeDefined();
  });

  test("whole bytes are whole, so a tiny file does not read as 0.0 B", () => {
    render(<UploadProgressBar upload={status({ loaded: 7, total: 40, fraction: 0.175 })} />);
    expect(screen.getByText("7 B of 40 B")).toBeDefined();
    // Rounded, because a bar's width is a percentage and 17.5% of a track is a
    // subpixel argument nobody can see.
    expect(screen.getByRole("progressbar").getAttribute("aria-valuenow")).toBe("18");
  });
});
