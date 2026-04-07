// Copyright 2025 the AAI authors. MIT license.

import type { ComponentType } from "preact";
// biome-ignore lint/suspicious/noDeprecatedImports: preact v10 render API is current
import { render } from "preact";
import { ClientConfigProvider, type ClientTheme } from "./client-context.ts";
import { createVoiceSession, type VoiceSession, type WebSocketConstructor } from "./session.ts";
import { SessionProvider } from "./signals.ts";

/**
 * Options for {@link defineClient}.
 *
 * @public
 */
export type ClientOptions = {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /** Agent title shown in the header and start screen. */
  title?: string;
  /** Theme color overrides. */
  theme?: ClientTheme;
  /** Called when the server sends a session ID. Store it for reconnection. */
  onSessionId?: ((sessionId: string) => void) | undefined;
  /** Session ID from a previous connection for resuming persisted state. */
  resumeSessionId?: string | undefined;
  /** WebSocket constructor override. Passed through to VoiceSessionOptions. */
  WebSocket?: WebSocketConstructor | undefined;
};

/**
 * Handle returned by {@link defineClient} for cleanup.
 *
 * Implements `Disposable` so it can be used with `using`.
 *
 * @public
 */
export type ClientHandle = {
  /** The underlying voice session. */
  session: VoiceSession;
  /** Unmount the UI, remove injected styles, and disconnect the session. */
  dispose(): void;
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

function resolveContainer(target: string | HTMLElement = "#app"): HTMLElement {
  if (typeof target !== "string") return target;
  const el = document.querySelector<HTMLElement>(target);
  if (!el) throw new Error(`Element not found: ${target}`);
  return el;
}

/**
 * Define and mount a client UI for a voice agent.
 *
 * Creates a {@link VoiceSession} and renders the component
 * inside a {@link SessionProvider}.
 *
 * @param Component - The Preact component to render.
 * @param options - Client options (target element, platform URL, theme).
 * @returns A {@link ClientHandle} for cleanup.
 * @throws If the target element is not found in the DOM.
 *
 * @public
 */
// biome-ignore lint/suspicious/noExplicitAny: defineClient accepts any component
export function defineClient(Component: ComponentType<any>, options?: ClientOptions): ClientHandle {
  const container = resolveContainer(options?.target);

  const platformUrl =
    options?.platformUrl ?? globalThis.location.origin + globalThis.location.pathname;
  const session = createVoiceSession({
    platformUrl,
    onSessionId: options?.onSessionId,
    resumeSessionId: options?.resumeSessionId,
    ...(options?.WebSocket ? { WebSocket: options.WebSocket } : {}),
  });

  const clientConfig = { title: options?.title, theme: options?.theme };

  // Apply theme overrides as CSS custom properties on the container.
  if (options?.theme) {
    const t = options.theme;
    const el = container;
    if (t.bg) el.style.setProperty("--color-aai-bg", t.bg);
    if (t.primary) el.style.setProperty("--color-aai-primary", t.primary);
    if (t.text) el.style.setProperty("--color-aai-text", t.text);
    if (t.surface) el.style.setProperty("--color-aai-surface", t.surface);
    if (t.border) el.style.setProperty("--color-aai-border", t.border);
  }

  render(
    <ClientConfigProvider value={clientConfig}>
      <SessionProvider value={session}>
        <Component />
      </SessionProvider>
    </ClientConfigProvider>,
    container,
  );

  const handle: ClientHandle = {
    session,
    dispose() {
      render(null, container);
      session[Symbol.dispose]();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}
