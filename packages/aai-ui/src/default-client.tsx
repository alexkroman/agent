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
 * The name is FORWARDED rather than looked up twice: on the platform this
 * endpoint is the broker, so a request able to boot a sandbox should not be
 * issued once here and again by the shell. Both shells treat an explicit name as
 * final and skip their own lookup. An agent that declared none still costs the
 * shell its own request, which is what it cost before.
 */
import { omitUndefined } from "@alexkroman1/aai/utils";
import { fetchClientConfig } from "./client-config.ts";
import { mountClient } from "./define-client.tsx";
import { mountPage } from "./page.tsx";

/** The two mounts the default client chooses between, injectable for a spec. */
export type DefaultClientMounts = {
  mountClient: (config: { name?: string }) => unknown;
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
  const named = omitUndefined({ name: config.name });
  if (config.page === "static") {
    mounts.mountPage(named);
    return;
  }
  mounts.mountClient(named);
}
