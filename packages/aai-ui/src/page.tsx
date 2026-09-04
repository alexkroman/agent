// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * `mountPage()` — mount a WORKFLOW APP's UI: React, theme, no session.
 *
 * The twin of `mountClient()` for an agent whose front door is a form rather than a
 * microphone (`workflowApp()`). It is a separate entry rather than
 * an option on `mountClient()` because of what `mountClient()` unavoidably does: it
 * constructs a `BrowserSession`, which owns a WebSocket URL provider, an audio
 * graph, and a microphone request. A flag would have to make all of that
 * conditional, and every session hook would then have to answer "what does this
 * mean with no session?" — so the honest split is two mounts. A page that wants
 * voice uses `mountClient()`; a page that wants neither audio nor a socket uses this.
 *
 * Authoring is otherwise identical — the file is still `client.tsx`, still
 * React, still Tailwind, still the same theme tokens — so a workflow app reads
 * like every other agent. What it reaches for instead of `useSession()` is
 * `createWorkflowApi()` / `useWorkflowRun()`.
 */

import { type ComponentType, createElement } from "react";
import { setPageTitle } from "./_utils.ts";
import { ThemeProvider } from "./context.ts";
import { mountRoot, resolveContainer } from "./define-client.tsx";
import type { ClientTheme } from "./types.ts";

/**
 * Configuration for {@link page}.
 *
 * @public
 */
export type PageConfig = {
  /**
   * The root component. Required — a workflow app has no default shell to fall
   * back to, because there is no session for one to render.
   */
  component: ComponentType;
  /** CSS selector or DOM element to render into. Defaults to `"#app"`. */
  target?: string | HTMLElement;
  /**
   * Page title. Set only when given, so a title the HTML shell declared is never
   * clobbered — the same rule `mountClient()`'s custom-component tier follows.
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
  /** Alias for `dispose` for use with `using`. */
  [Symbol.dispose](): void;
};

/**
 * Mount a page for an agent whose work happens in workflows.
 *
 * There is deliberately no session, no microphone, and no socket: the component
 * talks to the agent over the workflow HTTP API
 * (`createWorkflowApi`/`useWorkflowRun`), which is durable and outlives the tab.
 *
 * @example
 * ```tsx
 * import { createWorkflowApi, mountPage, useWorkflowRun } from "@alexkroman1/aai-ui";
 * import { useState } from "react";
 *
 * // Hoisted: a client built in render is a new object every render.
 * const api = createWorkflowApi();
 *
 * function App() {
 *   const [runId, setRunId] = useState<string>();
 *   const { run } = useWorkflowRun(runId, { api });
 *   return (
 *     <button
 *       type="button"
 *       onClick={() => void api.start("digest", { topic: "ai" }).then(setRunId)}
 *     >
 *       {run ? run.status : "Start"}
 *     </button>
 *   );
 * }
 *
 * mountPage({ name: "Digest", component: App });
 * ```
 *
 * @throws If the target element is not found in the DOM.
 *
 * @public
 */
export function mountPage(config: PageConfig): PageHandle {
  const container = resolveContainer(config.target);

  setPageTitle(config.name);

  // The mount itself is `mountClient()`'s — one copy of the root, the `flushSync`
  // and the disposable handle. What differs is only the tree: no session
  // provider, no tool-config context, because there is no session.
  return mountRoot(
    container,
    createElement(ThemeProvider, { value: config.theme }, createElement(config.component)),
  );
}
