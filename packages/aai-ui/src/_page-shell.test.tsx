// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * The shell a workflow app gets with no `component` — what it renders, and from
 * what.
 *
 * It is driven over a stubbed `fetch` rather than a mocked `WorkflowApi`,
 * deliberately: the shell passes no `api` anywhere, so the lazily-built default
 * client is part of what is being claimed to work. The routes ARE the seam this
 * is written against.
 *
 * `mountPage`'s own suite keeps the two claims that are the MOUNT's — that a
 * page needs no component at all, and that a default shell did not quietly
 * reintroduce a session.
 */

import { act, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, test, vi } from "vitest";
import { DefaultPageShell } from "./_page-shell.tsx";

afterEach(() => {
  vi.unstubAllGlobals();
});

/** One workflow with one declared string field — what a form is rendered FROM. */
const DIGEST = {
  name: "digest",
  description: "Read a link and file the digest",
  inputSchema: {
    type: "object",
    properties: { url: { type: "string", description: "The link to digest" } },
    required: ["url"],
  },
};

/** A JSON response, as every route here answers. */
function json(body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });
}

/**
 * A deployed agent, as far as `fetch` is concerned.
 *
 * First match wins, so the narrow run routes come before the listing.
 *
 * @returns The stub, so a spec can assert on what was requested.
 */
function stubAgent(
  over: { workflows?: unknown[]; config?: unknown } = {},
): ReturnType<typeof vi.fn> {
  const config = over.config ?? { name: "Link Digest", greeting: "Paste a link.", page: "static" };
  const running = { runId: "wrun_1", workflow: "digest", createdAt: 0, status: "running" };
  const declined = () => new Response(null, { status: 404 });
  const routes: [fragment: string, answer: () => Response][] = [
    ["client-config", () => json(config)],
    // Declined so the run watch falls through to its poll, which is the path a
    // spec can drive.
    ["/events", declined],
    ["/stream", declined],
    // The mount-time recovery lookup — `useWorkflowSubmit` asks for this page's
    // earlier runs by key before anything is submitted.
    ["/workflows/runs?", () => json({ runs: [] })],
    ["/workflows/runs/", () => json(running)],
    ["/workflows/runs", () => json({ runId: "wrun_1" })],
    ["/workflows", () => json({ workflows: over.workflows ?? [DIGEST] })],
  ];

  const fetchSpy = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    const route = routes.find(([fragment]) => url.includes(fragment));
    // Loudly, rather than a default answer: a route nobody wired up reads as a
    // hanging page otherwise.
    if (!route) throw new Error(`no stubbed route for ${url}`);
    return route[1]();
  });
  vi.stubGlobal("fetch", fetchSpy);
  return fetchSpy;
}

describe("DefaultPageShell", () => {
  test("renders the agent's own name and greeting", async () => {
    // `mountPage()` fetched no client config at all, so a page had to ask for
    // these itself — which is why the shell is what fetches them now.
    stubAgent();
    const { container } = render(<DefaultPageShell />);
    await waitFor(() => expect(container.textContent).toContain("Paste a link."));
    expect(container.querySelector("h1")?.textContent).toBe("Link Digest");
  });

  test("an explicit name beats the agent's own", async () => {
    stubAgent();
    const { container } = render(<DefaultPageShell name="Digests" />);
    await waitFor(() => expect(container.querySelector("h1")?.textContent).toBe("Digests"));
  });

  test("renders a control per declared schema property", async () => {
    // The form is the workflow's own input schema, read from `GET workflows` —
    // so a field added in `agent.ts` appears here with no edit, and this is the
    // half that makes the shell useful rather than decorative.
    stubAgent();
    const { container } = render(<DefaultPageShell />);
    await waitFor(() => expect(container.querySelector("input[name='url']")).not.toBeNull());
    expect(container.textContent).toContain("The link to digest");
    // Awaited rather than read at that instant: `pending` covers the
    // mount-time recovery lookup too — `useWorkflowSubmit` asks whether this
    // page already started a run — so the button reads "Working…" until that
    // answer lands, which is the honest label for it.
    await waitFor(() =>
      expect(container.querySelector("button[type='submit']")?.textContent).toBe("Start"),
    );
  });

  test("submitting the form starts a run on that workflow", async () => {
    // End to end over the routes: the listing, the form built from it, and the
    // `POST` the submit produces — with no `api` passed anywhere.
    const fetchSpy = stubAgent();
    const { container } = render(<DefaultPageShell />);
    await waitFor(() => expect(container.querySelector("input[name='url']")).not.toBeNull());

    const field = container.querySelector<HTMLInputElement>("input[name='url']");
    if (!field) throw new Error("the schema field never rendered");
    field.value = "https://example.com/a";
    // In `act`, because the submit is what starts the run: everything it
    // schedules — the upload pass, the `POST`, the watch — lands as React state.
    await act(async () => {
      container.querySelector<HTMLFormElement>("form")?.requestSubmit();
    });

    await waitFor(() => {
      const posted = fetchSpy.mock.calls.find(([, init]) => init?.method === "POST");
      expect(posted).toBeDefined();
      expect(String(posted?.[1]?.body)).toContain('"workflow":"digest"');
      expect(String(posted?.[1]?.body)).toContain("https://example.com/a");
    });
  });

  test("says so when the agent declares no workflows", async () => {
    // The honest empty state. `useWorkflows` reports a failed listing
    // separately, which is why this sentence can be about a real answer.
    stubAgent({ workflows: [] });
    const { container } = render(<DefaultPageShell />);
    await waitFor(() => expect(container.textContent).toContain("declares no workflows"));
  });

  test("offers a picker only when there is more than one workflow", async () => {
    stubAgent();
    const one = render(<DefaultPageShell />);
    await waitFor(() => expect(one.container.querySelector("input[name='url']")).not.toBeNull());
    expect(one.container.querySelector("select")).toBeNull();
    one.unmount();

    stubAgent({ workflows: [DIGEST, { ...DIGEST, name: "summarize" }] });
    const two = render(<DefaultPageShell />);
    await waitFor(() => expect(two.container.querySelector("select")).not.toBeNull());
    expect(two.container.querySelectorAll("option")).toHaveLength(2);
  });
});
