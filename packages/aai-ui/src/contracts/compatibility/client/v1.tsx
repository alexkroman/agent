// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:client` epoch 1.
 *
 * A voice template's `client.tsx` as it was authored at epoch 1: mount with
 * `client()`, hand it a custom chrome, and tell the shell how to render two
 * tool calls. It must keep compiling for as long as epoch 1 is advertised as
 * supported.
 *
 * ## What moved, and why epoch 1 survives it
 *
 * The change that reddened this capability's hash is on `Session`, which
 * epoch 1 reaches only INDIRECTLY — `ClientConfig.component` is rendered inside
 * the provider `client()` mounts, so the session type is part of this
 * capability's transitive surface even though no name here is a session name.
 *
 * `Session` gained `restart()`. A `component` is a CONSUMER of the session, so
 * a wider session type cannot break one: {@link Chrome} below renders and reads
 * and never constructs. The `aai-ui:session` epoch 2 example carries the full
 * argument, including the one direction that DOES break (annotating a
 * hand-built `SessionCore` literal) and why epoch 1 never advertised it.
 *
 * Nothing here names `restart`, so this file is evidence about the mount
 * surface at epoch 1 rather than about what the session can do today.
 */

import type {
  ClientConfig,
  ClientConfigResponse,
  ClientHandle,
  ToolDisplayConfig,
} from "../../../index.ts";
import { client } from "../../../index.ts";

/** The chrome a template supplies instead of the default shell. */
function Chrome() {
  return <main>a custom console</main>;
}

/**
 * How two tools render in the transcript, as epoch 1 declared it.
 *
 * The map is keyed by the tool's own snake_case name, which is the contract
 * between an `agent.ts` `tools/` file and the row the caller sees.
 */
const toolDisplay: ToolDisplayConfig = {
  search_knowledge: { label: "Searching the knowledge base", icon: "🔎" },
  log_ticket: { label: "Filing a ticket" },
};

/** The mount, written as a template's module scope writes it. */
const config: ClientConfig = {
  name: "Support Line",
  component: Chrome,
  tools: toolDisplay,
  theme: {
    bg: "#0a0a0f",
    surface: "#1a1a2e",
    text: "#e2e8f0",
    border: "#1e293b",
    primary: "#3b82f6",
  },
};

export const handle: ClientHandle = client(config);

/**
 * An epoch-1 reader of what the agent advertises.
 *
 * `ClientConfigResponse` is what `/client-config` serves, and a page reading it
 * by hand — rather than letting `client()` fetch it — is the shape that pins
 * the wire type into this capability.
 */
export function titleOf(served: ClientConfigResponse): string {
  return served.name ?? "Agent";
}
