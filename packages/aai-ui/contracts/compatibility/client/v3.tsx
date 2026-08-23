// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:client` epoch 3.
 *
 * See `./v1.tsx` for what "frozen" obliges and why the imports are relative.
 *
 * **The export list is unchanged, so this is a SIGNATURE change, and it is
 * purely ADDITIVE**: `ClientConfig` grew four optional display fields — `icon`,
 * `subtitle`, `buttonText` and `sidebarPosition`. Epoch 2 is RETAINED and
 * `./v2.tsx` compiles unchanged beside this file, as does `./v1.tsx`; nothing
 * that satisfied the old shape stops satisfying this one.
 *
 * The four were not new capabilities. `StartScreen` already took `icon`,
 * `subtitle` and `buttonText`, and `SidebarLayout` already took
 * `sidebarPosition` — `DefaultShell` simply forwarded three of the seven fields
 * the components under it accept. So a client that wanted all four could say
 * none of them in config and dropped to the `component:` tier for a wrapper
 * whose only job was to re-say what `client()` already knows how to say. Adding
 * a field to a config is cheap; what this epoch records is that the ABSENCE of
 * one was pushing pages down a tier.
 *
 * `icon` reaches BOTH the start card and the shell header, deliberately: they
 * are one mark, and an agent whose start screen shows a pizza and whose header
 * shows our logo reads as two products.
 */

import { type ClientConfig, type ClientHandle, client } from "../../../index.ts";

/** Unchanged from epoch 2: a custom component beside a sidebar, one flat config. */
export const withSidebar: ClientConfig = {
  component: () => null,
  sidebar: () => null,
  sidebarWidth: "22rem",
  name: "Dispatch",
  tools: { lookup_order: { icon: "📦", label: "Looking up your order" } },
};

/** Unchanged from epoch 2: a helper may take the whole config. */
export function withPlatform(config: ClientConfig, platformUrl: string): ClientHandle {
  return client({ ...config, platformUrl });
}

/**
 * New at epoch 3, and the whole point: the default shell, fully dressed, with no
 * `component:` wrapper underneath it. `sidebarPosition` routes through the same
 * branch that builds a `SidebarLayout` beside a `component`, so it means the
 * same thing in both — a field honoured by only one of them is the shape this
 * config used to have.
 */
export const dressed: ClientConfig = {
  name: "Solo RPG",
  icon: "🎲",
  subtitle: "Roll for initiative.",
  buttonText: "Begin the session",
  sidebar: () => null,
  sidebarPosition: "left",
};

/** Every one of the four is optional, which is what keeps epochs 1 and 2 alive. */
export const bare: ClientConfig = { name: "Support" };
