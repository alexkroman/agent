// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { type ComponentType, createElement, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { buildAgentUrl, type ClientConfigResponse, fetchClientConfig } from "./client-config.ts";
import { ChatView } from "./components/chat-view.tsx";
import { SidebarLayout } from "./components/sidebar-layout.tsx";
import { StartScreen } from "./components/start-screen.tsx";
import { SyncChatView } from "./components/sync-chat-view.tsx";
import { ToolConfigContext, type ToolDisplayConfig } from "./components/tool-config-context.ts";
import { SessionProvider, ThemeProvider } from "./context.ts";
import { createSessionCore, type SessionCore } from "./session-core.ts";
import type { ClientTheme, WebSocketConstructor } from "./types.ts";

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
  /**
   * Transport the UI talks over. Unset (the default) asks the server via
   * `GET client-config`, so `agent({ transport })` decides — an agent that
   * declared `transport: "sync"` gets the sync shell (HTTP turns, no
   * WebSocket) with no custom client needed. An explicit value here skips
   * the lookup. Only the config tier branches on it; a custom `component`
   * owns its own transport.
   */
  transport?: "websocket" | "sync";
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
 * Config-tier root: resolves the transport (explicit option, else the
 * server's `GET client-config`) and renders the WebSocket shell or the
 * sync shell.
 *
 * The WebSocket shell renders immediately — optimistically — while the
 * lookup is in flight, then swaps if the agent declared `"sync"`. That
 * keeps mounting synchronous, keeps agents on servers without the endpoint
 * (every lookup failure resolves to `"websocket"`) exactly as before, and
 * the worst-case race — Start clicked on a sync agent before the lookup
 * lands — still yields a working session: sync agents answer WebSocket
 * sessions too.
 */
function DefaultRoot({
  platformUrl,
  transport,
  name,
  Sidebar,
  sidebarWidth,
}: {
  platformUrl: string;
  transport?: "websocket" | "sync" | undefined;
  name?: string | undefined;
  Sidebar?: ComponentType | undefined;
  sidebarWidth?: string | undefined;
}) {
  const [resolved, setResolved] = useState<ClientConfigResponse | null>(
    transport !== undefined ? { transport } : null,
  );

  useEffect(() => {
    if (transport !== undefined) return;
    let cancelled = false;
    void fetchClientConfig(platformUrl).then((cfg) => {
      if (!cancelled) setResolved(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [platformUrl, transport]);

  if (resolved?.transport === "sync") {
    return (
      <SyncChatView
        syncUrl={buildAgentUrl(platformUrl, "sync").href}
        title={name ?? resolved.name}
        greeting={resolved.greeting}
      />
    );
  }
  return <DefaultShell name={name} Sidebar={Sidebar} sidebarWidth={sidebarWidth} />;
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
    WebSocket: config.WebSocket,
  });

  const rootNode = config.component
    ? createElement(config.component)
    : createElement(DefaultRoot, {
        platformUrl,
        transport: config.transport,
        name: config.name,
        Sidebar: config.sidebar,
        sidebarWidth: config.sidebarWidth,
      });

  const toolConfig: ToolDisplayConfig = config.tools ?? {};

  const root = createRoot(container);
  flushSync(() => {
    root.render(
      createElement(
        ToolConfigContext.Provider,
        { value: toolConfig },
        createElement(
          ThemeProvider,
          { value: config.theme },
          createElement(SessionProvider, { value: session }, rootNode),
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
