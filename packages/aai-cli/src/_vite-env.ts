// Copyright 2025 the AAI authors. MIT license.

/**
 * Packages resolved from the project root rather than from whichever
 * `node_modules` happens to sit above the importing file.
 *
 * `@alexkroman1/aai-ui` declares React as a **peer** dependency — "my consumer
 * supplies it" — but a bundler resolves the bare `react/jsx-runtime` import
 * inside `aai-ui/dist/**` from that file's own real path, not from the
 * consumer's. Deduping states the peer contract in terms the bundler enforces.
 *
 * Both Vite entry points need it, for failures that look nothing alike:
 *
 * - `buildClient` (`client-bundler.ts`): the studio's build root is nowhere
 *   above `packages/aai-ui/dist`, and the production image installs prod deps
 *   only, so aai-ui's own devDependency copy of React is pruned there. Publish
 *   died with *"Rolldown failed to resolve import react/jsx-runtime"* while
 *   every local build passed.
 * - `viteDevConfig` (`_dev-server.ts`): a project whose SDK is LINKED rather
 *   than installed — `aai init` run inside this monorepo, which is how a
 *   template gets tested by hand — resolves aai-ui's React through the
 *   workspace's own store, so the page loads two physically distinct copies of
 *   the same version. Two Reacts break hooks: `useSession`/`useWorkflowRun`
 *   throw *"Invalid hook call"*, `<ThemeProvider>` unmounts, and the agent
 *   renders a BLANK PAGE whose console never names a package.
 *
 * An npm-installed project is unaffected either way, which is precisely why
 * this stayed invisible: the resolution is correct until the SDK is linked or
 * the tree is pruned. Guarded by `client-bundler.test.ts` (asserted against
 * aai-ui's own manifest, so a peer added there without being added here fails).
 */
export const DEDUPED_PEERS = ["react", "react-dom"];

/**
 * Run a Vite build without letting it mutate the calling process's env.
 *
 * Vite's `build()` sets `process.env.NODE_ENV = "production"` when NODE_ENV is
 * unset — a global, permanent side effect on whatever process invoked it. That
 * is fine for a one-shot `aai build`, but both long-lived callers are broken by
 * it:
 *
 * - `aai dev` rebuilds on every file change, so the first rebuild would flip
 *   the dev server into production mode.
 * - The platform studio builds inside the server process, where flipping
 *   NODE_ENV switches the server into production behavior (strict credential
 *   and storage checks) and breaks every subsequent deploy on a dev machine.
 *
 * Snapshot and restore rather than pinning a value: callers that legitimately
 * run with NODE_ENV=production must keep it.
 *
 * The snapshot is refcounted, not per-call: both bundle paths run the worker
 * and client builds concurrently (`Promise.all`), and independent snapshots
 * interleave — the second entrant would snapshot the "production" the first
 * build's Vite just set, and "restore" it after the first exiter deleted it,
 * flipping the process permanently anyway. So the first entrant snapshots,
 * later entrants just join, and only the last exiter restores. This keeps the
 * builds parallel (a mutex serializing them would cost real deploy time).
 */
let activeBuilds = 0;
let savedNodeEnv: string | undefined;

/**
 * `env` is injectable for tests ONLY, so specs can exercise the
 * snapshot/refcount logic on a plain object instead of mutating (and
 * repeatedly deleting) the real `process.env.NODE_ENV` mid-suite.
 */
export async function withPreservedNodeEnv<T>(
  fn: () => Promise<T>,
  env: { NODE_ENV?: string } = process.env,
): Promise<T> {
  if (activeBuilds === 0) savedNodeEnv = env.NODE_ENV;
  activeBuilds++;
  try {
    return await fn();
  } finally {
    activeBuilds--;
    if (activeBuilds === 0) {
      if (savedNodeEnv === undefined) delete env.NODE_ENV;
      else env.NODE_ENV = savedNodeEnv;
    }
  }
}
