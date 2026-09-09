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
// @ts-expect-error CSS import handled by Vite
// At the PACKAGE root, not in `src/`: it is a published export
// (`@alexkroman1/aai-ui/styles.css`) and a Vite asset, so it sits beside
// `index.html` and `public/` where the exports map and `files` name it.
import "../styles.css";
import { omitUndefined } from "@alexkroman1/aai/utils";
import { fetchClientConfig } from "./client-config.ts";
import { mountClient } from "./define-client.tsx";
import { mountPage } from "./page.tsx";

// `.then` rather than a top-level `await`: this is the bundle's entry, and the
// lookup already degrades to "the agent declared nothing" on every failure path
// — which resolves to `page: "voice"`, the front door this file can always mount.
void fetchClientConfig().then((config) => {
  const named = omitUndefined({ name: config.name });
  if (config.page === "static") {
    mountPage(named);
    return;
  }
  mountClient(named);
});
