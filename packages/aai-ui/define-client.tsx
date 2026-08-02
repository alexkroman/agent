// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { type ComponentType, createElement, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { pageBaseUrl } from "./_utils.ts";
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
 * Base options shared by both client tiers.
 *
 * The session-forwarded fields are picked from {@link VoiceSessionOptions}
 * (one source of truth for types and docs) rather than re-declared — a
 * re-declared copy is exactly how doc comments drift.
 *
 * @public
 */
type BaseOptions = Pick<VoiceSessionOptions, "onSessionId" | "resumeSessionId" | "WebSocket"> & {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /** Theme color overrides. */
  theme?: ClientTheme;
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
  /**
   * Agent name. With a custom component there is no shell header to put it
   * in, so it becomes the page title.
   *
   * Allowed here rather than `never` because `client({ name, component })` is
   * the natural thing to write and two different models wrote it. As `never`
   * it failed with *"Type 'string' is not assignable to type 'undefined'"*,
   * which explains nothing, and cost a build round each time. There is a real
   * use for the value — a custom-UI page otherwise inherits whatever title
   * the HTML shell shipped with — so it is honoured instead of banned.
   */
  name?: string;
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
 * Config-tier root: fetches the server-declared display name via
 * `GET client-config` and renders the chat shell. The shell renders
 * immediately — optimistically — while the lookup is in flight; servers
 * without the endpoint (every lookup failure resolves to the empty default)
 * work exactly as before.
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

  useEffect(() => {
    let cancelled = false;
    void fetchClientConfig(platformUrl).then((cfg) => {
      if (!cancelled) setResolved(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [platformUrl]);

  // An explicit client({ name }) wins; otherwise use the server-declared name.
  return (
    <DefaultShell name={name ?? resolved?.name} Sidebar={Sidebar} sidebarWidth={sidebarWidth} />
  );
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

  const platformUrl = config.platformUrl ?? pageBaseUrl();

  const session = createSessionCore({
    platformUrl,
    onSessionId: config.onSessionId,
    resumeSessionId: config.resumeSessionId,
    WebSocket: config.WebSocket,
  });

  // The default shell renders `name` in its header; a custom component has no
  // header, so the page title is where it goes. Only set when given — never
  // clobber a title the page's own HTML declared.
  if (config.name && typeof document !== "undefined") document.title = config.name;

  const rootNode = config.component
    ? createElement(config.component)
    : createElement(DefaultRoot, {
        platformUrl,
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
