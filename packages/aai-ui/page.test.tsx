// Copyright 2026 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

/**
 * Specs for `page()` — the workflow-app mount.
 *
 * The property worth pinning is what it does NOT do: no `SessionCore`, no audio
 * graph, no microphone request. That is the whole reason it is a separate entry
 * from `client()` rather than a flag on it, and it is invisible to a rendering
 * assertion — so `session-core.ts` is mocked and the spec asserts it was never
 * touched.
 */

import { afterEach, describe, expect, test, vi } from "vitest";
import { page } from "./page.tsx";
import { createSessionCore } from "./session-core.ts";

vi.mock("./session-core.ts", () => ({ createSessionCore: vi.fn() }));

function mount(id = "app"): HTMLElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.append(el);
  return el;
}

afterEach(() => {
  document.body.innerHTML = "";
  document.title = "";
});

describe("page", () => {
  test("renders the component synchronously into #app", () => {
    mount();
    // `flushSync`, so the mount is observable to the caller's next statement
    // rather than scheduled — the same reason `client()` uses it.
    const handle = page({ component: () => <p>Digest</p> });
    expect(document.querySelector("#app")?.textContent).toBe("Digest");
    handle.dispose();
  });

  test("constructs NO session — no socket, no audio graph, no microphone", () => {
    mount();
    const handle = page({ component: () => <p>ok</p> });
    expect(vi.mocked(createSessionCore)).not.toHaveBeenCalled();
    handle.dispose();
  });

  test("accepts an element as well as a selector", () => {
    const el = document.createElement("section");
    document.body.append(el);
    const handle = page({ component: () => <p>ok</p>, target: el });
    expect(el.textContent).toBe("ok");
    handle.dispose();
  });

  test("throws for a target that is not in the DOM", () => {
    expect(() => page({ component: () => <p>ok</p>, target: "#missing" })).toThrow(
      "Element not found: #missing",
    );
  });

  test("sets the document title only when one is given", () => {
    mount();
    document.title = "declared by the shell";
    const untouched = page({ component: () => <p>ok</p> });
    expect(document.title).toBe("declared by the shell");
    untouched.dispose();

    const named = page({ component: () => <p>ok</p>, name: "Digest" });
    expect(document.title).toBe("Digest");
    named.dispose();
  });

  test("dispose unmounts, and `using` reaches the same path", () => {
    const el = mount();
    const handle = page({ component: () => <p>ok</p> });
    expect(el.textContent).toBe("ok");
    handle[Symbol.dispose]();
    expect(el.textContent).toBe("");
  });
});
