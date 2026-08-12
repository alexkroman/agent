// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for world selection.
 *
 * These assert on the ENVIRONMENT rather than on a resolved world, and that is
 * the point rather than a shortcut: `getWorld()` memoizes on first read, so a
 * spec that resolved one would pin the first test's choice for the whole file
 * and every later assertion would be reading a cache. The environment is also
 * the real contract — the DevKit reads exactly these variables.
 */

import { describe, expect, test, vi } from "vitest";
import {
  configureWorkflowWorld,
  startWorkflowWorldIfDeclared,
  startWorkflowWorldSafely,
} from "./workflow-world.ts";

/** A fresh env per case, so nothing leaks between them. */
function env(over: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { ...over };
}

describe("configureWorkflowWorld", () => {
  test("picks Postgres when the app has a database", () => {
    const e = env();
    expect(configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e })).toBe(
      "postgres",
    );
    expect(e.WORKFLOW_TARGET_WORLD).toBe("@workflow/world-postgres");
    expect(e.WORKFLOW_POSTGRES_URL).toBe("postgres://x/y");
  });

  test("sets the connection string explicitly rather than leaning on the DATABASE_URL fallback", () => {
    // The world does fall back to DATABASE_URL, but the two being equal would
    // be a coincidence rather than a contract.
    const e = env({ DATABASE_URL: "postgres://somewhere/else" });
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e });
    expect(e.WORKFLOW_POSTGRES_URL).toBe("postgres://x/y");
  });

  test("picks the local world with no database", () => {
    const e = env();
    expect(configureWorkflowWorld({ databaseUrl: undefined, port: 3000, env: e })).toBe("local");
    expect(e.WORKFLOW_TARGET_WORLD).toBe("local");
  });

  test("tells the local world our port, because it enqueues by calling back", () => {
    // Its default is PORT or an auto-detect, and the guest binds a port it was
    // handed rather than one it announces — so without this every enqueue
    // quietly fails to reach us.
    const e = env();
    configureWorkflowWorld({ databaseUrl: undefined, port: 41_234, env: e });
    expect(e.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:41234");
  });

  test("uses loopback rather than the bind host for that callback", () => {
    const e = env();
    configureWorkflowWorld({ databaseUrl: undefined, port: 3000, env: e });
    // Only this process ever dials it.
    expect(e.WORKFLOW_LOCAL_BASE_URL).toContain("127.0.0.1");
  });

  test("leaves an operator's own base URL alone", () => {
    const e = env({ WORKFLOW_LOCAL_BASE_URL: "https://tunnel.example" });
    configureWorkflowWorld({ databaseUrl: undefined, port: 3000, env: e });
    expect(e.WORKFLOW_LOCAL_BASE_URL).toBe("https://tunnel.example");
  });

  test("respects an operator-chosen world instead of overriding it", () => {
    // A self-hosted deployment pointing at its own world is legitimate;
    // overriding would be the platform reaching past the operator.
    const e = env({ WORKFLOW_TARGET_WORLD: "@acme/world-sqs" });
    expect(configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e })).toBe(
      "local",
    );
    expect(e.WORKFLOW_TARGET_WORLD).toBe("@acme/world-sqs");
    // And it must not stamp a connection string for a world that never asked.
    expect(e.WORKFLOW_POSTGRES_URL).toBeUndefined();
  });

  test("reports postgres for an operator who named the Postgres world themselves", () => {
    const e = env({
      WORKFLOW_TARGET_WORLD: "@workflow/world-postgres",
      WORKFLOW_POSTGRES_URL: "postgres://operator/db",
    });
    // The KIND drives whether the boot runs the migration, so an operator on
    // Postgres has to get the migration too.
    expect(configureWorkflowWorld({ databaseUrl: undefined, port: 3000, env: e })).toBe("postgres");
    expect(e.WORKFLOW_POSTGRES_URL).toBe("postgres://operator/db");
  });

  test("treats an empty database URL as no database", () => {
    // `resolveServerEnv` drops empty declared values, but a boot env assembled
    // elsewhere can still carry one, and `postgres://` with nothing after it is
    // not a connection string.
    const e = env();
    expect(configureWorkflowWorld({ databaseUrl: "", port: 3000, env: e })).toBe("local");
    expect(e.WORKFLOW_TARGET_WORLD).toBe("local");
  });
});

describe("startWorkflowWorldIfDeclared", () => {
  test("does nothing for an agent that declares no workflows", async () => {
    // The gate matters: migrating and subscribing a queue are both expensive,
    // and reaching a world at all would make every workflow-less agent pay for
    // a feature it never asked for.
    await expect(startWorkflowWorldIfDeclared(false, "postgres")).resolves.toBeUndefined();
  });
});

describe("startWorkflowWorldSafely", () => {
  test("reports a failure instead of throwing it", async () => {
    // There is no world configured in this process, so starting one fails —
    // which is the case under test. A guest whose workflows cannot start must
    // still boot and answer the phone.
    const errors: unknown[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    await expect(startWorkflowWorldSafely("postgres")).resolves.toBe(false);
    // Silently returning false would leave an operator with no way to find out.
    expect(errors.length).toBeGreaterThan(0);
    spy.mockRestore();
  });
});
