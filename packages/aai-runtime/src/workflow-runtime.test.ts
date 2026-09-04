// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the one decision in `workflow-runtime.ts`: whether a runtime gets a
 * `ctx.workflows` at all, and which key store backs it.
 *
 * The store choice is asserted through the LOG rather than by reaching into the
 * client, because that log line is the contract an operator reads — "will a
 * correlation key survive a restart" is not otherwise answerable from outside.
 */

import { workflow } from "@alexkroman1/aai";
import type { Db } from "@alexkroman1/aai/internal";
import type { WorkflowBody } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test, vi } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { createMemoryJournal } from "./workflow-journal-memory.ts";
import { buildWorkflowClient } from "./workflow-runtime.ts";

function body(): WorkflowBody {
  return (() => Promise.resolve()) as WorkflowBody;
}

const digest = workflow({ run: body() });
const unusedDb: Db = { query: () => Promise.reject(new Error("db not used")) };
const PUBLIC_URL = "https://agents.test/digest-desk";

describe("buildWorkflowClient", () => {
  test("returns undefined for an agent that declares no workflows", () => {
    // Not a rejecting client: the message an unavailable client rejects with has
    // exactly one producer, the tool executor.
    expect(buildWorkflowClient({}, unusedDb, undefined, makeLogger())).toBeUndefined();
  });

  test("returns undefined for an EMPTY workflows record", () => {
    // `agent({ workflows: {} })` is what a scaffold leaves behind, and it means
    // the same thing as declaring none.
    expect(
      buildWorkflowClient({ workflows: {} }, unusedDb, undefined, makeLogger()),
    ).toBeUndefined();
  });

  test("returns a client that lists the declared workflows", () => {
    const built = buildWorkflowClient({ workflows: { digest } }, unusedDb, undefined, makeLogger());
    expect(built?.client.listing().map((w) => w.name)).toEqual(["digest"]);
    // The engine's timers are the runtime's to cancel — see `BuiltWorkflowClient`.
    built?.stop();
  });

  test("uses the app database for the key index when storage is enabled", () => {
    const logger = makeLogger();
    buildWorkflowClient({ workflows: { digest } }, unusedDb, PUBLIC_URL, logger);
    expect(logger.info).toHaveBeenCalledWith("Workflows resolved", {
      workflows: ["digest"],
      keyStore: "postgres",
      // The RUN store is its own line, and asserting it is the point: it is the
      // question an operator asks after a restart. It follows the SAME
      // `DATABASE_URL` as the key index deliberately — an asymmetry is a trap
      // either way, a key pointing at a run that is gone or the reverse.
      runStore: "postgres",
      // And what `stepReport()` writes into, which is a THIRD question and the only
      // one whose answer never changes: there is no durable stream store, so a
      // postgres journal here sits beside an in-process progress log.
      progress: expect.stringContaining("memory"),
      // WHERE a delivery goes, which decides whether a `ctx.sleep` ever comes
      // back. Reported beside the store rather than inferred from it: a durable
      // journal behind in-process timers looks healthy and forgets every wait —
      // which it really did, until the engine started re-reading the journal at
      // construction. The parenthetical is asserted rather than matched loosely
      // because it is the CLAIM: drop the boot sweep and this line becomes the
      // overstatement it used to be.
      deliveries: "in-process timers (suspended runs re-enqueued at boot)",
      // How many step bodies may EXECUTE at once — a bound the engine owes now
      // that a step runs inline, and MEASURED against a guest rather than
      // inherited from the world this replaced (which ran three).
      stepConcurrency: 16,
      publicUrl: PUBLIC_URL,
    });
  });

  test("falls back to a memory index with no database, rather than withholding the client", () => {
    // This is the `aai dev` case. Making storage a hard requirement here would
    // break trying a workflow out before deploying it, which is the ordinary way
    // one gets written.
    const logger = makeLogger();
    const client = buildWorkflowClient({ workflows: { digest } }, undefined, PUBLIC_URL, logger);
    expect(client).toBeDefined();
    expect(logger.info).toHaveBeenCalledWith("Workflows resolved", {
      workflows: ["digest"],
      keyStore: "memory (in-process — a caller's next call will not find this run)",
      runStore: expect.stringContaining("memory"),
      progress: expect.stringContaining("memory"),
      deliveries: "in-process timers (suspended runs re-enqueued at boot)",
      stepConcurrency: 16,
      publicUrl: PUBLIC_URL,
    });
  });

  test("names the unset public URL in the boot line rather than omitting it", () => {
    // Whether a run can hand out a reachable callback URL is a property of the
    // DEPLOYMENT, and the alternative to saying so at boot is discovering it
    // from a throw inside a tool weeks later. An omitted field would read as
    // "nothing to report".
    const logger = makeLogger();
    buildWorkflowClient({ workflows: { digest } }, unusedDb, undefined, logger);
    expect(logger.info).toHaveBeenCalledWith(
      "Workflows resolved",
      expect.objectContaining({ publicUrl: "(unset — publicWebhookUrl will throw)" }),
    );
  });

  /**
   * The correlation-key INDEX is the same three-way choice, and it has to resolve
   * the same way the journal does.
   *
   * The two stores answer one question between them — "which run belongs to this
   * caller" — so a deployment that resolved them differently keeps the runs in one
   * place and the only pointer to them in another. That is not hypothetical: it is
   * what every deployed agent had. The journal's platform arm landed and this one
   * did not, so the RUN outlived its sandbox while the index died with it, and
   * `find()` answered `[]` on the caller's next call. Nothing could report it —
   * an empty index and a first-time caller are the same answer — and the boot line
   * said `keyStore: "memory"` on every deployment with nobody reading it.
   *
   * Asserted through the LOG for the reason the run journal is.
   */
  describe("the correlation-key index", () => {
    /** The two keys the PLATFORM sets in a sandbox's process env. */
    function withPlatform(): void {
      vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test/digest-desk");
      vi.stubEnv("AAI_GUEST_TOKEN", "sandbox-token");
    }

    function keyStoreOf(db: Db | undefined): unknown {
      const logger = makeLogger();
      buildWorkflowClient({ workflows: { digest } }, db, PUBLIC_URL, logger);
      const detail = vi.mocked(logger.info).mock.calls.at(-1)?.[1];
      return detail && typeof detail === "object"
        ? (detail as Record<string, unknown>).keyStore
        : undefined;
    }

    test("uses the platform with no database at all, which is the deployed shape", () => {
      // THE regression. The platform provisions no tenant database, so this is
      // every deployed agent, and it used to resolve to memory.
      withPlatform();
      expect(keyStoreOf(undefined)).toBe("platform");
    });

    test("prefers the PLATFORM even when the agent also has a database", () => {
      // Same reason the journal prefers it: a deployed guest may carry an
      // author-supplied `DATABASE_URL`, and its keys belong beside its runs rather
      // than in a second database the platform's own sweeps cannot see.
      withPlatform();
      expect(keyStoreOf(unusedDb)).toBe("platform");
    });

    test("resolves the index and the RUNS to the same home", () => {
      // The pairing, asserted directly rather than inferred from the two cases
      // above: an asymmetry here is a trap in both directions, and this is the one
      // line that shows both answers at once.
      withPlatform();
      const logger = makeLogger();
      buildWorkflowClient({ workflows: { digest } }, unusedDb, PUBLIC_URL, logger);
      expect(logger.info).toHaveBeenCalledWith(
        "Workflows resolved",
        expect.objectContaining({ keyStore: "platform", runStore: "platform" }),
      );
    });

    test("falls to postgres when there is a database and no platform", () => {
      expect(keyStoreOf(unusedDb)).toBe("postgres");
    });

    test("falls to memory with neither, and SAYS what that costs a caller", () => {
      // `aai dev`, and the honest trade for trying a workflow out before
      // provisioning anything. The consequence is spelled out for the reason the
      // run store's is: "memory" alone is what this line said on every deployed
      // agent, truthfully and uselessly.
      expect(keyStoreOf(undefined)).toBe(
        "memory (in-process — a caller's next call will not find this run)",
      );
    });

    test("ignores a half-configured platform rather than dialling nowhere", () => {
      // One key without the other means the platform spawned this guest
      // differently than this code expects; a base with no bearer would 401 every
      // call. Same refusal `resolvePlatformQueue` makes for the journal.
      vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test/digest-desk");
      expect(keyStoreOf(unusedDb)).toBe("postgres");
    });
  });

  /**
   * The run journal is a three-way choice with a strict preference, and the two
   * ways to get it wrong are both silent.
   *
   * Getting it wrong DOWNWARD is what shipped: a deployed guest reached neither
   * durable backend, so every deployed run journaled into a sandbox that
   * self-exits. Getting it wrong UPWARD would be subtler — a deployed guest whose
   * author also set a `DATABASE_URL` splitting its runs across two databases,
   * with only one of them visible to the wake sweep.
   *
   * Asserted through the LOG for the reason the key store is: "will this run
   * survive a restart" is not otherwise answerable from outside.
   */
  describe("the run journal", () => {
    /** The two keys the PLATFORM sets in a sandbox's process env. */
    function withPlatform(): void {
      vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test/digest-desk");
      vi.stubEnv("AAI_GUEST_TOKEN", "sandbox-token");
    }

    function runStoreOf(db: Db | undefined): unknown {
      const logger = makeLogger();
      buildWorkflowClient({ workflows: { digest } }, db, PUBLIC_URL, logger);
      const call = vi.mocked(logger.info).mock.calls.at(-1);
      const detail = call?.[1];
      return detail && typeof detail === "object"
        ? (detail as Record<string, unknown>).runStore
        : undefined;
    }

    test("pairs the platform journal with the platform QUEUE, never local timers", () => {
      // The two halves come from one resolved pair on purpose. A platform journal
      // behind in-process timers would store a sleep's deadline durably and then
      // forget to come back for it once the sandbox self-exits — the same failure
      // as no journal at all, with a healthier-looking boot line.
      withPlatform();
      const logger = makeLogger();
      buildWorkflowClient({ workflows: { digest } }, unusedDb, PUBLIC_URL, logger);
      expect(logger.info).toHaveBeenCalledWith(
        "Workflows resolved",
        expect.objectContaining({ runStore: "platform", deliveries: "platform queue" }),
      );
    });

    test("prefers the PLATFORM even when the agent also has a database", () => {
      // A deployed guest may carry an author-supplied `DATABASE_URL`. Its runs
      // belong beside its session state in the platform's journal, not split
      // across two databases where the wake sweep can see only one of them.
      withPlatform();
      expect(runStoreOf(unusedDb)).toBe("platform");
    });

    test("uses the platform with no database at all, which is the deployed shape", () => {
      // The regression. The platform provisions no tenant database, so this is
      // every deployed agent — and it used to resolve to memory.
      withPlatform();
      expect(runStoreOf(undefined)).toBe("platform");
    });

    test("falls to postgres when there is a database and no platform", () => {
      expect(runStoreOf(unusedDb)).toBe("postgres");
    });

    test("falls to memory with neither, and SAYS the runs will not survive", () => {
      // The honest trade for trying a workflow out before provisioning anything.
      // It has to be in the line, because a durability tradeoff absent from the
      // log reads as a bug.
      expect(runStoreOf(undefined)).toBe("memory (in-process — runs do not survive a restart)");
    });

    test("SAYS the progress channel is memory when the journal is durable", () => {
      // The asymmetry nothing reported: a deployed guest gets a platform journal
      // and, because no platform-backed stream store exists, an in-memory
      // `stepReport()` channel. A run that outlives its sandbox therefore resumes
      // with an empty progress log and `lastLine` answers `undefined` for a run
      // that narrated fine before the boot — which reads as a broken page rather
      // than as a store that was never durable. It cannot be FIXED here, so it is
      // said out loud: in the boot line, and once at `warn`.
      withPlatform();
      const logger = makeLogger();
      buildWorkflowClient({ workflows: { digest } }, unusedDb, PUBLIC_URL, logger);
      expect(logger.info).toHaveBeenCalledWith(
        "Workflows resolved",
        expect.objectContaining({
          runStore: "platform",
          progress: expect.stringMatching(/memory/),
        }),
      );
      expect(logger.warn).toHaveBeenCalledWith(
        "Workflow progress is not durable",
        expect.objectContaining({ runStore: "platform" }),
      );
    });

    test("does not WARN when the runs are in memory too, there being no asymmetry", () => {
      // `aai dev` with nothing provisioned. The runs and their narration are
      // equally forgotten on a restart, which the run-store line already says —
      // a second warning there would train an author to ignore this one.
      const logger = makeLogger();
      buildWorkflowClient({ workflows: { digest } }, undefined, PUBLIC_URL, logger);
      expect(logger.warn).not.toHaveBeenCalled();
    });

    test("ignores a half-configured platform rather than dialling nowhere", () => {
      // One of the two keys means the platform spawned this guest differently
      // than this code expects. A base with no bearer would 401 every call.
      vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test/digest-desk");
      expect(runStoreOf(unusedDb)).toBe("postgres");
    });

    /**
     * STORAGE per PROCESS, CODE per BUILD — the split the deleted DevKit world
     * used to make for us, and the half `aai dev` lost with it.
     *
     * Every file save rebuilds the runtime, so every save called
     * `createInProcessWorkflowEngine` with no journal and got a FRESH
     * `createMemoryJournal()`. A run started before a save was gone after it and
     * `GET /workflows/runs/:id` answered 404 for a run the caller was still
     * holding the id of — which reads as the run having failed rather than as
     * the store having been replaced.
     *
     * The seam is one journal handed in from process scope. The engine still
     * comes per build, which is what keeps hot reload: a rebuild must run the
     * NEW body.
     */
    describe("a caller-supplied journal", () => {
      test("keeps a run readable across a rebuild that replaces the client", async () => {
        const journal = createMemoryJournal();
        const first = buildWorkflowClient(
          { workflows: { digest } },
          undefined,
          PUBLIC_URL,
          makeLogger(),
          journal,
        );
        const runId = await first?.client.start(digest, {});
        expect(runId).toBeDefined();
        // The save: the old engine's timers are cancelled and a new client is
        // built over the same storage.
        first?.stop();

        const second = buildWorkflowClient(
          { workflows: { digest } },
          undefined,
          PUBLIC_URL,
          makeLogger(),
          journal,
        );
        expect(await second?.client.get(runId as string)).toBeDefined();
        second?.stop();
      });

      test("NAMES itself in the boot line, rather than reporting the per-build default", () => {
        // The run store line is what an operator reads to answer "will this
        // survive". A supplied journal survives a rebuild and not a restart,
        // which is neither of the two answers the line could give before.
        const logger = makeLogger();
        buildWorkflowClient(
          { workflows: { digest } },
          undefined,
          PUBLIC_URL,
          logger,
          createMemoryJournal(),
        );
        expect(logger.info).toHaveBeenCalledWith(
          "Workflows resolved",
          expect.objectContaining({
            runStore: "memory (host-supplied — runs survive a rebuild, not a restart)",
          }),
        );
      });

      test("does not outrank postgres, which is durable where it is not", () => {
        // The memory arm ONLY. A host that supplies a journal for its rebuild
        // case must not thereby demote the agent's own database.
        const logger = makeLogger();
        buildWorkflowClient(
          { workflows: { digest } },
          unusedDb,
          PUBLIC_URL,
          logger,
          createMemoryJournal(),
        );
        expect(logger.info).toHaveBeenCalledWith(
          "Workflows resolved",
          expect.objectContaining({ runStore: "postgres" }),
        );
      });

      test("does not outrank the PLATFORM either, which is the deployed shape", () => {
        withPlatform();
        const logger = makeLogger();
        buildWorkflowClient(
          { workflows: { digest } },
          undefined,
          PUBLIC_URL,
          logger,
          createMemoryJournal(),
        );
        expect(logger.info).toHaveBeenCalledWith(
          "Workflows resolved",
          expect.objectContaining({ runStore: "platform", deliveries: "platform queue" }),
        );
      });
    });
  });
});
