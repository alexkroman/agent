// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// Preview pane states: placeholder before any deploy, the readiness probe
// that keeps the platform's 404 body out of the pane, the preview iframe
// (keyed by version), the failed-build banner, and the production
// fallback for projects published before auto previews existed.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { act, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { jsonResponse, stubFetch } from "./_test-utils.ts";
import {
  PROBE_FAILURES_BEFORE_WAKE,
  PROBE_RETRY_MS,
  PROBE_SLOW_AFTER,
  PROBE_SLOW_RETRY_MS,
  PreviewPane,
} from "./preview.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HOUR_MS = 60 * 60 * 1000;

/**
 * How many probes the pane issues in `ms` of poll time against a slug that
 * never answers — the cadence, replayed from the source's own constants.
 *
 * Derived rather than written down because the bound below is only worth
 * anything if it moves with the cadence: the constants used to be MIRRORED
 * here, so halving the source's retry interval would have silently loosened
 * the very assertion that exists to catch it.
 */
function expectedProbes(ms: number): number {
  let at = 0;
  let failures = 0;
  let probes = 0;
  while (at <= ms) {
    probes += 1;
    failures += 1;
    at += failures < PROBE_SLOW_AFTER ? PROBE_RETRY_MS : PROBE_SLOW_RETRY_MS;
  }
  return probes;
}

/**
 * Answer the platform's agent health route (`GET /:slug/health`) — what the
 * pane probes before framing a slug. `served` lists the slugs that exist;
 * everything else 404s the way an agent the platform doesn't know does.
 */
function stubHealth(served: string[]) {
  return stubFetch((input) => {
    const { pathname } = new URL(String(input), "http://studio.test");
    const slug = pathname.replace(/^\/|\/health$/g, "");
    return served.includes(slug)
      ? jsonResponse({ status: "ok", slug })
      : jsonResponse({ error: "Not found" }, 404);
  });
}

function frame(container: HTMLElement): HTMLIFrameElement {
  const iframe = container.querySelector("iframe");
  if (!iframe) throw new Error("no iframe rendered");
  return iframe;
}

describe("PreviewPane", () => {
  test("no deploys at all: the placeholder explains auto previews", () => {
    stubHealth([]);
    render(<PreviewPane nonce={0} />);
    expect(screen.getByText("Nothing to preview yet")).toBeDefined();
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("a preview slug frames the PREVIEW agent, keyed by version", async () => {
    stubHealth(["p-preview"]);
    const { container, rerender } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} />,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    const first = frame(container);
    expect(first.getAttribute("src")).toBe("/p-preview/");
    // A new preview deploy (new version) remounts the frame — that is the
    // only reload path; nothing else may kill an in-progress voice session.
    rerender(<PreviewPane previewSlug="p-preview" previewVersion="h2" nonce={0} />);
    expect(frame(container)).not.toBe(first);
  });

  test("preview wins over production when both exist", async () => {
    stubHealth(["p-preview", "p"]);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" deployedSlug="p" nonce={0} />,
    );
    await waitFor(() => expect(frame(container).getAttribute("src")).toBe("/p-preview/"));
  });

  test("a pre-preview project falls back to the production agent", async () => {
    stubHealth(["legacy"]);
    const { container } = render(<PreviewPane deployedSlug="legacy" nonce={3} />);
    await waitFor(() => expect(frame(container).getAttribute("src")).toBe("/legacy/"));
  });

  test("a rebuild takes the whole pane, not a banner over a stale frame", async () => {
    stubHealth(["p-preview"]);
    const { container } = render(
      <PreviewPane
        previewSlug="p-preview"
        previewVersion="h1"
        previewStale={true}
        hasAgent={true}
        nonce={0}
      />,
    );
    await waitFor(() => expect(screen.getByText("Starting your preview")).toBeDefined());
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByText("Updating preview…")).toBeNull();
  });

  test("the FIRST build shows the same screen, before any preview slug exists", async () => {
    // The stale flag is true before the first preview deploy lands, so the
    // pane can say the build is on its way rather than "nothing to preview".
    stubHealth([]);
    render(<PreviewPane previewStale={true} hasAgent={true} nonce={0} />);
    await waitFor(() => expect(screen.getByText("Starting your preview")).toBeDefined());
  });

  test("an untouched project still reads as empty, not as a build in flight", () => {
    // "No preview yet" IS stale server-side — without an agent to build,
    // that must not read as a deploy on the way.
    stubHealth([]);
    render(<PreviewPane previewStale={true} nonce={0} />);
    expect(screen.getByText("Nothing to preview yet")).toBeDefined();
  });

  test("the frame comes back when the rebuild lands", async () => {
    stubHealth(["p-preview"]);
    const { container, rerender } = render(
      <PreviewPane
        previewSlug="p-preview"
        previewVersion="h1"
        previewStale={true}
        hasAgent={true}
        nonce={0}
      />,
    );
    await waitFor(() => expect(screen.getByText("Starting your preview")).toBeDefined());
    rerender(
      <PreviewPane
        previewSlug="p-preview"
        previewVersion="h2"
        previewStale={false}
        hasAgent={true}
        nonce={0}
      />,
    );
    await waitFor(() => expect(frame(container).getAttribute("src")).toBe("/p-preview/"));
  });

  test("a failed preview build surfaces its CLI output over the last good preview", async () => {
    // A failure leaves the workspace stale forever — if that read as a build
    // in flight the pane would sit on "Starting your preview" for good.
    stubHealth(["p-preview"]);
    const cliOutput = "Build failed:\nagent.ts:1: oops";
    const { container } = render(
      <PreviewPane
        previewSlug="p-preview"
        previewError={cliOutput}
        previewStale={true}
        hasAgent={true}
        nonce={0}
      />,
    );
    await waitFor(() => expect(screen.getByText(/preview build failed/i)).toBeDefined());
    expect(screen.getByText(/agent\.ts:1: oops/)).toBeDefined();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByText("Starting your preview")).toBeNull();
  });

  test("a healthy preview carries no banner over the frame", async () => {
    // The publish nudge that used to sit here rendered on every unpublished
    // project — i.e. nearly always — restating the pane's own name above the
    // Publish control in the top bar.
    stubHealth(["p-preview"]);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" previewStale={false} nonce={0} />,
    );
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(screen.queryByText(/updates automatically as you edit/i)).toBeNull();
    expect(screen.queryByRole("button", { name: "Publish" })).toBeNull();
  });
});

describe("PreviewPane readiness probe", () => {
  test("a slug the platform doesn't serve yet shows the pane's own screen, not the 404 body", async () => {
    // The regression: a stamped previewSlug whose agent is gone (swept, or a
    // deploy still in flight) framed `/:slug/`, and the platform's bare
    // `{"error":"HTML not found"}` rendered as the entire pane.
    stubHealth([]);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" previewStale={true} nonce={0} />,
    );
    await waitFor(() => expect(screen.getByText("Starting your preview")).toBeDefined());
    expect(container.querySelector("iframe")).toBeNull();
  });

  test("the frame appears once the deploy lands, without an edit or a reload", async () => {
    vi.useFakeTimers();
    const served: string[] = [];
    stubHealth(served);
    const { container } = render(
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} />,
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
      <PreviewPane previewSlug="p-preview" previewVersion="h1" nonce={0} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(container.querySelector("iframe")).not.toBeNull();
    rerender(<PreviewPane previewSlug="p-preview" previewVersion="h2" nonce={0} />);
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
      <PreviewPane previewSlug="p-preview" nonce={0} {...omitUndefined({ onPreviewMissing })} />,
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(ms);
    });
    return fetchMock;
  }

  test("reports the preview missing after a few failed probes", async () => {
    const onPreviewMissing = vi.fn(() => Promise.resolve());
    // The first probe is immediate, so the third failure lands two intervals in.
    await pollFor(PROBE_RETRY_MS * (PROBE_FAILURES_BEFORE_WAKE - 1), onPreviewMissing);
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
    //
    // EXACT, not an upper bound. Both assertions here used to cap the count and
    // neither floored it, so the failure the module's own docblock names — a
    // loop that ENDS, leaving the pane on "Starting your preview" forever —
    // yielded one call and satisfied them both. It is driven with a reporter
    // for the same reason: `report()` runs inside the loop, and a loop that
    // dies right after it is the shape the sibling floor below cannot see.
    const onPreviewMissing = vi.fn(() => Promise.resolve());
    const fetchMock = await pollFor(HOUR_MS, onPreviewMissing);
    expect(fetchMock.mock.calls.length).toBe(expectedProbes(HOUR_MS));
    // …and the point of the two speeds: an order of magnitude under the flat
    // fast cadence, which is what produced 1,061 probes in 50 minutes.
    expect(fetchMock.mock.calls.length).toBeLessThan(HOUR_MS / PROBE_RETRY_MS / 5);
    expect(onPreviewMissing).toHaveBeenCalledTimes(1);
  });

  test("still polls with no reporter — an unopened project has nothing to wake", async () => {
    const fetchMock = await pollFor(PROBE_RETRY_MS * 3);
    expect(fetchMock.mock.calls.length).toBe(expectedProbes(PROBE_RETRY_MS * 3));
  });
});
