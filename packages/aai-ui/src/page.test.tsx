// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * Specs for `mountPage()` — the workflow-app mount.
 *
 * The property worth pinning is what it does NOT do: no `BrowserSession`, no audio
 * graph, no microphone request. That is the whole reason it is a separate entry
 * from `mountClient()` rather than a flag on it, and it is invisible to a rendering
 * assertion — so the spec stands in for the two things a session would open (a
 * `WebSocket`, an `AudioContext`) and asserts neither was constructed, and reads
 * the session context from inside the tree to see that none was installed.
 *
 * The second half is the DEFAULT SHELL — what a workflow app gets with no
 * `component` at all, which is what makes "you do not need a `client.tsx`" true
 * of a page as well as of a voice agent. Those specs drive the real client over
 * a stubbed `fetch` rather than a mocked `WorkflowApi`, deliberately: the shell
 * passes no `api`, so the lazily-built default client is part of what is being
 * claimed to work.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { useOptionalSessionCore } from "./context.ts";
import { mountPage } from "./page.tsx";

/**
 * Stand in for the socket and the audio graph a session would open, and count
 * the constructions — `mountPage()` must make none of either.
 */
function watchSessionResources(): { sockets: () => number; audioContexts: () => number } {
  const WebSocketSpy = vi.fn();
  const AudioContextSpy = vi.fn();
  vi.stubGlobal("WebSocket", WebSocketSpy);
  vi.stubGlobal("AudioContext", AudioContextSpy);
  return {
    sockets: () => WebSocketSpy.mock.calls.length,
    audioContexts: () => AudioContextSpy.mock.calls.length,
  };
}

function mount(id = "app"): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
  vi.unstubAllGlobals();
});

/**
 * The two reads the DEFAULT shell makes on mount, and nothing else.
 *
 * The shell's own behaviour — the form built from a schema, the submit, the
 * picker, the empty state — is `_page-shell.test.tsx`'s, which drives it
 * directly. What is left here is what only the mount can claim, so this stub is
 * the smallest agent that lets the shell render at all.
 */
function stubAgent(): void {
  const json = (body: unknown) =>
    new Response(JSON.stringify(body), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL) =>
      String(input).includes("client-config")
        ? json({ name: "Link Digest", page: "static" })
        : json({ workflows: [] }),
    ),
  );
}

describe("mountPage", () => {
  test("renders the component synchronously into #app", () => {
    mount();
    // `flushSync`, so the mount is observable to the caller's next statement
    // rather than scheduled — the same reason `mountClient()` uses it.
    const handle = mountPage({ component: () => <p>Digest</p> });
    expect(document.querySelector("#app")?.textContent).toBe("Digest");
    handle.dispose();
  });

  test("constructs NO session — no socket, no audio graph, no microphone", () => {
    mount();
    const watched = watchSessionResources();
    let session: unknown = "unread";
    function Probe() {
      session = useOptionalSessionCore();
      return <p>ok</p>;
    }
    const handle = mountPage({ component: Probe });
    expect(session).toBeNull();
    expect(watched.sockets()).toBe(0);
    expect(watched.audioContexts()).toBe(0);
    handle.dispose();
  });

  test("accepts an element as well as a selector", () => {
    const el = document.createElement("section");
    document.body.append(el);
    const handle = mountPage({ component: () => <p>ok</p>, target: el });
    expect(el.textContent).toBe("ok");
    handle.dispose();
  });

  test("throws for a target that is not in the DOM", () => {
    expect(() => mountPage({ component: () => <p>ok</p>, target: "#missing" })).toThrow(
      "Element not found: #missing",
    );
  });

  test("sets the document title only when one is given", () => {
    mount();
    document.title = "declared by the shell";
    const untouched = mountPage({ component: () => <p>ok</p> });
    expect(document.title).toBe("declared by the shell");
    untouched.dispose();

    const named = mountPage({ component: () => <p>ok</p>, name: "Digest" });
    expect(document.title).toBe("Digest");
    named.dispose();
  });

  test("dispose unmounts, and `using` reaches the same path", () => {
    const el = mount();
    const handle = mountPage({ component: () => <p>ok</p> });
    expect(el.textContent).toBe("ok");
    handle[Symbol.dispose]();
    expect(el.textContent).toBe("");
  });
});

describe("mountPage's default shell", () => {
  test("needs no component at all — and no arguments", async () => {
    // The promise the docs make about a voice agent, now true of a workflow app:
    // `component` was REQUIRED, so every workflow page began with a shell
    // written by hand.
    const el = mount();
    stubAgent();
    const handle = mountPage();
    await vi.waitFor(() => expect(el.textContent).toContain("Link Digest"));
    handle.dispose();
  });

  test("forwards an explicit name to the shell, and to the title", async () => {
    const el = mount();
    stubAgent();
    const handle = mountPage({ name: "Digests" });
    await vi.waitFor(() => expect(el.querySelector("h1")?.textContent).toBe("Digests"));
    expect(document.title).toBe("Digests");
    handle.dispose();
  });

  test("still constructs NO session", async () => {
    // The whole reason `mountPage()` exists, and a default shell is exactly the
    // place a session could creep back in.
    const el = mount();
    stubAgent();
    const watched = watchSessionResources();
    const handle = mountPage();
    await vi.waitFor(() => expect(el.textContent).toContain("Link Digest"));
    expect(watched.sockets()).toBe(0);
    expect(watched.audioContexts()).toBe(0);
    handle.dispose();
  });
});
