// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { ThemeProvider } from "../context.ts";
import { SyncChatView } from "./sync-chat-view.tsx";

function renderView(props?: { title?: string; greeting?: string }) {
  return render(
    <ThemeProvider>
      <SyncChatView syncUrl="http://localhost:3000/sync" {...props} />
    </ThemeProvider>,
  );
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("SyncChatView", () => {
  test("shows the title and the greeting as the opening assistant line", () => {
    renderView({ title: "My Sync Agent", greeting: "Hello! Type below." });
    expect(screen.getByText("My Sync Agent")).toBeTruthy();
    expect(screen.getByText("Hello! Type below.")).toBeTruthy();
  });

  test("falls back to a generic title", () => {
    renderView();
    expect(screen.getByText("Voice Agent")).toBeTruthy();
  });

  test("a typed message runs one POST /sync turn and renders both sides", async () => {
    const fetchSpy = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { text: string; history: unknown[] };
      expect(body.text).toBe("hi there");
      expect(body.history).toEqual([]);
      return new Response(JSON.stringify({ transcript: "hi there", reply: "Hello back!" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    });
    vi.stubGlobal("fetch", fetchSpy);

    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
      target: { value: "hi there" },
    });
    fireEvent.click(screen.getByText("Send"));

    expect(await screen.findByText("Hello back!")).toBeTruthy();
    expect(screen.getByText("hi there")).toBeTruthy();
    expect(fetchSpy).toHaveBeenCalledWith(
      "http://localhost:3000/sync",
      expect.objectContaining({ method: "POST" }),
    );
  });

  test("a failed turn surfaces the error instead of hanging on busy", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response(JSON.stringify({ error: "kaput" }), { status: 500 })),
    );
    renderView();
    fireEvent.change(screen.getByPlaceholderText("Type a message…"), {
      target: { value: "hi" },
    });
    fireEvent.click(screen.getByText("Send"));
    expect(await screen.findByText(/Sync turn failed: HTTP 500/)).toBeTruthy();
  });
});
