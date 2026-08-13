// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:page` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The workflow-app mount, i.e. the `client.tsx` of an
 * `agent({ page: "static" })`: same file name, same React, same theme tokens,
 * and no session — so nothing here names `useSession`, and no microphone is
 * requested.
 */

import { type PageConfig, type PageHandle, page } from "../../../index.ts";

function App() {
  return <main className="p-8">Submit a link.</main>;
}

export const pageConfig: PageConfig = {
  component: App,
  name: "Link Digest",
  target: "#root",
  theme: { bg: "#0b1020", text: "#e2e8f0" },
};

/** A page handle disposes; there is no session on it to start. */
export function mount(): PageHandle {
  const handle = page(pageConfig);
  handle.dispose();
  return handle;
}
