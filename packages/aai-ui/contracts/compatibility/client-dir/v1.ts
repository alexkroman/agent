// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:client-dir` epoch 1.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * The one export a SERVER calls: a self-hosted `server.mjs` handing the
 * prebuilt client's directory to `createServer` as `clientDir`. A `.ts` rather
 * than a `.tsx` because there is no browser and no JSX on this side of the
 * package — this subpath is Node-only, which is why it is a subpath at all.
 */

import { defaultClientDir } from "../../../client-dir.ts";

/**
 * A function, not a constant: resolution throws when the package is missing,
 * and calling it at the point the server is built keeps that failure inside the
 * caller's own error handling.
 */
export function serverOptions(): { clientDir: string } {
  return { clientDir: defaultClientDir() };
}
