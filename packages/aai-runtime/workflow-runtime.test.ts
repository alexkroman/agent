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
      // WHERE a delivery goes, which decides whether a `ctx.sleep` ever comes
      // back. Reported beside the store rather than inferred from it: a durable
      // journal behind in-process timers looks healthy and forgets every wait.
      deliveries: "in-process timers",
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
      keyStore: "memory",
      runStore: expect.stringContaining("memory"),
      deliveries: "in-process timers",
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

    test("ignores a half-configured platform rather than dialling nowhere", () => {
      // One of the two keys means the platform spawned this guest differently
      // than this code expects. A base with no bearer would 401 every call.
      vi.stubEnv("AAI_PLATFORM_BASE_URL", "https://platform.test/digest-desk");
      expect(runStoreOf(unusedDb)).toBe("postgres");
    });
  });
});
