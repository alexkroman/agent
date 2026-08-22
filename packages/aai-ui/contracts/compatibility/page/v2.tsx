// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:page` epoch 2.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 2 added `fetchClientConfig` to this capability. It is the lookup
 * `client()` performs on its own behalf before rendering the default shell —
 * `page()` performs none, deliberately, so a workflow app that wants the
 * agent's declared `name` or `greeting` asks for them. Epoch 1's mount
 * (`./v1.tsx`, retained) is unchanged by that; this file covers only what is
 * new.
 */

import { type ClientConfigResponse, fetchClientConfig, page } from "../../../index.ts";

/** Every field is optional: an agent that declared none is a normal agent. */
export async function agentTitle(): Promise<string> {
  const config: ClientConfigResponse = await fetchClientConfig(location.origin + location.pathname);
  return config.name ?? "Workflows";
}

/** A page that reads the agent's own greeting rather than restating one. */
export async function mount(): Promise<void> {
  const { name, greeting } = await fetchClientConfig(location.origin + location.pathname);
  const handle = page({
    name: name ?? "Workflows",
    component: () => (
      <main className="p-8">
        <h1>{name ?? "Workflows"}</h1>
        {greeting === undefined ? null : <p>{greeting}</p>}
      </main>
    ),
  });
  handle.dispose();
}

/** The lookup never throws, so a caller supplying its own fetch needs no catch. */
export async function withFetch(fetchFn: typeof globalThis.fetch): Promise<boolean> {
  const config = await fetchClientConfig("https://agents.example.com/digest/", fetchFn);
  return config.page === "static";
}
