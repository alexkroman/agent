// Copyright 2026 the AAI authors. MIT license.
/**
 * `agentServerEnv` — which keys of an agent's env reach `createRuntimeServer`.
 *
 * The cases came from the guest harness, which had its own copy of this filter
 * until `createAgentServer` turned out to need the same one. Its `createRuntimeServer`
 * call was made with no `env` AT ALL; the wrapper's was made with the agent's env
 * going only to the runtime — the same three symptoms by two routes.
 */

import { describe, expect, test, vi } from "vitest";
import { silentLogger } from "./_test-utils.ts";
import { isHostAllowed } from "./host-mode.ts";
import { agentGateToken, agentServerEnv } from "./server-env.ts";

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

/**
 * The gate read, which used to be `env?.[NAME]`.
 *
 * The FAILING observation is one layer up, in `workflow-api-http.test.ts` and
 * `session-events-api.test.ts`: a set-but-empty value authenticated every
 * caller, `timingSafeEqual` matching two empty buffers. `bearerMatches` refuses
 * a blank secret now — what this read adds is that the ROUTE lands on the
 * posture its own doc documents for an unset variable, and that the operator is
 * told, instead of getting a surface that 401s forever for no stated reason.
 *
 * A RECORDING logger rather than `silentLogger`, whose members are deliberate
 * no-ops (see its own comment): the announcement is half of what this function
 * is for, so a test that could not see it would be asserting the cheaper half.
 */
describe("agentGateToken", () => {
  function recorder() {
    return { ...silentLogger, error: vi.fn() };
  }

  test("passes a real secret through untouched", () => {
    const logger = recorder();
    expect(
      agentGateToken({ AAI_WORKFLOW_API_TOKEN: "s3cret" }, "AAI_WORKFLOW_API_TOKEN", logger),
    ).toBe("s3cret");
    expect(logger.error).not.toHaveBeenCalled();
  });

  test.each(["", " ", "   ", "\t\n"])("reads a blank value (%j) as ABSENT", (value) => {
    const logger = recorder();
    expect(
      agentGateToken({ AAI_SESSION_EVENTS_TOKEN: value }, "AAI_SESSION_EVENTS_TOKEN", logger),
    ).toBeUndefined();
  });

  test("ANNOUNCES a blank value, naming the variable", () => {
    // The log is the only channel that can tell an operator their closed surface
    // is not closed: a throw would take the whole agent — voice sessions included
    // — off the air before the bind, so the `/manage` surface `aai logs` reads
    // from would never exist to serve the explanation.
    const logger = recorder();
    agentGateToken({ AAI_WORKFLOW_API_TOKEN: "" }, "AAI_WORKFLOW_API_TOKEN", logger);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(String(logger.error.mock.calls[0]?.[0])).toContain("AAI_WORKFLOW_API_TOKEN");
  });

  test("says NOTHING when the variable is simply unset", () => {
    // Unset is the documented default for both keys, not a misconfiguration —
    // announcing it would train an operator to ignore the line that matters.
    const logger = recorder();
    expect(agentGateToken({}, "AAI_WORKFLOW_API_TOKEN", logger)).toBeUndefined();
    expect(agentGateToken(undefined, "AAI_WORKFLOW_API_TOKEN", logger)).toBeUndefined();
    expect(logger.error).not.toHaveBeenCalled();
  });

  test("leaves a PADDED secret alone rather than reading it as absent", () => {
    // `parseBearer` trims, so this one can never be presented and the route will
    // 401 — which is the safe direction. Reporting it absent would OPEN the
    // workflow API on a typo, which is not.
    const logger = recorder();
    expect(
      agentGateToken({ AAI_WORKFLOW_API_TOKEN: " s3cret " }, "AAI_WORKFLOW_API_TOKEN", logger),
    ).toBe(" s3cret ");
    expect(logger.error).not.toHaveBeenCalled();
  });
});
