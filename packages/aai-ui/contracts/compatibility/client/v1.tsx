// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:client` epoch 1.
 *
 * How a voice client was mounted when this epoch shipped. It is FROZEN —
 * editing it to make a compile error go away defeats the point, because the
 * error IS the finding: a `client.tsx` written against epoch 1 no longer
 * builds. Either keep the change backward-compatible, or classify the break
 * with `node scripts/api-contracts.mjs --bump aai-ui:client --drop "<reason>"`.
 *
 * Imports resolve to source rather than to `@alexkroman1/aai-ui` so this
 * compiles in the ordinary `pnpm typecheck` run — and because a package cannot
 * resolve itself by name. Resolution through the package specifier is what
 * `check:template-types` covers, against the published types.
 */

import {
  type ClientConfig,
  type ClientConfigResponse,
  type ClientHandle,
  client,
  type ToolDisplayConfig,
} from "../../../index.ts";

/** Both tiers were reachable through one `ClientConfig` union. */
const tools: ToolDisplayConfig = {
  lookup_order: { icon: "📦", label: "Looking up your order" },
};

/** The config tier: no component, so the default chat shell renders. */
export const configTier: ClientConfig = {
  name: "Support",
  platformUrl: "https://agents.example.com/support",
  target: "#root",
  theme: { primary: "#6366f1" },
  tools,
  sidebar: () => null,
  sidebarWidth: "22rem",
  resumeSessionId: "sess_123",
  onSessionId: (sessionId) => window.localStorage.setItem("aai:session", sessionId),
};

/** The component tier: the caller owns the whole page. */
export const componentTier: ClientConfig = {
  component: () => null,
  name: "Support",
  tools,
};

/**
 * The pre-connection lookup's answer, which a caller can build a config from —
 * the name and greeting the agent itself declares, so a page can render its own
 * header before any socket opens.
 */
export function fromServer(config: ClientConfigResponse): ClientConfig {
  return { name: config.name ?? "Agent", component: () => null };
}

/**
 * A mount returns a handle: the session to drive, and two ways to take it back
 * down — an explicit `dispose()` and `Symbol.dispose` for `using`.
 */
export function mount(config: ClientConfig): ClientHandle {
  const handle = client(config);
  handle.session.start();
  handle.dispose();
  return handle;
}
