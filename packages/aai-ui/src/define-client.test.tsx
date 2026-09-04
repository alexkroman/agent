// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mock createSessionCore to avoid real WebSocket connections.
vi.mock("./session-core.ts", () => {
  const snapshot = {
    state: "disconnected" as const,
    messages: [],
    toolCalls: [],
    userTranscript: null,
    agentTranscript: null,
    error: null,
    started: false,
    running: false,
  };
  return {
    createSessionCore: vi.fn(() => ({
      getSnapshot: () => snapshot,
      subscribe: () => () => undefined,
      connect: vi.fn(),
      cancel: vi.fn(),
      resetState: vi.fn(),
      reset: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      toggle: vi.fn(),
      end: vi.fn(),
      [Symbol.dispose]: vi.fn(),
    })),
  };
});

import { createMockSessionCore, flushEffects } from "./_react-test-utils.ts";
import { type ToolDisplayConfig, useToolConfig } from "./components/tool-config-context.ts";
import { client } from "./define-client.tsx";
import { createSessionCore } from "./session-core.ts";

/** A core the default shell will render its children under. */
function startedCore() {
  return createMockSessionCore({ state: "ready", started: true });
}

describe("client", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
  });

  afterEach(() => {
    document.body.textContent = "";
    vi.clearAllMocks();
    // `unstubAllGlobals` is outside `restoreMocks`/`unstubEnvs`, so it needs an
    // explicit undo — and it belongs HERE. Four specs used to call it as the
    // last statement of their body, which is teardown that does not run on
    // failure: a failed assertion mid-test leaked its `fetch` stub into the
    // next one, which then stubbed `location` on top of it. Every other file in
    // the package already does it this way.
    vi.unstubAllGlobals();
  });

  it("throws when target selector does not match", () => {
    expect(() =>
      client({ name: "Test", target: "#nonexistent", platformUrl: "http://localhost:3000" }),
    ).toThrow("Element not found: #nonexistent");
  });

  it("renders the default shell when no component is given", () => {
    const handle = client({
      name: "Test Agent",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    expect(handle.session).toBeDefined();
    expect(typeof handle.dispose).toBe("function");
    expect(container.childNodes.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("renders a custom component in place of the default shell", () => {
    function MyApp() {
      return createElement("div", { "data-testid": "custom" }, "Custom");
    }
    const handle = client({
      component: MyApp,
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    expect(container.querySelector("[data-testid='custom']")).not.toBeNull();
    handle.dispose();
  });

  it("dispose unmounts and disconnects", () => {
    const handle = client({
      name: "Test",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    handle.dispose();
    expect(container.childNodes.length).toBe(0);
  });

  it("dispose invokes the session core's Symbol.dispose", () => {
    const handle = client({
      name: "Test",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    const core = vi.mocked(createSessionCore).mock.results[0]?.value as {
      [Symbol.dispose]: ReturnType<typeof vi.fn>;
    };
    expect(core[Symbol.dispose]).not.toHaveBeenCalled();
    handle.dispose();
    expect(core[Symbol.dispose]).toHaveBeenCalledOnce();
  });

  it("Symbol.dispose aliases dispose", () => {
    const handle = client({
      name: "Test",
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    const disposeSpy = vi.spyOn(handle, "dispose");
    handle[Symbol.dispose]();
    expect(disposeSpy).toHaveBeenCalledOnce();
  });

  it("accepts an HTMLElement as target", () => {
    const el = document.createElement("div");
    document.body.appendChild(el);
    const handle = client({ target: el, platformUrl: "http://localhost:3000" });
    expect(el.childNodes.length).toBeGreaterThan(0);
    handle.dispose();
  });

  it("uses the server-declared name on the chat shell when none is passed", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(JSON.stringify({ name: "Server Name", page: "voice" }), {
            status: 200,
            headers: { "Content-Type": "application/json" },
          }),
      ),
    );
    const handle = client({ target: "#app", platformUrl: "http://localhost:3000" });
    await vi.waitFor(() => expect(container.textContent).toContain("Server Name"));
    handle.dispose();
  });

  it("stays on the chat shell when the lookup fails", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const handle = client({ target: "#app", platformUrl: "http://localhost:3000" });

    // `waitFor(fetchSpy called)` settles INSIDE the effect, before the
    // rejection is handled — so on its own this asserted the shell's optimistic
    // first frame, which renders whether a lookup happens or not. The degrade
    // resolves to `{}` and commits it, so flushing to that commit is the gate.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await flushEffects();
    expect(container.textContent).toContain("Start Conversation");
    // A failed lookup contributes no title — `StartScreen` renders one only
    // when it has one — which is what "degrades to the empty default" means
    // here, as against the sibling above where the server names the agent.
    // (The line this replaced asserted `not.toContain("HTTP turns")`, a string
    // that has appeared nowhere in `packages/` since text-only mode was
    // removed, so it could not fail.)
    expect(container.querySelector("h1")).toBeNull();
    handle.dispose();
  });

  it("does not look up client-config at all when the caller named the agent", async () => {
    // The response's only consumer is the name fallback, and on the platform
    // this endpoint is the BROKER — a request able to boot a sandbox, issued to
    // fill in a value the caller already supplied.
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    vi.stubGlobal("fetch", fetchSpy);
    const handle = client({ name: "Test", target: "#app", platformUrl: "http://localhost:3000" });
    await vi.waitFor(() => expect(container.textContent).toContain("Test"));
    expect(fetchSpy).not.toHaveBeenCalled();
    handle.dispose();
  });

  it("derives platformUrl from location.href when not provided", () => {
    vi.stubGlobal("location", {
      origin: "https://example.com",
      pathname: "/agent/",
      href: "https://example.com/agent/",
    });
    const mockedCreateSessionCore = vi.mocked(createSessionCore);
    const handle = client({ name: "Test", target: container });
    expect(mockedCreateSessionCore).toHaveBeenCalledWith(
      expect.objectContaining({ platformUrl: "https://example.com/agent/" }),
    );
    handle.dispose();
  });

  /**
   * `name` alongside `component` used to be `never`, which failed with
   * "Type 'string' is not assignable to type 'undefined'" — a message that
   * explains nothing, on the most natural thing to write. Two different
   * models wrote it and each spent a build round on it. It is allowed now,
   * and it means something: the page title, since a custom component has no
   * shell header to show it in.
   */
  it("uses name as the page title, including with a custom component", () => {
    const before = document.title;
    const handle = client({
      name: "Pizza Palace",
      component: () => null,
      target: container,
    });
    expect(document.title).toBe("Pizza Palace");
    handle.dispose();
    document.title = before;
  });

  it("leaves the page title alone when no name is given", () => {
    document.title = "Shipped by the HTML";
    const handle = client({ component: () => null, target: container });
    expect(document.title).toBe("Shipped by the HTML");
    handle.dispose();
  });

  /**
   * `tools` alongside `component` used to be `never` — the same shape of bug
   * as `name` above, and found the same way: four starters in one eval run
   * wrote `client({ component, tools })` and each lost a build round to
   * "Type '{ … }' is not assignable to type 'undefined'".
   *
   * It was never a default-shell option like `sidebar`. The provider wraps
   * whichever root is rendered, and `ToolCallBlock` reads it — so a custom
   * component gets the labels the moment it renders `MessageList` or
   * `ChatView`. This asserts the value actually arrives, rather than only
   * that the type now permits it.
   */
  it("passes tool display config to a custom component", () => {
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    const handle = client({
      component: Probe,
      tools: { add_pizza: { label: "Adding pizza", icon: "🍕" } },
      target: container,
    });
    expect(seen).toEqual({ add_pizza: { label: "Adding pizza", icon: "🍕" } });
    handle.dispose();
  });

  it("defaults tool display config to empty for a custom component", () => {
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    const handle = client({ component: Probe, target: container });
    expect(seen).toEqual({});
    handle.dispose();
  });

  /**
   * `sidebar` alongside `component` was the last of the mutually-exclusive
   * `never`s, and the one still inviting the message the other two were
   * relaxed to avoid. Both panes are rendered, in the same `SidebarLayout` the
   * default shell uses — so the combination does the obvious thing rather than
   * being refused by the type or dropped by the mount.
   */
  it("renders a sidebar alongside a custom component", () => {
    function MyApp() {
      return createElement("div", { "data-testid": "main" }, "Main");
    }
    function Aside() {
      return createElement("div", { "data-testid": "aside" }, "Aside");
    }
    const handle = client({ component: MyApp, sidebar: Aside, target: container });
    expect(container.querySelector("[data-testid='main']")).not.toBeNull();
    expect(container.querySelector("[data-testid='aside']")).not.toBeNull();
    handle.dispose();
  });
  /**
   * The four display fields the two shell components already accepted and
   * `ClientConfig` did not name. `solo-rpg` wanted all four and could say none
   * of them in config, so it dropped to the `component:` tier for a 27-line
   * wrapper whose only job was to re-say what `client()` already knows how to
   * say — and which dragged `useAgentState` up a level so its `Sidebar` had to
   * take a prop.
   */
  it("forwards icon, subtitle and buttonText to the start screen", () => {
    const handle = client({
      name: "Solo RPG",
      icon: createElement("span", { "data-testid": "mark" }, "*"),
      subtitle: "A Narrative Solo-RPG Engine",
      buttonText: "Begin Your Story",
      target: container,
    });
    expect(container.querySelector("[data-testid='mark']")).not.toBeNull();
    expect(container.textContent).toContain("A Narrative Solo-RPG Engine");
    expect(container.textContent).toContain("Begin Your Story");
    // And NOT the stock CTA it replaced.
    expect(container.textContent).not.toContain("Start Conversation");
    handle.dispose();
  });

  it("puts the sidebar on the right when asked, in the default shell", () => {
    // The default shell keeps its children behind `StartScreen` until the
    // session starts, so this needs a core that is already started — which is
    // also the only state in which the sidebar exists to be positioned.
    function Aside() {
      return createElement("div", { "data-testid": "aside" }, "Aside");
    }
    vi.mocked(createSessionCore).mockReturnValueOnce(startedCore());
    const handle = client({
      name: "T",
      sidebar: Aside,
      sidebarPosition: "right",
      target: container,
    });
    // `order-last` is `SidebarLayout`'s own marker for the right-hand pane;
    // asserting it is what distinguishes "routed through" from "silently
    // dropped", which is what the field did before it was forwarded.
    const pane = container.querySelector("[data-testid='aside']")?.parentElement;
    expect(pane?.className).toContain("order-last");
    handle.dispose();
  });

  it("routes sidebarPosition through the custom-component branch too", () => {
    // The two branches build the same `SidebarLayout`; a field honoured by only
    // one of them is the shape this config used to have.
    function MyApp() {
      return createElement("div", { "data-testid": "main" }, "Main");
    }
    function Aside() {
      return createElement("div", { "data-testid": "aside" }, "Aside");
    }
    const handle = client({
      component: MyApp,
      sidebar: Aside,
      sidebarPosition: "right",
      target: container,
    });
    const pane = container.querySelector("[data-testid='aside']")?.parentElement;
    expect(pane?.className).toContain("order-last");
    handle.dispose();
  });
});
