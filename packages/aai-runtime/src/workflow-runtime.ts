// Copyright 2026 the AAI authors. MIT license.
/**
 * One decision: does this runtime get a real `ctx.workflows`, and backed by what?
 *
 * Split from `runtime.ts` so `createRuntime` reads as one line, and from
 * `workflow-client.ts` so that module stays free of anything that resolves a
 * store at import time — which is what lets the client's own specs run with no
 * journal at all.
 *
 * The interesting part is the key store, because the three cases are not "prod
 * and a test" but three legitimate deployments — and they are the RUNS' three,
 * one for one:
 *
 * - **A platform guest** — the correlation-key index is the platform's own table,
 *   reached over `POST /:slug/workflow-keys` with the per-sandbox bearer. This is
 *   what a deployed agent gets, and it is `selectKeyStore`'s first arm for
 *   `selectJournal`'s reason.
 * - **With a `DATABASE_URL`** — the index is a table in the database the AUTHOR
 *   supplied. This used to be every platform workflow app, because creating one
 *   switched app storage on; the platform provisions no database now, so it is
 *   whoever set the secret.
 * - **Neither** — the index is in memory and forgotten on restart.
 *
 * **The RUNS and the KEYS follow the same preference, and that is deliberate.**
 * An asymmetry is a trap either way: durable runs beside a forgotten correlation
 * index means `find()` by key stops resolving across a restart while the runs
 * survive — which is precisely what a deployed guest had until the platform arm
 * existed, the journal being durable since `workflow-journal-platform.ts` while
 * the only pointer into it died with the sandbox — and the reverse means a key
 * pointing at a run that is gone. One preference, one boot line, both reported.
 *
 * A missing database is therefore NOT a reason to withhold the client. It was
 * tempting to make storage a hard requirement and have `ctx.workflows` reject
 * without it — but that breaks `aai dev` for every agent whose project has no
 * `DATABASE_URL`, which is the ordinary way to try a workflow out before
 * deploying it.
 */

import type { AgentDef } from "@alexkroman1/aai";
import type { Db } from "@alexkroman1/aai/internal";
import type { WorkflowClient } from "@alexkroman1/aai/workflow-api";
import type { Logger } from "./runtime-config.ts";
import { createWorkflowClient } from "./workflow-client.ts";
import { createInProcessWorkflowEngine } from "./workflow-in-process.ts";
import { createPlatformJournal } from "./workflow-journal-platform.ts";
import { createPostgresJournal } from "./workflow-journal-postgres.ts";
import type { JournalStore } from "./workflow-journal-types.ts";
import {
  createMemoryKeyStore,
  createPostgresKeyStore,
  type WorkflowKeyStore,
} from "./workflow-keys.ts";
import { createPlatformKeyStore } from "./workflow-keys-platform.ts";
import { createRunNotifier, type RunNotifier } from "./workflow-notify.ts";
import { createPlatformDispatch } from "./workflow-platform-dispatch.ts";
import { platformGuestOptions } from "./workflow-platform-world.ts";
import { resolveStepConcurrency } from "./workflow-step-gate.ts";

/**
 * The client a runtime hands to tools, and the handle its teardown owes.
 *
 * A PAIR rather than the client alone, because the engine's timers are not
 * reachable from a `WorkflowClient` and `aai dev` rebuilds its runtime on every
 * file save — so a discarded `stop` means each save leaves the previous engine
 * still executing bodies from a build that is gone. The runtime's
 * `releaseResources` already owns exactly this class of leak.
 */
export type BuiltWorkflowClient = {
  client: WorkflowClient;
  stop: () => void;
  /**
   * What `AgentRuntime.deliverWorkflow` forwards to — the engine's `execute`.
   *
   * Carried out separately from `client` because it is deliberately NOT on the
   * client: a delivery is the queue's to make, not a tool's. See that field's doc.
   */
  execute: (runId: string) => Promise<unknown>;
};

/**
 * Pick the run journal, and name it for the boot line.
 *
 * Three backends and the order is a strict preference, because two of them can be
 * available at once and only one is right: a DEPLOYED guest may also carry an
 * author-supplied `DATABASE_URL`, and its runs belong in the platform's journal
 * beside its session state rather than split across two databases with the wake
 * sweep able to see only one.
 *
 * **The platform pair is read from THIS PROCESS's environment**
 * (`platformGuestOptions`), never from the agent's. That distinction has already
 * cost a deployment: the same two keys read out of the tenant env resolve to
 * nothing — the platform puts them in the sandbox's process env, not in the
 * secrets file — so session state silently fell to memory while the world one
 * line earlier resolved fine. Reading the process env is also the SAFER half: an
 * agent may set any `AAI_*` key as a secret, and under the tenant spelling an
 * agent chose the base URL and bearer its own journal was sent to.
 *
 * Memory is last and the boot line SAYS so. A durability tradeoff absent from the
 * log reads as a bug, and this is the one an author is most likely to hit by
 * accident.
 *
 * **A host-supplied journal fills the MEMORY arm and no other.** `aai dev`
 * rebuilds this whole client on every file save, so the memory arm's per-build
 * default silently discarded every in-flight run; a host that owns a
 * process-scoped store hands it in. Letting it outrank the two durable arms
 * would turn that convenience into a demotion nobody asked for — see
 * `RuntimeOptions.journal`.
 */
function selectJournal(
  db: Db | undefined,
  logger: Logger,
  supplied: JournalStore | undefined,
): {
  journal: JournalStore | undefined;
  journalKind: string;
  /**
   * Does the chosen journal outlive this process?
   *
   * Carried rather than re-derived from `journalKind`, which is a sentence for a
   * human. The one reader is the progress-store warning in
   * {@link buildWorkflowClient}: a durable journal beside an in-memory `report()`
   * channel is the asymmetry worth saying out loud.
   */
  journalDurable: boolean;
  dispatch: ((runId: string, at?: number) => void | Promise<void>) | undefined;
  dispatchKind: string;
} {
  const platform = platformGuestOptions();
  if (platform) {
    // BOTH halves come from the same resolved pair, and that is the property to
    // preserve: a deployment with a platform journal and in-process timers would
    // store a `ctx.sleep`'s deadline durably and then forget to come back for it,
    // which is the same failure as no journal at all with a healthier-looking log.
    return {
      journal: createPlatformJournal(platform),
      journalKind: "platform",
      journalDurable: true,
      dispatch: createPlatformDispatch({ platform, logger }),
      dispatchKind: "platform queue",
    };
  }
  /**
   * The two local arms, and what their `deliveries` line may honestly claim.
   *
   * It used to say `"in-process timers"` flat, and beside a durable `runStore`
   * that read as a promise the pair could not keep: the timers died with the
   * process and nothing re-read the journal, so a run suspended on `ctx.sleep`
   * was stranded at `running` forever. `createInProcessWorkflowEngine` sweeps
   * `JournalStore.resumableRuns` at construction now — so the claim is true, and
   * it is spelled out because the boot sweep is the difference between a durable
   * run store that resumes and one that merely REMEMBERS. The engine WARNS when
   * the journal it was handed cannot be enumerated, which is the only way this
   * line can be wrong.
   */
  const localTimers = {
    dispatch: undefined,
    dispatchKind: "in-process timers (suspended runs re-enqueued at boot)",
  };
  if (db) {
    return {
      journal: createPostgresJournal({ db }),
      journalKind: "postgres",
      journalDurable: true,
      ...localTimers,
    };
  }
  return {
    journal: supplied,
    // Two different answers to the one question an operator asks of this line,
    // and the difference is not cosmetic: a host-supplied store survives the
    // rebuild that replaces this client, which is the whole of what `aai dev`
    // needed. Neither survives a restart, so neither counts as durable.
    // "Survive a rebuild" was an OVERSTATEMENT until the boot sweep landed: the
    // store survived and the timers did not, so a run suspended on `ctx.sleep`
    // was still lost on the next `aai dev` file save — the one case where
    // surviving a rebuild is worth anything. The rebuilt engine re-enqueues it
    // now, which is what makes this line true rather than nearly true.
    journalKind: supplied
      ? "memory (host-supplied — runs survive a rebuild, not a restart)"
      : "memory (in-process — runs do not survive a restart)",
    journalDurable: false,
    ...localTimers,
  };
}

/**
 * Pick the correlation-key index, and name it for the boot line.
 *
 * Three backends, the same strict preference as {@link selectJournal} and for the
 * same reasons — which is the property to preserve rather than an echo of it: the
 * index and the journal are two halves of one answer to "which run belongs to this
 * caller", so a deployment that resolved them differently would keep runs in one
 * place and the only pointer to them in another.
 *
 * - **platform** — `createPlatformKeyStore`, one `POST /:slug/workflow-keys` per
 *   call, beside the journal, the queue, session state and the upload records that
 *   already work this way. FIRST, because a deployed guest may also carry an
 *   author-supplied `DATABASE_URL` and its keys belong beside its runs rather than
 *   split across two databases.
 * - **postgres** — `createPostgresKeyStore` over that `DATABASE_URL`, which is what
 *   a self-hosted deployment has and the platform never provisions.
 * - **memory** — a `Map`, for `aai dev` and for trying a workflow out before
 *   provisioning anything. Deliberately not durable, and the boot line SAYS so.
 *
 * **The platform pair is read from THIS PROCESS's environment**
 * (`platformGuestOptions`), never the agent's — the distinction that already cost
 * a deployment, and the safer read besides: an agent may set any `AAI_*` key as a
 * secret, so under the tenant spelling an agent would choose the base URL and
 * bearer its own index was sent to.
 *
 * A separate function from `resolveKeyStore`, which is PUBLISHED on this package's
 * root barrel and is the two LOCAL arms an embedder can build from a `Db` they
 * hold. The platform arm needs no argument and no embedder: it is read out of the
 * environment the platform itself wrote, so it belongs to the selection this
 * runtime makes rather than to the resolver an embedder calls.
 *
 * NOT exported, like {@link selectJournal} beside it: the boot line is the
 * contract an operator reads, so `workflow-runtime.test.ts` asserts the choice
 * through the LOG rather than by calling this — which is also the only way to
 * answer "will a correlation key survive a restart" from outside.
 */
function selectKeyStore(db: Db | undefined): {
  keys: WorkflowKeyStore;
  keyStoreKind: string;
} {
  // `platformGuestOptions()` and NOT `resolvePlatformQueue(env)`: that separate
  // name exists so a caller cannot accidentally hand it the AGENT's environment,
  // which is the mistake two callers made and which cost a deployment. A spec
  // reaches it with `vi.stubEnv`, which is the process env this is meant to read.
  const platform = platformGuestOptions();
  if (platform) {
    return { keys: createPlatformKeyStore(platform), keyStoreKind: "platform" };
  }
  if (db) return { keys: createPostgresKeyStore(db), keyStoreKind: "postgres" };
  return {
    keys: createMemoryKeyStore(),
    // Spelled out for the reason the journal's memory arm is: a durability
    // tradeoff absent from the log reads as a bug, and this is the one an author
    // is most likely to hit by accident.
    keyStoreKind: "memory (in-process — a caller's next call will not find this run)",
  };
}

/**
 * What a run's PROGRESS channel is backed by — and today the answer is always
 * memory, which is a limitation stated rather than a choice made.
 *
 * `createMemoryStreams` is the only {@link StreamStore} in the repo: the durable
 * journal has three backends and the stream store has one, so a deployed guest
 * gets a run that outlives its sandbox and a `report()` channel that does not.
 * What that costs is not cosmetic — the same store answers `WorkflowClient.
 * lastLine` and backs the progress channel a page polls, so a run resumed in a
 * fresh sandbox narrates into an empty log and `lastLine` answers `undefined` for
 * a run that was reporting fine an hour earlier. From outside it reads as a
 * broken page rather than as a store that was never durable.
 *
 * The real fix is a platform-backed stream store — routes beside
 * `platform-workflow-journal.ts`, a client beside `workflow-journal-platform.ts`,
 * and a postgres twin for the self-hosted case. Until then the honest move is the
 * one the run store already makes: name it in the boot line, and WARN when the
 * journal beside it is durable, because that is the deployment where the two
 * disagree.
 */
const PROGRESS_STORE_KIND = "memory (in-process — a resumed run narrates into an empty log)";

/**
 * Build `ctx.workflows` for one runtime, or `undefined` when the agent declares
 * no workflows.
 *
 * `undefined` rather than a rejecting client, so the ONE place that decides what
 * an unavailable client says is the tool executor
 * (`WORKFLOWS_UNAVAILABLE_MESSAGE`). Two producers of that message would drift,
 * and this one has less context to write a good one with.
 *
 * @internal
 */
export function buildWorkflowClient(
  agent: Pick<AgentDef, "workflows">,
  db: Db | undefined,
  /**
   * This deployment's own public base URL, or undefined when nothing told it —
   * see `RuntimeOptions.publicUrl`. Only `publicWebhookUrl` reads it, and only
   * to throw when it is absent.
   */
  publicUrl: string | undefined,
  logger: Logger,
  /**
   * The host's own run store, used only where the alternative is a per-build
   * one — see `RuntimeOptions.journal` and {@link selectJournal}.
   */
  journalOption?: JournalStore | undefined,
): BuiltWorkflowClient | undefined {
  const workflows = agent.workflows;
  if (!workflows || Object.keys(workflows).length === 0) return;
  const { journal, journalKind, journalDurable, dispatch, dispatchKind } = selectJournal(
    db,
    logger,
    journalOption,
  );
  const { keys, keyStoreKind } = selectKeyStore(db);
  logger.info?.("Workflows resolved", {
    workflows: Object.keys(workflows),
    // Which store is in play decides whether a correlation key survives a
    // restart, so it belongs in the one line an operator reads at boot rather
    // than being inferred from whether storage happens to be on.
    //
    // It is `selectKeyStore`'s answer now, and it used to be `db ? "postgres" :
    // "memory"` — a line that was TRUE and useless: on a deployed guest it read
    // `memory`, correctly, every time, with nobody reading it, while the runs
    // beside it were durable. A boot line is only a gate on the deployments
    // somebody looks at; the fix was the third backend, not the wording.
    keyStore: keyStoreKind,
    // The RUN store, which is a different question from the key store and the
    // one an operator actually asks after a restart. Reported rather than
    // assumed, because a durability tradeoff absent from the log reads as a bug —
    // and because there is now a case where the answer is good.
    runStore: journalKind,
    // What `report()` writes into, which is a THIRD question from the two above
    // and the only one whose answer is always the same — see
    // `PROGRESS_STORE_KIND`. In the line rather than inferred from the run store,
    // because the two now legitimately disagree on every deployed guest.
    progress: PROGRESS_STORE_KIND,
    // WHERE a delivery goes, which is a different question from where a run is
    // stored and the one that decides whether a `ctx.sleep` ever comes back. A
    // durable journal behind in-process timers looks healthy and forgets every
    // wait, so the two are reported together rather than inferred from each other.
    deliveries: dispatchKind,
    // How many step bodies may EXECUTE at once. Reported because it is the
    // number that decides whether a wide fan-out fits in this container, and
    // because it USED to be the workflow world's and is now ours — an author
    // whose body says `mapConcurrent(32)` needs to see the number that actually
    // applies. See `workflow-step-gate.ts` for the guest it killed.
    stepConcurrency: resolveStepConcurrency(),
    // Reported at boot for the same reason the key store is: whether a run can
    // hand out a reachable callback URL is a property of the DEPLOYMENT, and the
    // alternative to one boot line is discovering it from a throw inside a tool
    // weeks later. The URL itself, not a boolean — a wrong origin is the other
    // half of the failure and a boolean cannot show it.
    publicUrl: publicUrl ?? "(unset — publicWebhookUrl will throw)",
  });
  // LOUD, and only where the two stores disagree. With a memory journal the runs
  // and their narration are forgotten together, which the run-store line already
  // says; a second warning there would train an author to ignore this one. With a
  // durable journal the run survives a boot its progress log does not, and
  // nothing else in the system can report that: from inside, a resumed run with
  // an empty channel is indistinguishable from one that never narrated.
  if (journalDurable) {
    logger.warn?.("Workflow progress is not durable", {
      runStore: journalKind,
      progress: PROGRESS_STORE_KIND,
      detail:
        "report() and lastLine are in-process only — a run resumed in another " +
        "process reports an empty progress log for work it already narrated",
    });
  }
  // Held so `stop` can reach it: the CLIENT is what the runtime hands to tools,
  // and the engine's timers are what a rebuild has to cancel.
  const engine = createInProcessWorkflowEngine({ workflows, logger, journal, dispatch });
  const client = createWorkflowClient({
    workflows,
    keys,
    // The engine this repo owns, executing its own deliveries in this process.
    // `createWorkflowClient` hands `start` the DECLARED KEY, and the engine
    // records a run under that same string — which is the whole of what the
    // removed adapter needed a two-way translation for.
    wdk: engine,
    // Declared `string | undefined` rather than optional on the options type, so
    // the absent case passes straight through — no `omitUndefined`, and no
    // spread-ternary for rule 2 to catch.
    publicUrl,
    logger,
  });
  return { client, stop: () => engine.stop(), execute: (runId) => engine.execute(runId) };
}

/**
 * Build the run notifier for one runtime, or `undefined` when there is no client
 * to watch runs with.
 *
 * Beside `buildWorkflowClient` because it is the same decision one step on —
 * "does this runtime have workflows" — and because `runtime.ts` should read as
 * one line per capability rather than as the wiring for each.
 *
 * The announcer is a CALLBACK rather than the session map itself: this module
 * has no business knowing how a session is found, and the map is the one thing
 * only `createRuntime`'s scope has.
 *
 * @internal
 */
export function buildRunNotifier(
  workflows: WorkflowClient | undefined,
  announce: (sessionId: string, instruction: string) => boolean,
  logger: Logger,
): RunNotifier | undefined {
  if (!workflows) return undefined;
  return createRunNotifier({ client: workflows, announcer: { announce }, logger });
}
