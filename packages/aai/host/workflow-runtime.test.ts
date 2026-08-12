// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the one decision in `workflow-runtime.ts`: whether a runtime gets a
 * `ctx.workflows` at all, and which key store backs it.
 *
 * The store choice is asserted through the LOG rather than by reaching into the
 * client, because that log line is the contract an operator reads — "will a
 * correlation key survive a restart" is not otherwise answerable from outside.
 */

import { describe, expect, test, vi } from "vitest";
import type { Db } from "../sdk/db.ts";
import { type WorkflowBody, workflow } from "../sdk/workflow.ts";
import { buildWorkflowClient } from "./workflow-runtime.ts";

function body(id: string): WorkflowBody {
  const fn = (() => Promise.resolve()) as WorkflowBody;
  fn.workflowId = id;
  return fn;
}

const digest = workflow({ run: body("workflow//./workflows/digest//digestFlow") });
const unusedDb: Db = { query: () => Promise.reject(new Error("db not used")) };

function makeLogger() {
  return { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() };
}

describe("buildWorkflowClient", () => {
  test("returns undefined for an agent that declares no workflows", () => {
    // Not a rejecting client: the message an unavailable client rejects with has
    // exactly one producer, the tool executor.
    expect(buildWorkflowClient({}, unusedDb, makeLogger())).toBeUndefined();
  });

  test("returns undefined for an EMPTY workflows record", () => {
    // `agent({ workflows: {} })` is what a scaffold leaves behind, and it means
    // the same thing as declaring none.
    expect(buildWorkflowClient({ workflows: {} }, unusedDb, makeLogger())).toBeUndefined();
  });

  test("returns a client that lists the declared workflows", () => {
    const client = buildWorkflowClient({ workflows: { digest } }, unusedDb, makeLogger());
    expect(client?.listing().map((w) => w.name)).toEqual(["digest"]);
  });

  test("uses the app database for the key index when storage is enabled", () => {
    const logger = makeLogger();
    buildWorkflowClient({ workflows: { digest } }, unusedDb, logger);
    expect(logger.info).toHaveBeenCalledWith("Workflows resolved", {
      workflows: ["digest"],
      keyStore: "postgres",
    });
  });

  test("falls back to a memory index with no database, rather than withholding the client", () => {
    // This is the `aai dev` case. Making storage a hard requirement here would
    // break trying a workflow out before deploying it, which is the ordinary way
    // one gets written.
    const logger = makeLogger();
    const client = buildWorkflowClient({ workflows: { digest } }, undefined, logger);
    expect(client).toBeDefined();
    expect(logger.info).toHaveBeenCalledWith("Workflows resolved", {
      workflows: ["digest"],
      keyStore: "memory",
    });
  });
});
