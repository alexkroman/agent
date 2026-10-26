// Copyright 2025 the AAI authors. MIT license.
// @vitest-environment jsdom

/** @jsxImportSource react */

import { createElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createMockSessionCore, flushEffects } from "./_react-test-utils.ts";
import { type ToolDisplayConfig, useToolConfig } from "./components/tool-config-context.ts";
import { type ClientConfig, mountClientWith } from "./define-client.tsx";
import type { createBrowserSession } from "./session/index.ts";

/** A core the default shell will render its children under. */
function startedCore() {
  return createMockSessionCore({ state: "ready", started: true });
}

/**
 * The session factory, faked so no test opens a real WebSocket: an idle core
 * by default, which a test can override per call.
 */
const createSession = vi.fn<typeof createBrowserSession>(() =>
  createMockSessionCore({ running: false }),
);

/** `mountClient`, over the faked session factory. */
const mountClient = (config: ClientConfig) => mountClientWith(config, createSession);

describe("mountClient", () => {
  let container: HTMLElement;

  beforeEach(() => {
    container = document.createElement("div");
    container.id = "app";
    document.body.appendChild(container);
    // The default shell looks the agent up at mount (its start card shows the
    // agent's own name), so every mount below meets a lookup: an empty answer
    // by default, which a test with something to say about it restubs. The
    // shared config's `unstubGlobals` undoes both.
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response("{}", { status: 200 })),
    );
  });

  afterEach(() => {
    document.body.textContent = "";
  });

  it("throws when target selector does not match", () => {
    expect(() =>
      mountClient({ target: "#nonexistent", platformUrl: "http://localhost:3000" }),
    ).toThrow("Element not found: #nonexistent");
  });

  it("renders the default shell when no component is given", () => {
    const handle = mountClient({
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
    const handle = mountClient({
      component: MyApp,
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    expect(container.querySelector("[data-testid='custom']")).not.toBeNull();
    handle.dispose();
  });

  it("dispose unmounts and disconnects", () => {
    const handle = mountClient({
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    handle.dispose();
    expect(container.childNodes.length).toBe(0);
  });

  it("dispose invokes the session core's Symbol.dispose", () => {
    const handle = mountClient({
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    const dispose = vi.spyOn(handle.session, Symbol.dispose);
    expect(dispose).not.toHaveBeenCalled();
    handle.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it("Symbol.dispose aliases dispose", () => {
    const handle = mountClient({
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
    const handle = mountClient({ target: el, platformUrl: "http://localhost:3000" });
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
    const handle = mountClient({ target: "#app", platformUrl: "http://localhost:3000" });
    await vi.waitFor(() => expect(container).toHaveTextContent("Server Name"));
    handle.dispose();
  });

  it("stays on the chat shell when the lookup fails", async () => {
    const fetchSpy = vi.fn(async () => {
      throw new Error("network down");
    });
    vi.stubGlobal("fetch", fetchSpy);
    const handle = mountClient({ target: "#app", platformUrl: "http://localhost:3000" });

    // `waitFor(fetchSpy called)` settles INSIDE the effect, before the
    // rejection is handled — so on its own this asserted the shell's optimistic
    // first frame, which renders whether a lookup happens or not. The degrade
    // resolves to `{}` and commits it, so flushing to that commit is the gate.
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalled());
    await flushEffects();
    expect(container).toHaveTextContent("Start Conversation");
    // A failed lookup contributes no title — `StartScreen` renders one only
    // when it has one — which is what "degrades to the empty default" means
    // here, as against the sibling above where the server names the agent.
    // (The line this replaced asserted `not.toContain("HTTP turns")`, a string
    // that has appeared nowhere in `packages/` since text-only mode was
    // removed, so it could not fail.)
    expect(container.querySelector("h1")).toBeNull();
    handle.dispose();
  });

  it("looks up client-config ONCE at mount for the default shell", async () => {
    // The default shell's start card shows the agent's own name, so the lookup
    // is issued at mount — and once: on the platform this endpoint is the
    // BROKER, and a request to it can boot a sandbox.
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ name: "Server Name", page: "voice" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const handle = mountClient({ target: "#app", platformUrl: "http://localhost:3000" });
    await vi.waitFor(() => expect(container).toHaveTextContent("Server Name"));
    await flushEffects();
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("installs the agent's declared tool hints as served — the page has no map of its own", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              name: "Server Name",
              page: "voice",
              tools: { add_pizza: { icon: "🍕", label: "Adding pizza" }, lookup: { icon: "🔎" } },
            }),
            { status: 200, headers: { "Content-Type": "application/json" } },
          ),
      ),
    );
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    // The lookup is issued at mount; the sidebar (rendered once the shell is
    // past its start card) reads the served map, because the provider wraps
    // whichever root renders. `ClientConfig` has no `tools` to merge over it:
    // a tool's icon and label are `tool({ ui })`, declared once, on the tool.
    createSession.mockReturnValueOnce(startedCore());
    const handle = mountClient({
      sidebar: Probe,
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    await vi.waitFor(() =>
      expect(seen).toEqual({
        add_pizza: { icon: "🍕", label: "Adding pizza" },
        lookup: { icon: "🔎" },
      }),
    );
    handle.dispose();
  });

  it("under a custom component, looks the hints up once the session has STARTED, not before", async () => {
    const fetchSpy = vi.fn(
      async () =>
        new Response(JSON.stringify({ page: "voice", tools: { lookup: { label: "Looking" } } }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    );
    vi.stubGlobal("fetch", fetchSpy);
    const core = createMockSessionCore({ running: false, started: false });
    createSession.mockReturnValueOnce(core);
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    const handle = mountClient({
      component: Probe,
      target: "#app",
      platformUrl: "http://localhost:3000",
    });
    await flushEffects();
    // A custom component has no start card to name, so nothing in the response
    // is needed before the session starts.
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(seen).toEqual({});
    // Starting is what boots the sandbox on the platform, so the lookup
    // riding behind it costs no boot of its own.
    core.update({ started: true });
    await vi.waitFor(() => expect(seen).toEqual({ lookup: { label: "Looking" } }));
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    handle.dispose();
  });

  it("injects `css` into the head for the life of the mount, and removes it on dispose", () => {
    const css = ".aai-glow { box-shadow: 0 0 6px var(--aai-primary); }";
    const handle = mountClient({ css, target: container });
    const sheet = document.head.querySelector("style[data-aai-css]");
    expect(sheet?.textContent).toBe(css);
    handle.dispose();
    expect(document.head.querySelector("style[data-aai-css]")).toBeNull();
  });

  it("derives platformUrl from location.href when not provided", () => {
    vi.stubGlobal("location", {
      origin: "https://example.com",
      pathname: "/agent/",
      href: "https://example.com/agent/",
    });
    const handle = mountClient({ target: container });
    expect(createSession).toHaveBeenCalledWith(
      expect.objectContaining({ platformUrl: "https://example.com/agent/" }),
    );
    handle.dispose();
  });

  it("leaves the page title alone — the HTML's own title stands under either tier", () => {
    // `mountClient()` takes no `name`: the default shell shows the agent's own
    // (from its `client-config`), and a custom component owns the page, so a
    // title the HTML shipped is never clobbered by the mount.
    document.title = "Shipped by the HTML";
    const custom = mountClient({ component: () => null, target: container });
    expect(document.title).toBe("Shipped by the HTML");
    custom.dispose();
    const shell = mountClient({ target: container, platformUrl: "http://localhost:3000" });
    expect(document.title).toBe("Shipped by the HTML");
    shell.dispose();
  });

  it("defaults tool display config to empty for a custom component", () => {
    let seen: ToolDisplayConfig | undefined;
    function Probe() {
      seen = useToolConfig();
      return null;
    }
    const handle = mountClient({ component: Probe, target: container });
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
    const handle = mountClient({ component: MyApp, sidebar: Aside, target: container });
    expect(container.querySelector("[data-testid='main']")).not.toBeNull();
    expect(container.querySelector("[data-testid='aside']")).not.toBeNull();
    handle.dispose();
  });
  /**
   * The four display fields the two shell components already accepted and
   * `ClientConfig` did not name. `tabletop-rpg-agent` wanted all four and could say none
   * of them in config, so it dropped to the `component:` tier for a 27-line
   * wrapper whose only job was to re-say what `mountClient()` already knows how to
   * say — and which dragged `useAgentState` up a level so its `Sidebar` had to
   * take a prop.
   */
  it("forwards icon, subtitle and buttonText to the start screen", () => {
    const handle = mountClient({
      icon: createElement("span", { "data-testid": "mark" }, "*"),
      subtitle: "A Narrative Solo-RPG Engine",
      buttonText: "Begin Your Story",
      target: container,
    });
    expect(container.querySelector("[data-testid='mark']")).not.toBeNull();
    expect(container).toHaveTextContent("A Narrative Solo-RPG Engine");
    expect(container).toHaveTextContent("Begin Your Story");
    // And NOT the stock CTA it replaced.
    expect(container).not.toHaveTextContent("Start Conversation");
    handle.dispose();
  });

  it("puts the sidebar on the right when asked, in the default shell", () => {
    // The default shell keeps its children behind `StartScreen` until the
    // session starts, so this needs a core that is already started — which is
    // also the only state in which the sidebar exists to be positioned.
    function Aside() {
      return createElement("div", { "data-testid": "aside" }, "Aside");
    }
    createSession.mockReturnValueOnce(startedCore());
    const handle = mountClient({
      sidebar: Aside,
      sidebarPosition: "right",
      target: container,
    });
    // `order-last` is `SidebarLayout`'s own marker for the right-hand pane;
    // asserting it is what distinguishes "routed through" from "silently
    // dropped", which is what the field did before it was forwarded.
    const pane = container.querySelector("[data-testid='aside']")?.parentElement;
    expect(pane).toHaveClass("order-last");
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
    const handle = mountClient({
      component: MyApp,
      sidebar: Aside,
      sidebarPosition: "right",
      target: container,
    });
    const pane = container.querySelector("[data-testid='aside']")?.parentElement;
    expect(pane).toHaveClass("order-last");
    handle.dispose();
  });
});
