// Copyright 2026 the AAI authors. MIT license.
/**
 * The orphan-preview reap deletes in SQL what `deleteAgent` deletes in
 * TypeScript, and this is what stops the two drifting.
 *
 * `aai-sweep-orphan-previews` (`pg-cron.ts`) is a second implementation of the
 * delete path. That is the one real cost of moving the reap back into pg_cron,
 * and the sweep's own history is why it needs a guard rather than a promise:
 * the previous SQL version, with no admin DSN resolvable, deleted the agents row
 * and LEAKED the database with a warning — tenant data with its only credential
 * gone. A second deleter does not announce the day it stops matching.
 *
 * ## What this asserts, and why it reads the SOURCE
 *
 * `deleteAgent`'s steps are calls on collaborators (`agents.delete`,
 * `secrets.delete`), so a behavioural test can only see the stores it was handed
 * — it cannot see that a THIRD store was added. Reading the source is what makes
 * "a step was added" visible, and the failure names the SQL body that has to
 * learn the same step.
 *
 * It is deliberately a NAME-level check, not a semantic one. It cannot prove the
 * two do the same thing; it can only refuse to let one grow silently. That is the
 * whole job — a reviewer who sees this fail is being asked a question, not
 * corrected.
 */

import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { platformCronJobs } from "./pg-cron.ts";
import { AGENT_ENV_SECRET_PREFIX } from "./secret-store.ts";

/** The reap body, which is what has to keep up. */
const reapBody = (): string =>
  platformCronJobs().find((j) => j.name === "aai-sweep-orphan-previews")?.command ?? "";

/**
 * `deleteAgent`'s body out of `bundle-store.ts`, comments and all.
 *
 * THROWS rather than asserting when it cannot find the method: an `expect` in a
 * helper is what `noMisplacedAssertion` bans, and it would be the wrong shape
 * anyway — a guard that cannot locate its target has found no fact about the
 * code, so the honest outcome is a failed run naming the retarget, not a failed
 * assertion about steps it never read.
 */
function deleteAgentBody(): string {
  const source = readFileSync(path.join(import.meta.dirname, "bundle-store.ts"), "utf-8");
  const start = source.indexOf("async deleteAgent(slug) {");
  if (start < 0) throw new Error("deleteAgent moved or was renamed — retarget this guard");
  // To the next method at the same indentation, which is how every store method
  // in that file ends.
  const end = source.indexOf("\n    },\n", start);
  if (end <= start) throw new Error("could not find the end of deleteAgent");
  return source.slice(start, end);
}

/**
 * Code-unit order, never `localeCompare` — the repo's standing rule for anything
 * sorted before comparison: with no explicit locale that answers to the runtime's
 * ICU default, so the same input could order differently on another machine.
 */
const byCodeUnit = (a: string, b: string): number => {
  if (a === b) return 0;
  return a < b ? -1 : 1;
};

describe("the reap and deleteAgent delete the same things", () => {
  test("the job exists, so this guard is not passing over an absence", () => {
    // The floor under everything below: `find` returning undefined would make
    // every `toContain` run against "" and the whole file green.
    expect(reapBody()).toContain("aai_platform.agents");
  });

  /**
   * ONE store call per step, and the count is the tripwire.
   *
   * Two today: the agents row and the agent's env secret. A third — a blob
   * delete, an external call, another table — makes this fail, and the fix is
   * either to teach the SQL body the same step or to decide the reap should stop
   * being SQL.
   */
  test("deleteAgent has exactly the two steps the SQL body covers", () => {
    const body = deleteAgentBody();
    const calls = [...body.matchAll(/\b(?:agents|secrets|blobs|store)\.\w+\(/g)].map((m) => m[0]);
    expect(
      // Code-unit, never `localeCompare` — the repo's standing rule for a sorted
      // artifact: with no explicit locale that answers to the runtime's ICU default.
      calls.toSorted(byCodeUnit),
      "deleteAgent's steps changed — `aai-sweep-orphan-previews` in pg-cron.ts is a " +
        "second implementation of this path and has to learn the same step, or the " +
        "reap has to stop being SQL. See that job's doc.",
    ).toEqual(["agents.delete(", "secrets.delete("]);
  });

  test("the SQL body deletes the agents row", () => {
    expect(reapBody()).toContain("delete from aai_platform.agents");
  });

  test("the SQL body deletes the env secret, by the prefix its writer uses", () => {
    // Interpolated from the same constant `agentEnvSecretName` builds from, which
    // is what keeps a rename from making the sweep delete nothing, silently —
    // `AGENT_ENV_SECRET_PREFIX`'s own doc is about exactly this.
    expect(reapBody()).toContain("delete from vault.secrets");
    expect(reapBody()).toContain(AGENT_ENV_SECRET_PREFIX);
  });

  /**
   * The ROW goes LAST, and the order is a crash-safety property.
   *
   * The original SQL version deleted rows in the statement that returned them, so
   * a body dying mid-loop left the remaining slugs' resources orphaned with
   * nothing naming them. With the row last, a crash anywhere before it leaves the
   * candidate visible to the next pass.
   */
  test("the agents row is deleted AFTER the secret", () => {
    const body = reapBody();
    expect(body.indexOf("delete from vault.secrets")).toBeLessThan(
      body.indexOf("delete from aai_platform.agents where slug = candidate"),
    );
  });
});
