// Copyright 2026 the AAI authors. MIT license.
/**
 * `agentServerEnv` — which keys of an agent's env reach `createServer`.
 *
 * The cases came from the guest harness, which had its own copy of this filter
 * until `createAgentServer` turned out to need the same one. Its `createServer`
 * call was made with no `env` AT ALL; the wrapper's was made with the agent's env
 * going only to the runtime — the same three symptoms by two routes.
 */

import { describe, expect, test } from "vitest";
import { isHostAllowed } from "./host-mode.ts";
import { agentServerEnv } from "./server-env.ts";

describe("agentServerEnv", () => {
  test("carries DATABASE_URL, which is what a workflow upload's RECORD needs", () => {
    // Without it `installWorkflowSupport` sees no database however the app's was
    // provisioned, so uploads go to this process's temp directory and are gone by the
    // time a resumed run reads them.
    expect(agentServerEnv({ DATABASE_URL: "postgres://app@db/x" })).toEqual({
      DATABASE_URL: "postgres://app@db/x",
    });
  });

  test("carries the two API tokens, which are what CLOSE their routes", () => {
    // `AAI_WORKFLOW_API_TOKEN` is documented as what closes `/workflows/*`. Not read,
    // it does nothing, and an operator who set the secret is still serving that API —
    // and its upload write routes — open.
    expect(
      agentServerEnv({
        AAI_WORKFLOW_API_TOKEN: "w",
        AAI_SESSION_EVENTS_TOKEN: "s",
      }),
    ).toEqual({ AAI_WORKFLOW_API_TOKEN: "w", AAI_SESSION_EVENTS_TOKEN: "s" });
  });

  test("DROPS the host-mode gate, which is not an agent env's to set", () => {
    // `?host=1` lets a caller supply its own agent definition, `/websocket` has no
    // authentication of its own, and a session then runs on the operator's provider
    // credentials with a prompt of the caller's choosing — so this key arriving with
    // the three above would turn one secret into that.
    const env = agentServerEnv({ AAI_ALLOW_HOST: "1", DATABASE_URL: "postgres://app@db/x" });
    expect(env).not.toHaveProperty("AAI_ALLOW_HOST");
    expect(env.DATABASE_URL).toBe("postgres://app@db/x");
  });

  test("drops it whatever spelling turns the gate ON", () => {
    // `isHostAllowed` accepts 1/true/yes/on, so a filter keyed on the VALUE would leak
    // three of them. Keyed on the NAME, so it cannot.
    for (const value of ["1", "true", "yes", "on", "TRUE"]) {
      expect(agentServerEnv({ AAI_ALLOW_HOST: value })).toEqual({});
      expect(isHostAllowed({ AAI_ALLOW_HOST: value })).toBe(true);
    }
  });
});
