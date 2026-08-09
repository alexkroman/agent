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

/** Mirror the poll constants in preview.tsx. */
const PROBE_RETRY_MS = 3000;
const PROBE_SLOW_AFTER = 10;
const PROBE_SLOW_RETRY_MS = 30_000;
const HOUR_MS = 60 * 60 * 1000;

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

/**
 * Polling is not a recovery. The server's fix for a swept preview is hung off
 * OPENING the project, which a tab that is already open never does again — so
 * before this the pane could poll a slug nothing was going to redeploy for as
 * long as it stayed on screen (1,061 probes over 50 minutes, in production).
 */
describe("PreviewPane: reporting a missing preview", () => {
  /** Run the pane against a permanently-404 slug for `ms` of poll time. */
  async function pollFor(ms: number, onPreviewMissing?: () => Promise<unknown>) {
    vi.useFakeTimers();
    const fetchMock = stubHealth([]);
    render(
      <PreviewPane
        previewSlug="p-preview"
        nonce={0}
        onPublish={noop}
        {...(onPreviewMissing && { onPreviewMissing })}
      />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return fetchMock;
  }

  test("reports the preview missing after a few failed probes", async () => {
    const onPreviewMissing = vi.fn(() => Promise.resolve());
    // Three failures at the fast cadence — the first probe is immediate.
    await pollFor(PROBE_RETRY_MS * 2, onPreviewMissing);
    expect(onPreviewMissing).toHaveBeenCalledTimes(1);
  });

  test("does not report on the first failure", async () => {
    // A stamped slug that 404s is already abnormal, but a probe's worth of
    // grace costs seconds and covers a blip.
    const onPreviewMissing = vi.fn(() => Promise.resolve());
    await pollFor(0, onPreviewMissing);
    expect(onPreviewMissing).not.toHaveBeenCalled();
  });

  test("reports ONCE — the wake enqueues a durable job, the queue retries", async () => {
    const onPreviewMissing = vi.fn(() => Promise.resolve());
    await pollFor(PROBE_SLOW_RETRY_MS * 10, onPreviewMissing);
    expect(onPreviewMissing).toHaveBeenCalledTimes(1);
  });

  test("a report that never arrived is sent again", async () => {
    // Latching on the attempt rather than the delivery would strand the pane
    // exactly as before, on one dropped request.
    const onPreviewMissing = vi
      .fn<() => Promise<unknown>>()
      .mockRejectedValueOnce(new Error("offline"))
      .mockResolvedValue(undefined);
    await pollFor(PROBE_RETRY_MS * 4, onPreviewMissing);
    expect(onPreviewMissing.mock.calls.length).toBeGreaterThanOrEqual(2);
  });

  test("the probe backs off, so a stuck preview is not 20 requests a minute", async () => {
    // The fast cadence exists for a deploy landing in the next few seconds;
    // past that it buys nothing. An hour at 3s is ~1200 requests.
    const fetchMock = await pollFor(HOUR_MS);
    const fast = PROBE_SLOW_AFTER;
    const slow = (HOUR_MS - PROBE_RETRY_MS * PROBE_SLOW_AFTER) / PROBE_SLOW_RETRY_MS;
    expect(fetchMock.mock.calls.length).toBeLessThanOrEqual(fast + slow + 1);
    expect(fetchMock.mock.calls.length).toBeLessThan(HOUR_MS / PROBE_RETRY_MS / 5);
  });

  test("still polls with no reporter — an unopened project has nothing to wake", async () => {
    const fetchMock = await pollFor(PROBE_RETRY_MS * 3);
    expect(fetchMock.mock.calls.length).toBeGreaterThan(1);
  });
});
