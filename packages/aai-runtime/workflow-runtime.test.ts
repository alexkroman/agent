// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the one decision in `workflow-runtime.ts`: whether a runtime gets a
 * `ctx.workflows` at all, and which key store backs it.
 *
 * The store choice is asserted through the LOG rather than by reaching into the
 * client, because that log line is the contract an operator reads — "will a
 * correlation key survive a restart" is not otherwise answerable from outside.
 */

import type { Db } from "@alexkroman1/aai";
import { workflow } from "@alexkroman1/aai";
import type { WorkflowBody } from "@alexkroman1/aai/workflow-api";
import { describe, expect, test } from "vitest";
import { makeLogger } from "./_test-utils.ts";
import { buildWorkflowClient } from "./workflow-runtime.ts";

function body(id: string): WorkflowBody {
  const fn = (() => Promise.resolve()) as WorkflowBody;
  fn.workflowId = id;
  return fn;
}

const digest = workflow({ run: body("workflow//./workflows/digest//digestFlow") });
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
    const client = buildWorkflowClient(
      { workflows: { digest } },
      unusedDb,
      undefined,
      makeLogger(),
    );
    expect(client?.listing().map((w) => w.name)).toEqual(["digest"]);
  });

  test("uses the app database for the key index when storage is enabled", () => {
    const logger = makeLogger();
    buildWorkflowClient({ workflows: { digest } }, unusedDb, PUBLIC_URL, logger);
    expect(logger.info).toHaveBeenCalledWith("Workflows resolved", {
      workflows: ["digest"],
      keyStore: "postgres",
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
});
