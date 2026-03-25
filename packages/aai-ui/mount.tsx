// Copyright 2025 the AAI authors. MIT license.

import { batch, signal } from "@preact/signals";
import type { ComponentType } from "preact";
// biome-ignore lint/suspicious/noDeprecatedImports: preact v10 render API is current
import { render } from "preact";
import { MountConfigProvider, type MountTheme } from "./mount-context.ts";
import { createVoiceSession, type VoiceSession } from "./session.ts";
import { createSessionControls, SessionProvider, type SessionSignals } from "./signals.ts";

/**
 * Options for {@link mount}.
 *
 * @public
 */
export type MountOptions = {
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /** Base URL of the AAI platform server. Derived from `location.href` by default. */
  platformUrl?: string;
  /** Agent title shown in the header and start screen. */
  title?: string;
  /** Theme color overrides. */
  theme?: MountTheme;
};

/**
 * Handle returned by {@link mount} for cleanup.
 *
 * Implements `Disposable` so it can be used with `using`.
 *
 * @public
 */
export type MountHandle = {
  /** The underlying voice session. */
  session: VoiceSession;
  /** Reactive session controls for the mounted UI. */
  signals: SessionSignals;
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
 * Mount a Preact component with voice session wiring.
 *
 * Creates a {@link VoiceSession}, wraps it in
 * {@link SessionSignals}, and renders the component
 * inside a {@link SessionProvider}.
 *
 * @param Component - The Preact component to render.
 * @param options - Mount options (target element, platform URL).
 * @returns A {@link MountHandle} for cleanup.
 * @throws If the target element is not found in the DOM.
 *
 * @public
 */
// biome-ignore lint/suspicious/noExplicitAny: mount accepts any component
export function mount(Component: ComponentType<any>, options?: MountOptions): MountHandle {
  const container = resolveContainer(options?.target);

  const platformUrl =
    options?.platformUrl ?? globalThis.location.origin + globalThis.location.pathname;
  const session = createVoiceSession({ platformUrl, signal, batch });
  const signals = createSessionControls(session);

  const mountConfig = { title: options?.title, theme: options?.theme };

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
    <MountConfigProvider value={mountConfig}>
      <SessionProvider value={signals}>
        <Component />
      </SessionProvider>
    </MountConfigProvider>,
    container,
  );

  const handle: MountHandle = {
    session,
    signals,
    dispose() {
      render(null, container);
      signals.dispose();
      session.disconnect();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}
