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
import { createSessionCore } from "./session-core.ts";
import type { SessionCore } from "./session-core-types.ts";
import type { ClientTheme, VoiceSessionOptions } from "./types.ts";

// ─── Config types ─────────────────────────────────────────────────────────────

/**
 * Configuration passed to {@link client}.
 *
 * The session-forwarded fields are picked from {@link VoiceSessionOptions}
 * (one source of truth for types and docs) rather than re-declared — a
 * re-declared copy is exactly how doc comments drift. It is NOT the session's
 * own options type: that is {@link VoiceSessionOptions}, which
 * `createSessionCore` takes and which three of these fields come from.
 *
 * @remarks
 * **One flat type, not a union of tiers.** `component` is what decides which
 * shell renders — absent, the default one (StartScreen + ChatView, optional
 * sidebar); present, the caller's own component inside the same providers —
 * and that decision is made at runtime, where every field can be honoured. It
 * used to be a union whose two arms banned each other's fields with `?: never`,
 * and the failure that shape produces is recorded twice in this file's history:
 * `client({ name, component })` and `client({ component, tools })` were both
 * the natural thing to write, both were refused with *"Type 'string' is not
 * assignable to type 'undefined'"*, and both cost a build round each time
 * before the ban was lifted. What was left banned was `sidebar` beside a
 * `component`, which invited the identical failure for a combination
 * {@link client} can simply render.
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
   * Tool display config: icon and label overrides keyed by tool name.
   *
   * Honoured with a custom `component` too: {@link client} installs it into
   * `ToolConfigContext`, and the consumer is `ToolCallBlock` — which a custom
   * component renders as soon as it uses `MessageList` or `ChatView`, the usual
   * way to build one.
   */
  tools?: ToolDisplayConfig;
};

/**
 * Handle returned by {@link client} for cleanup.
 *
 * Implements `Disposable` so it can be used with `using`.
 *
 * @public
 */
export type ClientHandle = {
  /** The underlying session core. */
  session: SessionCore;
  /** Unmount the UI and disconnect the session. */
  dispose(): void;
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

// ─── Internal helpers ─────────────────────────────────────────────────────────

/**
 * The element a mount renders into.
 *
 * Exported so `page()` resolves its target the same way `client()` does — the
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
  /** Unmount the React tree (and, for `client()`, dispose the session). */
  dispose(): void;
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Render `node` into `container` and hand back its teardown.
 *
 * Shared by {@link client} and `page()` because the plumbing is identical and
 * the two decisions in it are not obvious enough to be re-derived: the root is
 * created here rather than by the caller so nothing else can hold one, and the
 * render is `flushSync` so the mount is observable to the caller's NEXT
 * STATEMENT (and to a test) rather than scheduled — `client()` returns a handle
 * whose session is expected to be live, and `page()` returns one a caller may
 * dispose immediately.
 *
 * `onDispose` runs after the unmount, which is the order `client()` needs: the
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
    // exactly what `client()` does to add `session`) or after a caller replaces
    // `dispose` on the object it was handed.
    [Symbol.dispose]() {
      this.dispose();
    },
  };
}

/**
 * Default shell rendered in config tier.
 * Wraps StartScreen → (SidebarLayout →) ChatView.
 */
function DefaultShell({
  name,
  Sidebar,
  sidebarWidth,
}: {
  name?: string | undefined;
  Sidebar?: ComponentType | undefined;
  sidebarWidth?: string | undefined;
}) {
  const chat = <ChatView title={name} />;

  return (
    <StartScreen title={name}>
      {Sidebar ? (
        <SidebarLayout sidebar={<Sidebar />} sidebarWidth={sidebarWidth}>
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
 * `client({ name })` the request was issued and its answer thrown away — and on
 * the platform this endpoint is the BROKER, so the discarded request is one that
 * can boot a sandbox. The session's own per-attempt lookup
 * (`session-core.ts`'s URL provider) is a different question and deliberately
 * left alone: it re-brokers on every connection attempt, which is what makes a
 * reconnect land on a REPLACEMENT sandbox, so it may not be served from
 * anything this render already has.
 */
function DefaultRoot({
  platformUrl,
  name,
  Sidebar,
  sidebarWidth,
}: {
  platformUrl: string;
  name?: string | undefined;
  Sidebar?: ComponentType | undefined;
  sidebarWidth?: string | undefined;
}) {
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

  // An explicit client({ name }) wins; otherwise use the server-declared name.
  return (
    <DefaultShell name={name ?? resolved?.name} Sidebar={Sidebar} sidebarWidth={sidebarWidth} />
  );
}

/**
 * The tree under the providers: the caller's component, or the default shell.
 *
 * A custom component owns the whole page, so there is no header to hang a
 * `sidebar` off — but the layout the default shell uses is right here, and
 * `client({ component, sidebar })` names one pane and one aside, which is
 * exactly what it renders. Honouring the combination rather than ignoring it is
 * the same call this file already made for `name` and `tools`.
 */
function rootFor(config: ClientConfig, platformUrl: string) {
  const Custom = config.component;
  if (!Custom) {
    return (
      <DefaultRoot
        platformUrl={platformUrl}
        name={config.name}
        Sidebar={config.sidebar}
        sidebarWidth={config.sidebarWidth}
      />
    );
  }
  const Sidebar = config.sidebar;
  if (!Sidebar) return <Custom />;
  return (
    <SidebarLayout sidebar={<Sidebar />} sidebarWidth={config.sidebarWidth}>
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
 * import { client } from "@alexkroman1/aai-ui";
 *
 * function OrderPanel() {
 *   return <div>Cart</div>;
 * }
 *
 * client({
 *   name: "Pizza Ordering",
 *   theme: { bg: "#1a1a1a", primary: "#e55" },
 *   sidebar: OrderPanel,
 *   tools: { add_pizza: { icon: "🍕", label: "Adding pizza" } },
 * });
 * ```
 *
 * @example A custom component
 * ```tsx
 * import { client, useSession } from "@alexkroman1/aai-ui";
 *
 * function MyCustomApp() {
 *   const session = useSession();
 *   return <div>{session.state}</div>;
 * }
 *
 * client({ component: MyCustomApp });
 * ```
 *
 * @returns A {@link ClientHandle} for cleanup.
 * @throws If the target element is not found in the DOM.
 *
 * @public
 */
export function client(config: ClientConfig): ClientHandle {
  const container = resolveContainer(config.target);

  const platformUrl = config.platformUrl ?? pageBaseUrl();

  const session = createSessionCore({
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
      () => session[Symbol.dispose](),
    ),
  };
}
