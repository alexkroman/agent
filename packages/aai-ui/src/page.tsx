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
 * `useWorkflowSubmit()` / `useWorkflowRun()`, neither of which needs a client
 * built for it.
 *
 * And `component` is OPTIONAL, the way `mountClient()`'s is: with none, this
 * mounts the generated shell in `_page-shell.tsx`. That is also what a workflow
 * app with NO `client.tsx` at all now gets — `default-client.tsx`, the prebuilt
 * page, branches on the agent's declared front door and mounts this.
 */

import { type ComponentType, createElement } from "react";
import { DefaultPageShell } from "./_page-shell.tsx";
import { setPageTitle } from "./_utils.ts";
import { ThemeProvider } from "./context.ts";
import { mountRoot, resolveContainer } from "./define-client.tsx";
import type { ClientTheme } from "./types.ts";

/**
 * Configuration for {@link mountPage}.
 *
 * @public
 */
export type PageConfig = {
  /**
   * The root component, rendered instead of the generated shell.
   *
   * **Optional**, the way `mountClient()`'s is: leave it out and `mountPage()`
   * renders a form per declared workflow, the run's progress, its failure and
   * its output — see `_page-shell.tsx` for what that shell is composed of and
   * why it is deliberately functional rather than designed. It was REQUIRED,
   * because "a workflow app has no default shell to fall back to" — true of a
   * session and false of the page, and it cost the six shipped workflow
   * templates 220-511 lines each of the same composition.
   */
  component?: ComponentType;
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
 * Handle returned by {@link mountPage}. `Disposable`, so `using` works.
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
 * There is deliberately no session, no microphone, and no socket: the page talks
 * to the agent over the workflow HTTP API (`useWorkflowSubmit`/`useWorkflowRun`),
 * which is durable and outlives the tab.
 *
 * **Config only:** leave `component` out and the generated shell renders — a
 * form per declared workflow, the run's progress, its failure, its output.
 *
 * **A custom component:** pass `component` and it is rendered inside the theme
 * provider instead. The pieces the default shell is built from are all published
 * (`useWorkflows`, `<WorkflowFields>`, `useWorkflowSubmit`,
 * `<WorkflowProgress>`, `<WorkflowRunError>`), so replacing the shell does not
 * mean starting from `fetch`.
 *
 * @example The default shell
 * ```tsx
 * import { mountPage } from "@alexkroman1/aai-ui";
 *
 * mountPage({ name: "Digest" });
 * ```
 *
 * @example A custom component
 * ```tsx
 * import { mountPage, useWorkflows } from "@alexkroman1/aai-ui";
 *
 * function App() {
 *   // No client to build and none to hoist: every workflow hook defaults to one
 *   // aimed at the agent serving this page, built lazily and once.
 *   const { workflows, loading } = useWorkflows();
 *   if (loading) return <p>Loading…</p>;
 *   return (
 *     <ul>
 *       {workflows.map((entry) => (
 *         <li key={entry.name}>{entry.description ?? entry.name}</li>
 *       ))}
 *     </ul>
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
export function mountPage(config: PageConfig = {}): PageHandle {
  const container = resolveContainer(config.target);

  setPageTitle(config.name);

  // The mount itself is `mountClient()`'s — one copy of the root, the `flushSync`
  // and the disposable handle. What differs is only the tree: no session
  // provider, no tool-config context, because there is no session.
  const Root = config.component;

  return mountRoot(
    container,
    createElement(
      ThemeProvider,
      { value: config.theme },
      // The name is forwarded rather than looked up twice: the shell asks the
      // agent for its own `name` and `greeting`, and an explicit one here wins
      // — the same precedence `mountClient()`'s default shell applies.
      Root ? createElement(Root) : createElement(DefaultPageShell, { name: config.name }),
    ),
  );
}
