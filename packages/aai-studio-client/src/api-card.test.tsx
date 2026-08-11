// @vitest-environment jsdom
// Copyright 2026 the AAI authors. MIT license.
// The Settings pane's "API" card: the endpoints for reaching this agent from
// outside the studio.

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ApiCard, sessionUrl, workflowsUrl } from "./api-card.tsx";

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("sessionUrl", () => {
  test("is the long-living platform endpoint, with the ws scheme", () => {
    // NOT the sandbox tunnel: that URL dies with its sandbox, so handing one
    // out gives someone a link that rots. This one re-resolves per connection.
    expect(sessionUrl("https://build.test", "demo-x7k2mq")).toBe(
      "wss://build.test/demo-x7k2mq/websocket",
    );
  });

  test("keeps a loopback origin insecure, so local dev is copy-pasteable", () => {
    // `wss://localhost` against a plain HTTP dev server fails the handshake.
    expect(sessionUrl("http://localhost:8080", "demo")).toBe("ws://localhost:8080/demo/websocket");
  });
});

describe("workflowsUrl", () => {
  test("is the platform's own route, not the guest's", () => {
    // `/:slug/workflows` is brokered by the platform (workflow-handler.ts); a
    // caller has no way to reach the guest directly.
    expect(workflowsUrl("https://build.test", "demo-x7k2mq")).toBe(
      "https://build.test/demo-x7k2mq/workflows",
    );
  });
});

describe("ApiCard", () => {
  function renderAt(origin: string, props: Parameters<typeof ApiCard>[0]) {
    vi.stubGlobal("location", { origin });
    return render(<ApiCard {...props} />);
  }

  test("shows both surfaces for a published project", () => {
    // Both, because the platform stores no agent config — nothing here knows
    // whether this project is a voice agent or a static one, and guessing
    // would hide the working endpoint from half of all projects.
    renderAt("https://build.test", { deployedSlug: "demo-x7k2mq" });
    expect(screen.getByText("wss://build.test/demo-x7k2mq/websocket")).toBeTruthy();
    expect(screen.getByText("https://build.test/demo-x7k2mq/workflows")).toBeTruthy();
  });

  test("prefers the published slug over the preview", () => {
    renderAt("https://build.test", { deployedSlug: "demo-x7k2mq", previewSlug: "demo-preview" });
    expect(screen.getByText("https://build.test/demo-x7k2mq/workflows")).toBeTruthy();
    expect(screen.queryByText(/demo-preview/)).toBeNull();
  });

  test("falls back to the preview, and says so", () => {
    // A preview URL is a real answer before the first Publish, but not a
    // stable one — it redeploys on every edit and an orphan is reaped hourly.
    renderAt("https://build.test", { previewSlug: "demo-preview" });
    expect(screen.getByText("https://build.test/demo-preview/workflows")).toBeTruthy();
    expect(screen.getByText(/redeploys on every edit/)).toBeTruthy();
  });

  test("does not caveat a published project", () => {
    renderAt("https://build.test", { deployedSlug: "demo-x7k2mq" });
    expect(screen.queryByText(/redeploys on every edit/)).toBeNull();
  });

  test("asks for a publish when there is no slug at all", () => {
    renderAt("https://build.test", {});
    expect(screen.getByText("Publish this project to get its API URLs.")).toBeTruthy();
    expect(screen.queryByRole("button")).toBeNull();
  });

  test("copies the URL the button belongs to, and flashes only that one", () => {
    const writeText = vi.fn(() => Promise.resolve());
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    renderAt("https://build.test", { deployedSlug: "demo-x7k2mq" });

    fireEvent.click(screen.getByLabelText("Copy the Workflows URL"));
    expect(writeText).toHaveBeenCalledExactlyOnceWith("https://build.test/demo-x7k2mq/workflows");
  });
});
