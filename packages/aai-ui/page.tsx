// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * `page()` — mount a STATIC agent page: React, theme, no session.
 *
 * The twin of `client()` for an app whose front door is a form rather than a
 * microphone (`agent({ page: "static" })`). It is a separate entry rather than
 * an option on `client()` because of what `client()` unavoidably does: it
 * constructs a `SessionCore`, which owns a WebSocket URL provider, an audio
 * graph, and a microphone request. A flag would have to make all of that
 * conditional, and every session hook would then have to answer "what does this
 * mean with no session?" — so the honest split is two mounts. A page that wants
 * voice uses `client()`; a page that wants neither audio nor a socket uses this.
 *
 * Authoring is otherwise identical — the file is still `client.tsx`, still
 * React, still Tailwind — so the workflow templates read like every other
 * template. What they reach for instead of `useSession()` is
 * `createWorkflowApi()` / `useWorkflowRun()`.
 */

import { type ComponentType, createElement } from "react";
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "./context.ts";
import { resolveContainer } from "./define-client.tsx";
import type { ClientTheme } from "./types.ts";

/**
 * Configuration for {@link page}.
 *
 * @public
 */
export type PageConfig = {
  /** The root component. Required — a static page has no default shell to fall back to. */
  component: ComponentType;
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /**
   * Page title. Set only when given, so a title the HTML shell declared is
   * never clobbered — the same rule `client()`'s custom-component tier follows.
   */
  name?: string;
  /** Theme color overrides, read by the same tokens the voice components use. */
  theme?: ClientTheme;
};

/**
 * Handle returned by {@link page}. `Disposable`, so `using` works.
 *
 * @public
 */
export type PageHandle = {
  /** Unmount the React tree. */
  dispose(): void;
  [Symbol.dispose](): void;
};

/**
 * Mount a static page for an agent whose work happens in workflows.
 *
 * There is deliberately no session, no microphone, and no socket: the component
 * talks to the agent over the workflow HTTP API
 * (`createWorkflowApi`/`useWorkflowRun`), which is durable and outlives the tab.
 *
 * @example
 * ```tsx
 * import { page, useWorkflowRun, createWorkflowApi } from "@alexkroman1/aai-ui";
 * import { useState } from "react";
 *
 * const api = createWorkflowApi();
 *
 * function App() {
 *   const [runId, setRunId] = useState<string>();
 *   const { run } = useWorkflowRun(runId, { api });
 *   return (
 *     <button type="button" onClick={() => void api.start("digest", { topic: "ai" }).then(setRunId)}>
 *       {run ? run.status : "Start"}
 *     </button>
 *   );
 * }
 *
 * page({ name: "Digest", component: App });
 * ```
 *
 * @throws If the target element is not found in the DOM.
 *
 * @public
 */
export function page(config: PageConfig): PageHandle {
  const container = resolveContainer(config.target);

  if (config.name && typeof document !== "undefined") document.title = config.name;

  const root = createRoot(container);
  // `flushSync` for the same reason `client()` uses it: the mount must be
  // observable to the caller's next statement (and to a test) rather than
  // scheduled.
  flushSync(() => {
    root.render(
      createElement(ThemeProvider, { value: config.theme }, createElement(config.component)),
    );
  });

  const handle: PageHandle = {
    dispose() {
      root.unmount();
    },
    [Symbol.dispose]() {
      handle.dispose();
    },
  };
  return handle;
}
