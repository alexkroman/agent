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
 * Options shared by both {@link client} tiers (config-only and custom
 * component).
 *
 * The session-forwarded fields are picked from {@link VoiceSessionOptions}
 * (one source of truth for types and docs) rather than re-declared — a
 * re-declared copy is exactly how doc comments drift.
 *
 * @public
 */
export type BaseOptions = Pick<
  VoiceSessionOptions,
  "onSessionId" | "resumeSessionId" | "WebSocket"
> & {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /** Theme color overrides. */
  theme?: ClientTheme;
};

/**
 * Tier 1: config-only options — no `component`. Renders the default shell
 * (StartScreen + ChatView).
 *
 * @public
 */
export type ConfigTier = BaseOptions & {
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
 * Tier 2: custom component — renders the provided `component` inside the
 * providers instead of the default shell.
 *
 * @public
 */
export type ComponentTier = BaseOptions & {
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
  /**
   * Tool display config: icon and label overrides keyed by tool name.
   *
   * Allowed here for the same reason as `name` above, and it was found the
   * same way: four starters across an eval run wrote
   * `client({ component, tools })` and lost a build round each time to
   * *"Type '{ … }' is not assignable to type 'undefined'"*.
   *
   * Unlike `sidebar`/`sidebarWidth`, this is not a property of the default
   * shell. `client()` below wraps BOTH tiers in `ToolConfigContext.Provider`
   * from `config.tools ?? {}`, and the consumer is `ToolCallBlock` — which a
   * custom component renders as soon as it uses `MessageList` or `ChatView`,
   * the usual way to build one. So the value was always honoured at runtime;
   * only the type refused it.
   */
  tools?: ToolDisplayConfig;
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

// ─── client ──────────────────────────────────────────────────────────────────

/**
 * Define and mount a client UI for a voice agent.
 *
 * **Tier 1 (config-only):** Pass options without `component` to get the
 * default shell (StartScreen + ChatView, optional sidebar).
 *
 * **Tier 2 (custom component):** Pass `component` to render a fully custom
 * root component inside the providers. In this tier a provided `name` also
 * sets `document.title` (there is no shell header to show it in).
 *
 * Mounts into `target` — a CSS selector or DOM element, defaulting to
 * `"#app"` — and throws `Element not found: <target>` when the selector
 * matches nothing.
 *
 * @example Tier 1
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
 * @example Tier 2
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

  const rootNode = config.component
    ? createElement(config.component)
    : createElement(DefaultRoot, {
        platformUrl,
        name: config.name,
        Sidebar: config.sidebar,
        sidebarWidth: config.sidebarWidth,
      });

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
