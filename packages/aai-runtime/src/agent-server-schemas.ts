// Copyright 2026 the AAI authors. MIT license.
/**
 * The tables a SELF-HOSTED deployment owns, and who creates them.
 *
 * `createAgentServer` is the door the self-hosting page documents, and a
 * `DATABASE_URL` in the env it is handed puts BOTH of this runtime's durable
 * stores in that database — session state (`runtime-session-state.ts`) and the
 * durable-run journal (`selectJournal`). The tables come with whoever OWNS the
 * database, and a self-hosted deployment has no migration step anywhere to hang
 * them off.
 *
 * **Nothing on that path created either set, and it had already shipped twice.**
 * `ensureSessionStateSchema` and `ensureWorkflowJournalSchema` are PUBLIC
 * precisely so a self-hoster can reach them, and their only production callers
 * were `aai-cli`'s `npm start` and `aai dev` — the two doors that are not this
 * one. So a self-hosted agent with a database booted reporting
 * `sessionState: postgres, durable: true` and `runStore: "postgres"`, and then
 * the first session died on `relation "aai_session_events" does not exist` and
 * the first run on `42P01`. `workflow/journal/schema.ts` records that in the
 * words worth keeping: the boot line said durable and nothing was.
 *
 * Its own module rather than fifteen more lines in `agent-server.ts`, for the
 * reason `agent-server-forwarding.ts` beside it is one: that file is the option
 * bag and the mount, and it is at the line cap. The split also puts the
 * DECISION ({@link ownedSchemaUrl}) somewhere a spec can ask it directly, which
 * is the same argument `applySessionStateDdl` makes for being separate from the
 * pool that opens around it.
 *
 * @internal
 */

import { errorMessage } from "@alexkroman1/aai";
import type { ProviderEnv } from "@alexkroman1/aai/host-internal";
import type { Logger } from "./runtime-config.ts";
import { ensureSessionStateSchema } from "./session-state/backends/postgres.ts";
import { ensureWorkflowJournalSchema } from "./workflow/journal/schema.ts";
import { platformGuestOptions } from "./workflow/platform-world.ts";

/**
 * Which database this deployment owes tables to, or none.
 *
 * `providerEnv ?? env` because that is exactly how `createRuntime` resolves the
 * pool it opens, so this cannot end up provisioning a different database than
 * the one the stores read.
 *
 * A PLATFORM guest answers `undefined`, and that is the "when the resolved store
 * is Postgres" half of the question rather than frugality: on a platform BOTH
 * stores are the platform's own — `selectJournal` and `selectBackend` put it
 * first, ahead of any `DATABASE_URL` an author also set — so tables created here
 * would be read by nobody. Read from THIS PROCESS's environment like every other
 * platform pair; `platformGuestOptions` carries what a tenant read cost.
 *
 * @internal
 */
export function ownedSchemaUrl(options: {
  env: ProviderEnv;
  providerEnv?: ProviderEnv | undefined;
}): string | undefined {
  if (platformGuestOptions()) return undefined;
  return (options.providerEnv ?? options.env).DATABASE_URL?.trim() || undefined;
}

/**
 * The DDL this process has already run, keyed by database URL.
 *
 * Two servers in one process is the ordinary shape rather than an edge case:
 * `aai dev` rebuilds its server on every file save, and an embedder may serve
 * two agents off one database — so without this, each boot re-issues eight
 * statements against tables that already exist. Keyed by URL and not by a
 * boolean, so a second server on a DIFFERENT database is still provisioned;
 * holding the PROMISE and not a "done" flag, so a door that boots while the
 * first is still applying awaits that work instead of racing it.
 *
 * Deliberately NOT inside the two `ensure*Schema` functions: those are the
 * published out-of-band migration, and an operator who calls one has asked for
 * it to run.
 */
const applied = new Map<string, Promise<void>>();

/**
 * Create both stores' tables on a database this deployment owns, once.
 *
 * **Best-effort, and it may not fail a boot that works today.** Both functions
 * warn rather than throw — a self-hosted role that may not CREATE, because a
 * real migration already made these tables, has to keep serving — so all this
 * adds is a catch for the one escape they have: a `DATABASE_URL` malformed
 * enough that opening a pool throws before any statement runs. What bounds the
 * wait is postgres.js's own 30s connect timeout, exactly as it bounds
 * `npm start`, which awaits the same two calls before it builds a server.
 *
 * @internal
 */
export function ensureOwnedSchemas(url: string, logger: Logger): Promise<void> {
  const inFlight = applied.get(url);
  if (inFlight) return inFlight;
  const applying = (async () => {
    try {
      await ensureSessionStateSchema({ url, logger });
      await ensureWorkflowJournalSchema({ url, logger });
    } catch (err) {
      logger.warn(
        `could not ensure this deployment's own tables in DATABASE_URL: ${errorMessage(err)}. ` +
          "Sessions and durable runs will fail unless a migration has already created them.",
      );
    }
  })();
  applied.set(url, applying);
  return applying;
}
