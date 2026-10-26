// Copyright 2025 the AAI authors. MIT license.

/** @jsxImportSource react */

import { type ComponentType, createElement, type ReactNode, useEffect, useState } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { pageBaseUrl } from "./_utils.ts";
import { type ClientConfigResponse, fetchClientConfig } from "./client-config.ts";
import { ChatView } from "./components/chat-view.tsx";
import { SidebarLayout } from "./components/sidebar-layout.tsx";
import { StartScreen } from "./components/start-screen.tsx";
import { EMPTY_TOOL_DISPLAY, ToolConfigContext } from "./components/tool-config-context.ts";
import { SessionProvider, ThemeProvider, useSessionSelector } from "./context.ts";
import type { BrowserSession, SessionSnapshot } from "./session/index.ts";
import { createBrowserSession } from "./session/index.ts";
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
 * and the failure that shape produces is recorded in this file's history:
 * `sidebar` beside a `component` was the natural thing to write, was refused
 * with *"Type '…' is not assignable to type 'undefined'"*, and cost a build
 * round each time, for a combination {@link mountClient} can simply render.
 *
 * The agent's name and each tool's icon and label are not options here: both
 * come from the agent's own `GET /client-config` body — `agent({ name })` and
 * `tool({ ui })` — which the mount looks up, so a page never restates what the
 * agent already declared.
 *
 * @input
 * @public
 */
export type ClientConfig = Pick<
  VoiceSessionOptions,
  "onSessionId" | "resumeSessionId" | "location" | "phone" | "client" | "token" | "WebSocket"
> & {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /**
   * Theme colors — the five tokens, or `{ primary, mode: "dark" | "light" }`
   * with the rest derived. See {@link ClientTheme}.
   */
  theme?: ClientTheme;
  /**
   * A stylesheet for the PAGE, injected into `<head>` for the life of the
   * mount and removed on dispose.
   *
   * For the rules a custom chrome has that no component prop reaches — a
   * `@keyframes`, a scrollbar palette, a font face — which otherwise meant a
   * `<style>` element written into `index.html` beside the mount, in the one
   * file the scaffold's CSP is strict about. The five theme tokens are already
   * on `:root` as `--aai-*` when these rules run, so a sheet may use them.
   */
  css?: string;
  /**
   * Full custom component to render instead of the default shell.
   *
   * It is rendered inside the same providers the default shell gets, so every
   * session hook, `useTheme` and the tool display config work in it unchanged.
   */
  component?: ComponentType;
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
};

/**
 * Handle returned by {@link mountClient} for cleanup.
 *
 * Implements `Disposable` so it can be used with `using`.
 *
 * @sealed
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
  if (!el) {
    throw new Error(
      `Element not found: ${target} — no element matches that selector when the mount runs. ` +
        `Add \`<div id="app"></div>\` (or the element your selector names) to the page before the script, ` +
        "or pass the element itself as the mount's `target` option.",
    );
  }
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
 * components underneath it accept, so `tabletop-rpg-agent` — which wants a right-hand
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
    "icon" | "subtitle" | "buttonText" | "sidebarWidth" | "sidebarPosition"
  >]: ClientConfig[K] | undefined;
} & {
  /** The agent's declared name, from the mount's lookup — none until it lands. */
  name: string | undefined;
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
 * The session-config lookup the mount makes, and WHEN.
 *
 * The response feeds two things: the default shell's title (the agent's own
 * declared name), and every tool's declared icon and label (`tools`), which a
 * custom component's `ToolCallBlock` reads too. The timing rule is the one
 * this file has always had, kept because on the platform this endpoint is the
 * BROKER and a request to it can boot a sandbox: the lookup is issued at mount
 * only when the default shell renders, since its start card needs the name;
 * under a custom `component` it waits until the session has STARTED — at
 * which point the session's own per-attempt lookup is booting that sandbox
 * anyway, so the second request costs no boot. Either way it is issued once;
 * the session's own lookup stays separate (it re-brokers per attempt, which
 * this must not interfere with — see `session/dial.ts`).
 */
function useMountLookup(platformUrl: string, eager: boolean): ClientConfigResponse | null {
  const started = useSessionSelector(selectStarted);
  const wanted = eager || started;
  const [resolved, setResolved] = useState<ClientConfigResponse | null>(null);
  useEffect(() => {
    if (!wanted || resolved !== null) return;
    let cancelled = false;
    void fetchClientConfig({ platformUrl }).then((cfg) => {
      if (!cancelled) setResolved(cfg);
    });
    return () => {
      cancelled = true;
    };
  }, [platformUrl, wanted, resolved]);
  return resolved;
}

/** Module-scope, for the reason `context.ts` hoists its own two selectors. */
const selectStarted = (snapshot: SessionSnapshot): boolean => snapshot.started;

/**
 * The page-level stylesheet `mountClient({ css })` injects — see that field.
 * A `<style>` in `<head>` rather than inline on an element, so `@keyframes`,
 * `@font-face` and pseudo-element rules all work; removed on unmount so a
 * client disposed mid-page leaves the page as it found it.
 */
function PageCss({ css }: { css: string | undefined }): null {
  useEffect(() => {
    if (css === undefined || css === "" || typeof document === "undefined") return;
    const style = document.createElement("style");
    style.setAttribute("data-aai-css", "");
    style.textContent = css;
    document.head.appendChild(style);
    return () => {
      style.remove();
    };
  }, [css]);
  return null;
}

/**
 * Everything under the session provider: the lookup, the two display
 * contexts, the page stylesheet, then the caller's component or the default
 * shell. Inside `SessionProvider` because the lookup's timing reads the
 * session (`useMountLookup`).
 */
function ClientRoot({ config, platformUrl }: { config: ClientConfig; platformUrl: string }) {
  const resolved = useMountLookup(platformUrl, config.component === undefined);
  // The tool display config IS the agent's declaration (`tool({ ui })`, served
  // in the lookup); a page has no map of its own to merge over it.
  return (
    <ToolConfigContext.Provider value={resolved?.tools ?? EMPTY_TOOL_DISPLAY}>
      <ThemeProvider value={config.theme}>
        <PageCss css={config.css} />
        {rootFor(config, resolved?.name)}
      </ThemeProvider>
    </ToolConfigContext.Provider>
  );
}

/**
 * The tree under the providers: the caller's component, or the default shell.
 *
 * A custom component owns the whole page, so there is no header to hang a
 * `sidebar` off — but the layout the default shell uses is right here, and
 * `mountClient({ component, sidebar })` names one pane and one aside, which is
 * exactly what it renders. Honouring the combination rather than ignoring it is
 * the same call this file makes for every display field.
 *
 * The default shell renders immediately — optimistically — without a name;
 * `serverName` arrives from the mount's lookup, which is the agent's own
 * `agent({ name })`.
 */
function rootFor(config: ClientConfig, serverName: string | undefined) {
  const Custom = config.component;
  const Sidebar = config.sidebar;
  if (!Custom) {
    return (
      <DefaultShell
        name={serverName}
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
 * in the same {@link SidebarLayout}. The page title is the HTML's own; a
 * custom component that wants another sets `document.title` itself.
 *
 * The agent's name on the start card and in the header, and each tool's icon
 * and label, are what the agent declared (`agent({ name })`, `tool({ ui })`),
 * read from its `GET /client-config` body — not options here.
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
 *   theme: { bg: "#1a1a1a", primary: "#e55" },
 *   sidebar: OrderPanel,
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
  return mountClientWith(config, createBrowserSession);
}

/**
 * {@link mountClient} with the session factory handed in. Not on the barrel:
 * it is the seam a spec drives with a fake core rather than replacing the
 * session module.
 */
export function mountClientWith(
  config: ClientConfig,
  createSession: typeof createBrowserSession,
): ClientHandle {
  const container = resolveContainer(config.target);

  const platformUrl = config.platformUrl ?? pageBaseUrl();

  const session = createSession({
    platformUrl,
    onSessionId: config.onSessionId,
    resumeSessionId: config.resumeSessionId,
    location: config.location,
    phone: config.phone,
    client: config.client,
    token: config.token,
    WebSocket: config.WebSocket,
  });

  return {
    session,
    ...mountRoot(
      container,
      createElement(
        SessionProvider,
        { value: session },
        createElement(ClientRoot, { config, platformUrl }),
      ),
      // Baselined under `guard-invariants` rule 27: a teardown THUNK handed to
      // the React root, which calls it on unmount. A callback is not a scope,
      // so `using` has nothing to attach the lifetime to — the session outlives
      // this function by design and the root owns when it ends. Not a
      // `DisposableStack` inside `mountRoot` either: that is a runtime global
      // this browser bundle (target es2022, no polyfill) cannot assume.
      () => session[Symbol.dispose](),
    ),
  };
}
