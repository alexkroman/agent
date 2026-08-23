// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:client` epoch 2.
 *
 * See `./v1.tsx` for what "frozen" obliges and why the imports are relative.
 *
 * Epoch 2 REMOVED `BaseOptions`, `ConfigTier` and `ComponentTier`. They were
 * the parts of a union that existed only to express "`component` and `sidebar`
 * are mutually exclusive", spelled with `?: never` — and the message that shape
 * produces (*"Type 'string' is not assignable to type 'undefined'"*) had
 * already cost two of the bans their lives. `ClientConfig` is one flat type
 * now, and `client()` decides at runtime, where every combination can be
 * honoured. Epoch 1 (`./v1.tsx`) is retained and compiles unchanged: it names
 * only `ClientConfig`, and both of its literals still satisfy it.
 *
 * What is new to write is the combination the union refused.
 */

import { type ClientConfig, type ClientHandle, client } from "../../../index.ts";

/** A custom component beside a sidebar — one config, no tier to pick. */
export const withSidebar: ClientConfig = {
  component: () => null,
  sidebar: () => null,
  sidebarWidth: "22rem",
  name: "Dispatch",
  tools: { lookup_order: { icon: "📦", label: "Looking up your order" } },
};

/**
 * A helper may take the whole config, which is what `BaseOptions` was reached
 * for and could never quite do — it named the shared half of two tiers, so a
 * caller building options for either still had to say which.
 */
export function withPlatform(config: ClientConfig, platformUrl: string): ClientHandle {
  return client({ ...config, platformUrl });
}
