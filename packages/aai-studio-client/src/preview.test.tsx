// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Preview pane states: placeholder before any deploy, the preview iframe
// (keyed by version), the updating/error banners, and the production
// fallback for projects published before auto previews existed.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { PreviewPane } from "./preview.tsx";

afterEach(cleanup);

const noop = (): void => undefined;

function frame(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("no iframe rendered");
  return iframe;
}

describe("PreviewPane", () => {
  test("no deploys at all: the placeholder explains auto previews", () => {
    render(<PreviewPane nonce={0} onPublish={noop} />);
    expect(screen.getByText("Nothing to preview yet")).toBeDefined();
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("a preview slug frames the PREVIEW agent, keyed by version", () => {
    const { container, rerender } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} onPublish={noop} />,
    );
    const first = frame(container);
    expect(first.getAttribute("src")).toBe("/p-preview/");
    // A new preview deploy (new version) remounts the frame — that is the
    // only reload path; nothing else may kill an in-progress voice session.
    rerender(
      <PreviewPane previewSlug="p-preview" previewVersion="h2" nonce={0} onPublish={noop} />,
    );
    expect(frame(container)).not.toBe(first);
  });

  test("preview wins over production when both exist", () => {
    const { container } = render(
      <PreviewPane previewSlug="p-preview" deployedSlug="p" nonce={0} onPublish={noop} />,
    );
    expect(frame(container).getAttribute("src")).toBe("/p-preview/");
  });

  test("a pre-preview project falls back to the production agent", () => {
    const { container } = render(<PreviewPane deployedSlug="legacy" nonce={3} onPublish={noop} />);
    expect(frame(container).getAttribute("src")).toBe("/legacy/");
  });

  test("stale preview shows the updating banner", () => {
    render(
      <PreviewPane
        previewSlug="p-preview"
        previewVersion="h1"
        previewStale={true}
        nonce={0}
        onPublish={noop}
      />,
    );
    expect(screen.getByText("Updating preview…")).toBeDefined();
  });

  test("a failed preview build surfaces its CLI output", () => {
    const cliOutput = "Build failed:\nagent.ts:1: oops";
    render(
      <PreviewPane
        previewSlug="p-preview"
        previewError={cliOutput}
        previewStale={true}
        nonce={0}
        onPublish={noop}
      />,
    );
    expect(screen.getByText(/preview build failed/i)).toBeDefined();
    expect(screen.getByText(/agent\.ts:1: oops/)).toBeDefined();
  });

  test("current preview with unpublished production offers Publish", () => {
    const onPublish = vi.fn();
    render(
      <PreviewPane
        previewSlug="p-preview"
        previewVersion="h1"
        previewStale={false}
        unpublished={true}
        nonce={0}
        onPublish={onPublish}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onPublish).toHaveBeenCalled();
  });
});
