// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-runtime:server` epoch 8.
 *
 * The FRONT door with a host-supplied journal — `createAgentServer` handed the
 * runtime options a deployment that owns its own database would write. `v4.ts`
 * covers that door with the runtime building its own persistence and `v6.ts`
 * covers the other two doors; this is what a host copies when the durable runs
 * belong to their schema and the server is still the one-call kind. Written the
 * way it was authored at epoch 8, and it must keep compiling for as long as that
 * epoch is advertised as supported.
 *
 * ## What moved, and why epoch 8 survives it
 *
 * Epoch 9 carries two changes and both are additive. It added an optional
 * `startedAt` to `StepEntry` — when the walk reached the step, so
 * `finishedAt - startedAt` is what it cost — and it added `journal` to
 * `AgentServerOptions`, closing the forwarding gap this file was written to
 * record.
 *
 * **This capability's report moved with it for the reason `v6.ts` records, and
 * the indirection is worth knowing before reading a `--bump` here.**
 * `AgentServerOptions.agent` is spelled `RuntimeOptions["agent"]`, so the whole
 * of `RuntimeOptions` is rolled into this contract's surface — `journal` among
 * it, and therefore `JournalStore`, and therefore every record its methods
 * name. So a field added to a step ENTRY reaches a SERVER contract. It is still
 * a real change to this surface: a host reading
 * `NonNullable<AgentServerOptions["journal"]>` sees it.
 *
 * Adding an OPTIONAL member to a record a host both writes and reads breaks
 * nothing in either direction, which is what makes this a retain — the entry
 * constructed below carries no `startedAt` and still satisfies the type, and the
 * reader renders an absent one as unknown, which it would owe anyway for a row
 * written before the field existed.
 *
 * Editing this file to make a future error go away defeats the mechanism: the
 * error IS the finding, and it means epoch 8 has to be dropped with a reason.
 */

import { agent } from "@alexkroman1/aai";
import {
  type AgentEnv,
  type AgentServer,
  type AgentServerOptions,
  createAgentServer,
  DEFAULT_LISTEN_HOST,
  type RuntimeOptions,
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
 * The journal, as this host's own code sees it.
 *
 * Derived from `RuntimeOptions` rather than written out, because the type it
 * names is a FORGOTTEN export — reachable from that signature and exported by
 * no subpath, so `NonNullable<RuntimeOptions["journal"]>` is the only spelling a
 * host has. Which implementation fills it is the host's business: the three this
 * package ships are `@internal` and live on `@alexkroman1/aai-runtime/internal`,
 * so this file takes one rather than assembling it.
 *
 * **And it is `RuntimeOptions`, not `AgentServerOptions`, because at epoch 8
 * `createAgentServer` did not forward `journal`.** That was the fourth silent
 * drop through this door — the option reached this capability's REPORT (through
 * `agent: RuntimeOptions["agent"]`, which rolls the whole bag in) while the door
 * could not accept it, so a deployment that owned its runs had to drop back to
 * `createRuntime` + `createServer` and restate by hand every field the wrapper
 * derives. Writing this file is what found it.
 *
 * It is FORWARDED as of epoch 9, and `agent-server-forwarding.ts` is what stops
 * a fifth: every `RuntimeOptions` member is now either on `AgentServerOptions`
 * or on an explicit deny-list with a reason, and the subtraction fails the
 * typecheck AND the build. This file keeps the `RuntimeOptions` spelling anyway —
 * it is what a host wrote at epoch 8, it still compiles, and changing it to the
 * newer spelling would be editing a frozen example to look current, which is the
 * one thing these files may not do.
 */
type HostJournal = NonNullable<RuntimeOptions["journal"]>;

/**
 * ── EDIT: what "which step was slow" means for your operators. ───────────
 *
 * The read side of the journal this deployment supplied, and the reason a
 * server-shaped example touches a step entry at all. `readSteps` comes back
 * ordered by `finishedAt` with ties broken by `key`, so it is already the run's
 * history in order.
 */
export async function slowestStep(
  journal: HostJournal,
  runId: string,
): Promise<{ key: string; durationMs: number } | undefined> {
  const steps = await journal.readSteps(runId);
  const timed = steps.flatMap((step) =>
    // An absent start is skipped rather than counted as zero: a row written
    // before the field existed has none, and a zero would make the oldest
    // entry in the run always look like the fastest.
    step.startedAt === undefined
      ? []
      : [{ key: step.key, durationMs: step.finishedAt - step.startedAt }],
  );
  return timed.reduce<{ key: string; durationMs: number } | undefined>(
    (worst, step) => (worst === undefined || step.durationMs > worst.durationMs ? step : worst),
    undefined,
  );
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
 * No `journal` here, for the reason {@link HostJournal} gives: this door does
 * not forward one, so the runtime resolves its own — a `DATABASE_URL` if there
 * is one, memory otherwise — and the boot line names which, because a durability
 * tradeoff absent from the log reads as a bug.
 */
export function serve(): AgentServer {
  const options: AgentServerOptions = {
    agent: definition,
    env: declared,
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
