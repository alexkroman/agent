// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:server` epoch 12.
 *
 * The FRONT door with a host-supplied journal, now that the door really
 * forwards one — `v8.ts` is the same shape written when it did not, and had to
 * spell its journal type off `RuntimeOptions` for that reason. This is what a
 * deployment copies when the durable runs belong to their schema and the server
 * is still the one-call kind. Written the way it was authored at epoch 12, and
 * it must keep compiling for as long as that epoch is advertised as supported.
 *
 * ## What moved, and why epoch 12 survives it
 *
 * An attempt CHARGE became a lease: `claimAttempt` and `releaseAttempt` grew a
 * `holder` — the walk that holds the charge — and `claimAttempt` grew a
 * `leaseMs` beside it. A scalar counter cannot expire, so the charge a DEAD walk
 * left was indistinguishable from a live one and stood forever, refusing that
 * step permanently after `maxAttempts` deaths.
 *
 * **This capability's report moved with it for the reason `v8.ts` records, and
 * the indirection is worth knowing before reading a `--bump` here.**
 * `AgentServerOptions.agent` is spelled `RuntimeOptions["agent"]`, so the whole
 * of `RuntimeOptions` is rolled into this contract's surface — `journal` among
 * it, and therefore `JournalStore`, and therefore every method it names. So a
 * parameter added to an attempt CHARGE reaches a SERVER contract.
 *
 * It is still a real change to this surface: a host reading
 * `NonNullable<AgentServerOptions["journal"]>` sees it. Adding parameters to
 * methods a host IMPLEMENTS is not breaking — a function of two parameters
 * satisfies a signature of four — so a store written at epoch 11 still
 * type-checks. What it loses is behaviour rather than compilation, which is what
 * this retain is claiming.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 12 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  DEFAULT_LISTEN_HOST,
} from "../../../runtime-barrel.ts";

/** ── EDIT: the agent this deployment serves. ────────────────────────────── */
const definition = agent({
  name: "digest-desk",
  systemPrompt: "You summarize links people send you.",
  greeting: "Digest desk.",
});

/** ── EDIT: how this deployment reads its own configuration. ─────────────── */
const declared: AgentEnv = { DIGEST_STYLE: process.env.DIGEST_STYLE ?? "brief" };

/**
 * The journal, as this deployment's own code sees it.
 *
 * Off `AgentServerOptions` now rather than off `RuntimeOptions`, which is the
 * whole difference from `v8.ts`: this door forwards the option, so the type is
 * reachable from the bag a caller of THIS door actually writes. The type it
 * names is still a FORGOTTEN export — reachable from that signature and exported
 * by no subpath — so `NonNullable<…["journal"]>` remains the only spelling a
 * host has, and which implementation fills it is the host's business.
 */
type HostJournal = NonNullable<AgentServerOptions["journal"]>;

/**
 * ── EDIT: how long a charge counts for, in YOUR fleet. ──────────────────
 *
 * The window an attempt claim reads under. It has to clear the longest walk that
 * can legitimately be running, or a live walk's charge expires and the ceiling
 * stops bounding anything. There is no heartbeat: a live walk does not refresh
 * its charge, which is why the runtime's own default is generous.
 */
const LEASE_MS = 60 * 60 * 1000;

/**
 * ── EDIT: what "is this step wedged" means for your operators. ───────────
 *
 * A maintenance read over the journal this deployment supplied, and the reason a
 * server-shaped example touches an attempt charge at all. It has to name a
 * HOLDER like any other claimer — the number is per-walk now, so a reader that
 * made one up would appear as a walk and inflate the answer it came to read —
 * and it gives its own charge back, so the probe is not counted by the next
 * reader. A release names the charge, so this can only ever take the probe's.
 */
export async function outstandingAttempts(
  journal: HostJournal,
  runId: string,
  key: string,
): Promise<number> {
  const outstanding = await journal.claimAttempt(runId, key, "ops-probe", LEASE_MS);
  await journal.releaseAttempt(runId, key, "ops-probe");
  // Minus the probe's own charge, which the claim above counted.
  return outstanding - 1;
}

/**
 * ── EDIT: how this deployment records a step it ran itself. ──────────────
 *
 * A backfill, or work this process did outside a replay. `appendStep` is
 * idempotent on `key` and answers the STORED entry, so what comes back is
 * authoritative and may not be what was sent.
 */
export async function backfill(journal: HostJournal, runId: string, key: string): Promise<number> {
  const stored = await journal.appendStep(runId, {
    key,
    name: key.split("#")[0] ?? key,
    status: "ok",
    output: { backfilled: true },
    attempts: 1,
    finishedAt: Date.now(),
  });
  return stored.attempts;
}

/**
 * ── EDIT: the one-call door. ────────────────────────────────────────────
 *
 * `journal` is the point of this file: with it, durable runs live in this
 * deployment's own database and the runtime builds nothing. Without it the
 * runtime resolves its own — a `DATABASE_URL` if there is one, memory otherwise
 * — and the boot line names which, because a durability tradeoff absent from the
 * log reads as a bug.
 */
export function serve(journal: HostJournal): AgentServer {
  const options: AgentServerOptions = {
    agent: definition,
    env: declared,
    journal,
    // Absent, `publicWebhookUrl` throws rather than minting a `localhost` URL a
    // third party cannot reach.
    publicUrl: process.env.PUBLIC_URL,
  };
  return createAgentServer(options);
}

/**
 * The port and interface are `listen`'s, not the options bag's.
 *
 * Loopback by DEFAULT and spelled out here because it is a decision: this
 * server has no request authentication of its own, so binding a reachable
 * interface is something a deployment opts into.
 */
export async function listen(server: AgentServer): Promise<void> {
  await server.listen(Number(process.env.PORT ?? 3000), process.env.HOST ?? DEFAULT_LISTEN_HOST);
}
