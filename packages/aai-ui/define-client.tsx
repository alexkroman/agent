// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { type ComponentType, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ChatView } from "./components/chat-view.tsx";
import { SidebarLayout } from "./components/sidebar-layout.tsx";
import { StartScreen } from "./components/start-screen.tsx";
import { ToolConfigContext, type ToolDisplayConfig } from "./components/tool-config-context.ts";
import { SessionProvider, ThemeProvider } from "./context.ts";
import { createSessionCore, type SessionCore, type WebSocketConstructor } from "./session-core.ts";
import type { ClientTheme } from "./types.ts";

// ─── Config types ─────────────────────────────────────────────────────────────

/**
 * Base options shared by both client tiers.
 *
 * @public
 */
type BaseOptions = {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /** Theme color overrides. */
  theme?: ClientTheme;
  /** Called when the server sends a session ID. Store it for reconnection. */
  onSessionId?: (sessionId: string) => void;
  /** Session ID from a previous connection for resuming persisted state. */
  resumeSessionId?: string;
  /** WebSocket constructor override. Passed through to session options. */
  WebSocket?: WebSocketConstructor;
};

/**
 * Tier 1: Config-only options. Renders the default shell (StartScreen + ChatView).
 *
 * @public
 */
type ConfigTier = BaseOptions & {
  component?: never;
  /** Agent name shown in the header and start screen. */
  name?: string;
  /** Optional sidebar component rendered alongside the chat view. */
  sidebar?: ComponentType;
  /** CSS width of the sidebar. Defaults to `"18rem"`. */
  sidebarWidth?: string;
  /** Tool display config: icon and label overrides keyed by tool name. */
  tools?: ToolDisplayConfig;
};

/**
 * Tier 2: Custom component. Renders the provided component inside the providers.
 *
 * @public
 */
type ComponentTier = BaseOptions & {
  /** Full custom component to render instead of the default shell. */
  component: ComponentType;
  name?: never;
  sidebar?: never;
  sidebarWidth?: never;
  tools?: never;
};

/**
 * Configuration passed to {@link client}.
 *
 * @public
 */
export type ClientConfig = ConfigTier | ComponentTier;

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

function resolveContainer(target: string | HTMLElement = "#app"): HTMLElement {
  if (typeof target !== "string") return target;
  const el = document.querySelector<HTMLElement>(target);
  if (!el) throw new Error(`Element not found: ${target}`);
  return el;
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
  name?: string;
  Sidebar?: ComponentType;
  sidebarWidth?: string;
}) {
  const chat = <ChatView {...(name !== undefined ? { title: name } : {})} />;

  const inner = Sidebar ? (
    <SidebarLayout sidebar={<Sidebar />} {...(sidebarWidth !== undefined ? { sidebarWidth } : {})}>
      {chat}
    </SidebarLayout>
  ) : (
    chat
  );

  return <StartScreen {...(name !== undefined ? { title: name } : {})}>{inner}</StartScreen>;
}

// ─── client ──────────────────────────────────────────────────────────────────

/**
 * Define and mount a client UI for a voice agent.
 *
 * **Tier 1 (config-only):** Pass options without `component` to get the
 * default shell (StartScreen + ChatView, optional sidebar).
 *
 * **Tier 2 (custom component):** Pass `component` to render a fully custom
 * root component inside the providers.
 *
 * @example Tier 1
 * ```tsx
 * client({
 *   name: "Pizza Ordering",
 *   theme: { bg: "#1a1a1a", primary: "#e55" },
 *   sidebar: OrderPanel,
 *   tools: { add_pizza: { icon: "🍕", label: "Adding pizza" } },
 * });
 * ```
 *
 * @example Tier 2
 * ```tsx
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

  const platformUrl =
    config.platformUrl ?? globalThis.location.origin + globalThis.location.pathname;

  const session = createSessionCore({
    platformUrl,
    onSessionId: config.onSessionId,
    resumeSessionId: config.resumeSessionId,
    ...(config.WebSocket ? { WebSocket: config.WebSocket } : {}),
  });

  // Determine the root component.
  let RootComponent: ComponentType;
  if ("component" in config && config.component) {
    RootComponent = config.component;
  } else {
    const cfg = config as ConfigTier;
    const { name, sidebar: Sidebar, sidebarWidth } = cfg;
    RootComponent = () =>
      createElement(DefaultShell, {
        ...(name !== undefined ? { name } : {}),
        ...(Sidebar !== undefined ? { Sidebar } : {}),
        ...(sidebarWidth !== undefined ? { sidebarWidth } : {}),
      });
  }

  const toolConfig: ToolDisplayConfig = "tools" in config && config.tools ? config.tools : {};

  const root = createRoot(container);
  flushSync(() => {
    root.render(
      createElement(
        ToolConfigContext.Provider,
        { value: toolConfig },
        createElement(
          ThemeProvider,
          config.theme !== undefined ? { value: config.theme } : {},
          createElement(SessionProvider, { value: session }, createElement(RootComponent)),
        ),
      ),
    );
  });

  const handle: ClientHandle = {
    session,
    dispose() {
      root.unmount();
      session[Symbol.dispose]();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}

/** @deprecated Use {@link client} instead. */
export const defineClient = client;
