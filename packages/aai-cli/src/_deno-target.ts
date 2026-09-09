// Copyright 2026 the AAI authors. MIT license.
/**
 * The **Deno Deploy** target — a self-contained directory under `.aai/deno/`.
 *
 * One module per host, for the reason `_vercel-target.ts` opens with. What
 * assembles the directory is `_deno-output.ts`; what this file holds is where
 * it goes and what goes in it.
 *
 * Deno and Modal are the two LONG-LIVED targets: each entry binds a port and
 * each drains on a signal (`TARGET_DRAIN_SOURCE`), which is what makes
 * them the pair that also shares `_target-output.ts`.
 */

import path from "node:path";
import { longLivedEntrySource } from "./_target-entry.ts";

/**
 * Where a self-contained Deno deployment is emitted, relative to the project.
 *
 * A DIRECTORY to deploy rather than files scattered through the project, and
 * `deno deploy` from inside it uploads exactly this and nothing else. That
 * matters more here than it does on Vercel: Deploy uploads the working
 * directory, so an emit into the project root would ship `node_modules`, the
 * source, and the developer's `.env` alongside the thing meant to run.
 */
export const DENO_OUTPUT_DIR = path.join(".aai", "deno");

/** The bundled entry inside {@link DENO_OUTPUT_DIR}, and Deploy's entrypoint. */
export const DENO_ENTRY_FILE = "server.mjs";

/** Deno's own project file inside {@link DENO_OUTPUT_DIR}. */
export const DENO_CONFIG_FILE = "deno.json";

/**
 * The port the entry binds when the host set no `PORT`.
 *
 * Deploy sets one, so this is what a bare `deno task start` on a laptop gets —
 * the same number the Modal entry defaults to, because a reader who has run
 * one emit should not have to look up the other.
 */
export const DENO_PORT = 8000;

/**
 * The `deno.json` written beside the entry, so the output DESCRIBES how to run
 * itself.
 *
 * Without it every command against this directory has to re-supply the
 * entrypoint — `deno deploy --entrypoint server.mjs`, `deno run -A server.mjs`
 * — which is a fact about the emit that the emit already knows and the user has
 * to remember. Nitro's `deno-server` preset writes the same file for the same
 * reason (its `compiled` hook, a `tasks.start`), and its own test suite then
 * runs a bare `deno task start`.
 *
 * `-A` rather than a narrowed permission set, and that is deliberate: the
 * server binds a port, reads the client directory and the worker off disk, and
 * reads the environment, so an enumerated list here would be a second
 * declaration of the runtime's needs that drifts the first time one changes.
 * Deno Deploy grants its own permissions regardless; this file is what makes
 * the directory runnable BY HAND, which is how a failed deployment gets
 * diagnosed.
 */
export const DENO_CONFIG_SOURCE = `${JSON.stringify(
  { tasks: { start: `deno run -A ./${DENO_ENTRY_FILE}` } },
  null,
  2,
)}\n`;

/**
 * The Deno entry, bundled into {@link DENO_ENTRY_FILE}.
 *
 * ## Why this BINDS, where the Vercel entry does not
 *
 * Deno Deploy runs a long-lived process and expects it to listen, which is the
 * ordinary `aai start` shape rather than the serverless one — so this is the
 * only target whose entry calls `listen()`. There is no `(req, res)` adapter
 * and no upgrade translation: `node:http` and the `ws` server path both work
 * on Deno, so the session reaches the same `AgentServer` that `aai dev` and
 * `aai start` run. Verified against a live deployment with real speech: 74
 * audio frames back, transcript and reply intact.
 *
 * ## The body is SHARED, and only these three lines are Deno's
 *
 * {@link longLivedEntrySource} carries the bind, the `0.0.0.0`, the
 * `import.meta.dirname` and the drain — see that module for why the port read
 * is no longer Deno's own, which is what left this artifact runnable only under
 * Deno for as long as it read `globalThis.Deno.env` and nothing else.
 */
export const DENO_ENTRY_SOURCE = longLivedEntrySource({
  target: "deno",
  hostNote: ["Deno Deploy runs this as a long-lived process and expects it to listen."],
  defaultPort: DENO_PORT,
});
