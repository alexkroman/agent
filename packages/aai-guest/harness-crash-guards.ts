// Copyright 2026 the AAI authors. MIT license.

import { errorMessage } from "@alexkroman1/aai";

/**
 * Keep one bad turn from killing the sandbox.
 *
 * A guest serves MANY things at once — the host control channel, every live
 * voice session, and (for studio projects) the coding-agent chat. Node's
 * default for an unhandled rejection is to exit the process, so a single
 * stray rejection anywhere takes all of them down together.
 *
 * That is not hypothetical: undici raises `UND_ERR_BODY_TIMEOUT` on a
 * stalled LLM response from a socket callback, outside any turn's promise
 * chain, and the whole sandbox died mid-session — observed while running the
 * studio starter evals.
 *
 * Rejections are logged and swallowed: the turn that owned it fails on its
 * own error path, and everything else keeps serving. An uncaught *exception*
 * is different — it can leave state torn — so that one is logged and then
 * rethrown by exiting, which the host notices as a dead guest and replaces.
 */
export function installCrashGuards(): void {
  process.on("unhandledRejection", (reason) => {
    console.error(`Guest: unhandled rejection (session continues): ${errorMessage(reason)}`);
  });
  process.on("uncaughtException", (err) => {
    console.error(`Guest: uncaught exception; exiting: ${errorMessage(err)}`);
    process.exit(4);
  });
}
