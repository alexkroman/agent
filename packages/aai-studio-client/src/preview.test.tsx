// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Preview pane states: placeholder before any deploy, the readiness probe
// that keeps the platform's 404 body out of the pane, the preview iframe
// (keyed by version), the updating/error banners, and the production
// fallback for projects published before auto previews existed.

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse } from "./_test-utils.ts";
import { PreviewPane } from "./preview.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const noop = (): void => undefined;

/** Mirrors PROBE_RETRY_MS in preview.tsx. */
const PROBE_RETRY_MS = 3000;

/**
 * Answer the platform's agent health route (`GET /:slug/health`) — what the
 * pane probes before framing a slug. `served` lists the slugs that exist;
 * everything else 404s the way an agent the platform doesn't know does.
 */
function stubHealth(served: string[]) {
  const fetchMock = vi.fn((input: RequestInfo | URL) => {
    const { pathname } = new URL(String(input), "http://studio.test");
    const slug = pathname.replace(/^\/|\/health$/g, "");
    return Promise.resolve(
      served.includes(slug)
        ? jsonResponse({ status: "ok", slug })
        : jsonResponse({ error: "Not found" }, 404),
    );
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

function frame(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("no iframe rendered");
  return iframe;
}

describe("PreviewPane", () => {
  test("no deploys at all: the placeholder explains auto previews", () => {
    stubHealth([]);
    render(<PreviewPane nonce={0} onPublish={noop} />);
    expect(screen.getByText("Nothing to preview yet")).toBeDefined();
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("a preview slug frames the PREVIEW agent, keyed by version", async () => {
    stubHealth(["p-preview"]);
    const { container, rerender } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} onPublish={noop} />,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const first = frame(container);
    expect(first.getAttribute("src")).toBe("/p-preview/");
    // A new preview deploy (new version) remounts the frame — that is the
    // only reload path; nothing else may kill an in-progress voice session.
    rerender(
      <PreviewPane previewSlug="p-preview" previewVersion="h2" nonce={0} onPublish={noop} />,
    );
    expect(frame(container)).not.toBe(first);
  });

  test("preview wins over production when both exist", async () => {
    stubHealth(["p-preview", "p"]);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" deployedSlug="p" nonce={0} onPublish={noop} />,
    );
    await waitFor(() => expect(frame(container).getAttribute("src")).toBe("/p-preview/"));
  });

  test("a pre-preview project falls back to the production agent", async () => {
    stubHealth(["legacy"]);
    const { container } = render(<PreviewPane deployedSlug="legacy" nonce={3} onPublish={noop} />);
    await waitFor(() => expect(frame(container).getAttribute("src")).toBe("/legacy/"));
  });

  test("stale preview shows the updating banner", async () => {
    stubHealth(["p-preview"]);
    render(
      <PreviewPane
        previewSlug="p-preview"
        previewVersion="h1"
        previewStale={true}
        nonce={0}
        onPublish={noop}
      />,
    );
    await waitFor(() => expect(screen.getByText("Updating preview…")).toBeDefined());
  });

  test("a failed preview build surfaces its CLI output", async () => {
    stubHealth(["p-preview"]);
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
    await waitFor(() => expect(screen.getByText(/preview build failed/i)).toBeDefined());
    expect(screen.getByText(/agent\.ts:1: oops/)).toBeDefined();
  });

  test("current preview with unpublished production offers Publish", async () => {
    stubHealth(["p-preview"]);
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
    await waitFor(() => expect(screen.getByRole("button", { name: "Publish" })).toBeDefined());
    fireEvent.click(screen.getByRole("button", { name: "Publish" }));
    expect(onPublish).toHaveBeenCalled();
  });
});

describe("PreviewPane readiness probe", () => {
  test("a slug the platform doesn't serve yet shows the pane's own screen, not the 404 body", async () => {
    // The regression: a stamped previewSlug whose agent is gone (swept, or a
    // deploy still in flight) framed `/:slug/`, and the platform's bare
    // `{"error":"HTML not found"}` rendered as the entire pane.
    stubHealth([]);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" previewStale={true} nonce={0} onPublish={noop} />,
    );
    await waitFor(() => expect(screen.getByText("Starting your preview")).toBeDefined());
    expect(container.querySelector("iframe")).toBeNull();
    // The deploy-state banner still applies — it describes the deploy, not
    // the frame.
    expect(screen.getByText("Updating preview…")).toBeDefined();
  });

  test("the frame appears once the deploy lands, without an edit or a reload", async () => {
    vi.useFakeTimers();
    const served: string[] = [];
    stubHealth(served);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} onPublish={noop} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("iframe")).toBeNull();
    // The preview deploy lands; the pane's own retry picks it up.
    served.push("p-preview");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS);
    });
    expect(frame(container).getAttribute("src")).toBe("/p-preview/");
  });

  test("a page that answered once is never re-probed", async () => {
    // Re-probing could only ever unmount a live iframe — and with it any
    // voice session running inside it.
    vi.useFakeTimers();
    const fetchMock = stubHealth(["p-preview"]);
    const { container, rerender } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} onPublish={noop} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("iframe")).not.toBeNull();
    rerender(
      <PreviewPane previewSlug="p-preview" previewVersion="h2" nonce={0} onPublish={noop} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PROBE_RETRY_MS * 3);
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
