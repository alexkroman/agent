// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { type ComponentType, createElement, type ReactNode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { pageBaseUrl, setPageTitle } from "./_utils.ts";
import { type ClientConfigResponse, fetchClientConfig } from "./client-config.ts";
import { ChatView } from "./components/chat-view.tsx";
import { SidebarLayout } from "./components/sidebar-layout.tsx";
import { StartScreen } from "./components/start-screen.tsx";
import { ToolConfigContext, type ToolDisplayConfig } from "./components/tool-config-context.ts";
import { SessionProvider, ThemeProvider } from "./context.ts";
import { createBrowserSession } from "./session-core.ts";
import type { BrowserSession } from "./session-core-types.ts";
import type { ClientTheme, VoiceSessionOptions } from "./types.ts";

// ─── Config types ─────────────────────────────────────────────────────────────

/**
 * Configuration passed to {@link mountClient}.
 *
 * The session-forwarded fields are picked from {@link VoiceSessionOptions}
 * (one source of truth for types and docs) rather than re-declared — a
 * re-declared copy is exactly how doc comments drift. It is NOT the session's
 * own options type: that is {@link VoiceSessionOptions}, which
 * `createBrowserSession` takes and which three of these fields come from.
 *
 * @remarks
 * **One flat type, not a union of tiers.** `component` is what decides which
 * shell renders — absent, the default one (StartScreen + ChatView, optional
 * sidebar); present, the caller's own component inside the same providers —
 * and that decision is made at runtime, where every field can be honoured. It
 * used to be a union whose two arms banned each other's fields with `?: never`,
 * and the failure that shape produces is recorded twice in this file's history:
 * `mountClient({ name, component })` and `mountClient({ component, tools })` were both
 * the natural thing to write, both were refused with *"Type 'string' is not
 * assignable to type 'undefined'"*, and both cost a build round each time
 * before the ban was lifted. What was left banned was `sidebar` beside a
 * `component`, which invited the identical failure for a combination
 * {@link mountClient} can simply render.
 *
 * @public
 */
export type ClientConfig = Pick<
  VoiceSessionOptions,
  "onSessionId" | "resumeSessionId" | "WebSocket"
> & {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /** Theme color overrides. */
  theme?: ClientTheme;
  /**
   * Full custom component to render instead of the default shell.
   *
   * It is rendered inside the same providers the default shell gets, so every
   * session hook, `useTheme` and the tool display config work in it unchanged.
   */
  component?: ComponentType;
  /**
   * Agent name shown in the header and start screen — and, with a `component`,
   * the page title, there being no shell header to put it in. Left out, the
   * default shell asks the agent for its own declared name.
   */
  name?: string;
  /**
   * Optional sidebar component rendered alongside the main pane.
   *
   * Beside a `component` it is the custom component that becomes the main pane,
   * in the same {@link SidebarLayout} the default shell uses.
   */
  sidebar?: ComponentType;
  /** CSS width of the sidebar. Defaults to `"18rem"`. */
  sidebarWidth?: string;
  /**
   * Which side the sidebar sits on. Defaults to `"left"`.
   *
   * Routed through the same {@link SidebarLayout} whether the main pane is the
   * default shell or a `component`, for the reason `sidebar` itself is: the two
   * branches build the same layout and a field honoured by only one of them is
   * the shape this config used to have.
   */
  sidebarPosition?: "left" | "right";
  /**
   * Element rendered in place of the AAI logo — on the start card, and in the
   * shell header once the session begins.
   *
   * Both, because they are one mark: an agent whose start screen shows a slice
   * of pizza and whose header shows our logo reads as two products.
   */
  icon?: ReactNode;
  /** A line under the title on the start card. */
  subtitle?: string;
  /** Label of the start CTA. Defaults to `"Start Conversation"`. */
  buttonText?: string;
  /**
   * Tool display config: icon and label overrides keyed by tool name.
   *
   * Honoured with a custom `component` too: {@link mountClient} installs it into
   * `ToolConfigContext`, and the consumer is `ToolCallBlock` — which a custom
   * component renders as soon as it uses `MessageList` or `ChatView`, the usual
   * way to build one.
   */
  tools?: ToolDisplayConfig;
};

/**
 * Handle returned by {@link mountClient} for cleanup.
 *
 * Implements `Disposable` so it can be used with `using`.
 *
 * @public
 */
export type ClientHandle = {
  /** The underlying session core. */
  session: BrowserSession;
  /** Unmount the UI and disconnect the session. */
  dispose(): void;
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * The element a mount renders into.
 *
 * Exported so `mountPage()` resolves its target the same way `mountClient()` does — the
 * default selector and the "element not found" sentence are part of what an
 * author has learned, and a second copy is how the two mounts come to disagree
 * about which one they were given.
 *
 * @internal
 */
export function resolveContainer(target: string | HTMLElement = "#app"): HTMLElement {
  if (typeof target !== "string") return target;
  const el = document.querySelector<HTMLElement>(target);
  if (!el) throw new Error(`Element not found: ${target}`);
  return el;
}

/**
 * What a mount hands back: unmount, and `using` support.
 *
 * @internal
 */
export type MountedRoot = {
  /** Unmount the React tree (and, for `mountClient()`, dispose the session). */
  dispose(): void;
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Render `node` into `container` and hand back its teardown.
 *
 * Shared by {@link mountClient} and `mountPage()` because the plumbing is identical and
 * the two decisions in it are not obvious enough to be re-derived: the root is
 * created here rather than by the caller so nothing else can hold one, and the
 * render is `flushSync` so the mount is observable to the caller's NEXT
 * STATEMENT (and to a test) rather than scheduled — `mountClient()` returns a handle
 * whose session is expected to be live, and `mountPage()` returns one a caller may
 * dispose immediately.
 *
 * `onDispose` runs after the unmount, which is the order `mountClient()` needs: the
 * tree comes down before the session under it goes away.
 *
 * @internal
 */
export function mountRoot(
  container: HTMLElement,
  node: ReactNode,
  onDispose?: () => void,
): MountedRoot {
  const root = createRoot(container);
  flushSync(() => {
    root.render(node);
  });
  return {
    dispose() {
      root.unmount();
      onDispose?.();
    },
    // Delegated through `this` rather than through a captured local, so the
    // alias still holds after the handle is spread into a wider one (which is
    // exactly what `mountClient()` does to add `session`) or after a caller replaces
    // `dispose` on the object it was handed.
    [Symbol.dispose]() {
      this.dispose();
    },
  };
}

/**
 * The presentation fields the default shell forwards, as one bag.
 *
 * Named rather than spread as four more parameters because that is exactly how
 * this drifted: `DefaultShell` forwarded three of the seven fields the two
 * components underneath it accept, so `solo-rpg` — which wants a right-hand
 * sidebar, an icon, a subtitle and its own CTA, all of which
 * `StartScreen`/`SidebarLayout` already take — could not say any of it in
 * config and dropped to the `component:` tier for a 27-line wrapper whose only
 * job was to re-say what `mountClient()` already knows how to say.
 */
type ShellDisplay = {
  // Mapped rather than a bare `Pick`, so each field also accepts an EXPLICIT
  // `undefined`: `exactOptionalPropertyTypes` is on, and every one of these
  // arrives as `config.icon` — present and possibly undefined — from a spread
  // that cannot know which keys the caller wrote.
  [K in keyof Pick<
    ClientConfig,
    "name" | "icon" | "subtitle" | "buttonText" | "sidebarWidth" | "sidebarPosition"
  >]: ClientConfig[K] | undefined;
} & {
  /** The sidebar component, already picked off the config. */
  Sidebar?: ComponentType | undefined;
};

/**
 * Default shell rendered in config tier.
 * Wraps StartScreen → (SidebarLayout →) ChatView.
 */
function DefaultShell({ name, icon, subtitle, buttonText, Sidebar, ...layout }: ShellDisplay) {
  const chat = <ChatView title={name} icon={icon} />;

  return (
    <StartScreen title={name} icon={icon} subtitle={subtitle} buttonText={buttonText}>
      {Sidebar ? (
        <SidebarLayout
          sidebar={<Sidebar />}
          sidebarWidth={layout.sidebarWidth}
          sidebarPosition={layout.sidebarPosition}
        >
          {chat}
        </SidebarLayout>
      ) : (
        chat
      )}
    </StartScreen>
  );
}

/**
 * Config-tier root: fetches the server-declared display name via
 * `GET client-config` and renders the chat shell. The shell renders
 * immediately — optimistically — while the lookup is in flight; servers
 * without the endpoint (every lookup failure resolves to the empty default)
 * work exactly as before.
 *
 * **The lookup is SKIPPED when the caller already named the agent.** The
 * response's only consumer here is the fallback below, so with an explicit
 * `mountClient({ name })` the request was issued and its answer thrown away — and on
 * the platform this endpoint is the BROKER, so the discarded request is one that
 * can boot a sandbox. The session's own per-attempt lookup
 * (`session-core.ts`'s URL provider) is a different question and deliberately
 * left alone: it re-brokers on every connection attempt, which is what makes a
 * reconnect land on a REPLACEMENT sandbox, so it may not be served from
 * anything this render already has.
 */
function DefaultRoot({ platformUrl, ...display }: { platformUrl: string } & ShellDisplay) {
  const { name } = display;
  const [resolved, setResolved] = useState<ClientConfigResponse | null>(null);
  const needsLookup = name === undefined;

  useEffect(() => {
    if (!needsLookup) return;
    let cancelled = false;
    void fetchClientConfig(platformUrl).then((cfg) => {
      if (!cancelled) setResolved(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [platformUrl, needsLookup]);

  // An explicit mountClient({ name }) wins; otherwise use the server-declared name.
  return <DefaultShell {...display} name={name ?? resolved?.name} />;
}

/**
 * The tree under the providers: the caller's component, or the default shell.
 *
 * A custom component owns the whole page, so there is no header to hang a
 * `sidebar` off — but the layout the default shell uses is right here, and
 * `mountClient({ component, sidebar })` names one pane and one aside, which is
 * exactly what it renders. Honouring the combination rather than ignoring it is
 * the same call this file already made for `name` and `tools`.
 */
function rootFor(config: ClientConfig, platformUrl: string) {
  const Custom = config.component;
  const Sidebar = config.sidebar;
  if (!Custom) {
    return (
      <DefaultRoot
        platformUrl={platformUrl}
        name={config.name}
        icon={config.icon}
        subtitle={config.subtitle}
        buttonText={config.buttonText}
        Sidebar={Sidebar}
        sidebarWidth={config.sidebarWidth}
        sidebarPosition={config.sidebarPosition}
      />
    );
  }
  if (!Sidebar) return <Custom />;
  return (
    <SidebarLayout
      sidebar={<Sidebar />}
      sidebarWidth={config.sidebarWidth}
      sidebarPosition={config.sidebarPosition}
    >
      <Custom />
    </SidebarLayout>
  );
}

// ─── client ──────────────────────────────────────────────────────────────────

/**
 * Define and mount a client UI for a voice agent.
 *
 * **Config only:** leave `component` out and the default shell renders
 * (StartScreen + ChatView, optional sidebar).
 *
 * **A custom component:** pass `component` and it is rendered inside the same
 * providers instead of the default shell — beside a `sidebar` if one is given,
 * in the same {@link SidebarLayout}. A provided `name` then also sets
 * `document.title`, there being no shell header to show it in.
 *
 * Mounts into `target` — a CSS selector or DOM element, defaulting to
 * `"#app"` — and throws `Element not found: <target>` when the selector
 * matches nothing.
 *
 * @example The default shell
 * ```tsx
 * import { mountClient } from "@alexkroman1/aai-ui";
 *
 * function OrderPanel() {
 *   return <div>Cart</div>;
 * }
 *
 * mountClient({
 *   name: "Pizza Ordering",
 *   theme: { bg: "#1a1a1a", primary: "#e55" },
 *   sidebar: OrderPanel,
 *   tools: { add_pizza: { icon: "🍕", label: "Adding pizza" } },
 * });
 * ```
 *
 * @example A custom component
 * ```tsx
 * import { mountClient, useSession } from "@alexkroman1/aai-ui";
 *
 * function MyCustomApp() {
 *   const session = useSession();
 *   return <div>{session.state}</div>;
 * }
 *
 * mountClient({ component: MyCustomApp });
 * ```
 *
 * @returns A {@link ClientHandle} for cleanup.
 * @throws If the target element is not found in the DOM.
 *
 * @public
 */
export function mountClient(config: ClientConfig): ClientHandle {
  const container = resolveContainer(config.target);

  const platformUrl = config.platformUrl ?? pageBaseUrl();

  const session = createBrowserSession({
    platformUrl,
    onSessionId: config.onSessionId,
    resumeSessionId: config.resumeSessionId,
    WebSocket: config.WebSocket,
  });

  // The default shell renders `name` in its header; a custom component has no
  // header, so the page title is where it goes.
  setPageTitle(config.name);

  const rootNode = rootFor(config, platformUrl);

  const toolConfig: ToolDisplayConfig = config.tools ?? {};

  return {
    session,
    ...mountRoot(
      container,
      createElement(
        ToolConfigContext.Provider,
        { value: toolConfig },
        createElement(
          ThemeProvider,
          { value: config.theme },
          createElement(SessionProvider, { value: session }, rootNode),
        ),
      ),
      // Baselined under `guard-invariants` rule 27: a teardown THUNK handed to
      // the React root, which calls it on unmount. A callback is not a scope,
      // so `using` has nothing to attach the lifetime to — the session outlives
      // this function by design and the root owns when it ends.
      () => session[Symbol.dispose](),
    ),
  };
}
