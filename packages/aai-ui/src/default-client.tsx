/** @jsxImportSource react */
/**
 * The page every agent gets with NO `client.tsx` of its own — and which page
 * follows the agent's declared front door.
 *
 * One bundle serves both, because the CLI serves one directory for every agent
 * (`resolveClientDir`'s fallback to `defaultClientDir()`): the choice cannot be
 * made at build time, so it is made here, from the `page` field
 * `GET client-config` reports precisely so a browser knows before it dials.
 *
 * It used to call `mountClient({})` unconditionally. For a WORKFLOW APP that
 * renders a start screen and then opens a `/websocket` the server declines by
 * design — a dead page — which is why "you do not need a `client.tsx`" was only
 * ever true of a voice agent. Both mounts have a default shell now, so it is
 * true of either.
 *
 * The name is FORWARDED to `mountPage()` rather than looked up twice: it treats
 * an explicit name as final. The voice shell takes no name — `mountClient()`
 * reads the agent's own from its `client-config` lookup — so it issues that
 * request itself; on the platform this endpoint is the broker, and the request
 * here has already booted the sandbox the shell's then reaches, which is what
 * an agent that declared no name always cost.
 */
import { omitUndefined } from "@alexkroman1/aai/utils";
import { fetchClientConfig } from "./client-config.ts";
import { mountClient } from "./define-client.tsx";
import { mountPage } from "./page.tsx";

/** The two mounts the default client chooses between, injectable for a spec. */
export type DefaultClientMounts = {
  mountClient: (config: Record<string, never>) => unknown;
  mountPage: (config: { name?: string }) => unknown;
};

/**
 * Look up the agent's front door and mount the matching shell.
 *
 * A function rather than the module's own side effect so the CHOICE can be
 * driven with fake mounts; `default-client-entry.tsx` is the bundle entry that
 * calls it. The lookup already degrades to "the agent declared nothing" on
 * every failure path — which resolves to `page: "voice"`, the front door this
 * can always mount.
 */
export async function bootDefaultClient(
  mounts: DefaultClientMounts = { mountClient, mountPage },
): Promise<void> {
  const config = await fetchClientConfig();
  if (config.page === "static") {
    mounts.mountPage(omitUndefined({ name: config.name }));
    return;
  }
  mounts.mountClient({});
}
