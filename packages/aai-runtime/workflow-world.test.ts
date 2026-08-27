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

import { isAbsolute } from "node:path";
import {
  APP_DB_WORLD_POOL_MAX,
  APP_DB_WORLD_WORKER_CONCURRENCY,
} from "@alexkroman1/aai/host-internal";
import { describe, expect, test, vi } from "vitest";
import {
  configureWorkflowWorld,
  localWorkflowDataDir,
  startWorkflowWorldIfDeclared,
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
    expect(e.WORKFLOW_TARGET_WORLD).toContain("@workflow/world-postgres");
    expect(e.WORKFLOW_POSTGRES_URL).toBe("postgres://x/y");
  });

  test("the world it names is an ABSOLUTE PATH, not a bare specifier", () => {
    // The bug this pins, in the terms it fails in. The DevKit `require`s this
    // value from its OWN compiled artifact in `tmpdir()` — a path we do not pick —
    // so a bare `"@workflow/world-postgres"` resolves against `$TMPDIR/node_modules`
    // and dies with `Cannot find module` naming a package that is plainly
    // installed. An absolute path is resolvable from any directory.
    //
    // The assertion is the SHAPE rather than a resolution, and that is a property
    // of this tier: vitest patches `createRequire`, so
    // `resolve("@workflow/world-postgres")` succeeds even from `tmpdir()` and the
    // real failure cannot be provoked here — verified, the negative control did
    // not throw. Same trap the guest guide records for `loadTransformer`, and the
    // same reason `harness-externals.test.ts` asserts a file's location rather
    // than what it can require.
    const e = env();
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e });
    const world = e.WORKFLOW_TARGET_WORLD ?? "";

    expect(isAbsolute(world)).toBe(true);
    expect(world.endsWith(".js") || world.endsWith(".mjs") || world.endsWith(".cjs")).toBe(true);
  });

  test("the resolved path still CLASSIFIES as the Postgres world", () => {
    // An absolute path is a new spelling, and a spelling this classifier misses is
    // a Postgres world reported as `local`: loaded by the DevKit and never
    // migrated, which the classifier's own doc records as a shipped failure. The
    // round trip is what pins it — a guest that inherits the variable it set on a
    // previous boot takes the `supplied` branch.
    const first = env();
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: first });
    const inherited = env({ WORKFLOW_TARGET_WORLD: first.WORKFLOW_TARGET_WORLD });

    expect(
      configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: inherited }),
    ).toBe("postgres");
  });

  test("pins the world's pool and concurrency from the guest's connection budget", () => {
    // The DevKit's own defaults are node-postgres's 10 and a concurrency of 10,
    // which is more than a whole app role may hold — and the numbers that replace
    // them are terms in one budget (`sdk/app-db-budget.ts`), not local choices.
    // What this pins is the WIRING: the DevKit reads exactly these two variables,
    // so a rename or a dropped assignment is a guest that silently inherits the
    // defaults and fails `too many connections for role "app_…"`.
    const e = env();
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e });
    expect(e.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe(String(APP_DB_WORLD_POOL_MAX));
    expect(e.WORKFLOW_POSTGRES_WORKER_CONCURRENCY).toBe(String(APP_DB_WORLD_WORKER_CONCURRENCY));
  });

  test("leaves an operator's own pool sizing alone", () => {
    // `??=`, so a self-hosted deployment running its own Postgres can tune these.
    const e = env({
      WORKFLOW_POSTGRES_MAX_POOL_SIZE: "20",
      WORKFLOW_POSTGRES_WORKER_CONCURRENCY: "20",
    });
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e });
    expect(e.WORKFLOW_POSTGRES_MAX_POOL_SIZE).toBe("20");
    expect(e.WORKFLOW_POSTGRES_WORKER_CONCURRENCY).toBe("20");
  });

  test("sets the connection string explicitly rather than leaning on the DATABASE_URL fallback", () => {
    // The world does fall back to DATABASE_URL, but the two being equal would
    // be a coincidence rather than a contract.
    const e = env({ DATABASE_URL: "postgres://somewhere/else" });
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 3000, env: e });
    expect(e.WORKFLOW_POSTGRES_URL).toBe("postgres://x/y");
  });

  test("tells the POSTGRES world our port too, or every dispatch auto-detects it", () => {
    // The variable is named LOCAL and is read by world-postgres as well: it is
    // the FIRST branch of that world's own `getExecutionBaseUrl()`, the origin
    // its queue dispatches `flow` and `step` callbacks to. Unset, it falls
    // through to `getWorkflowPort()` — health-probe port auto-detection — on
    // EVERY dispatch.
    //
    // Measured before this line existed: ~45ms per dispatch, steady, against
    // ~7ms of step work and ~1ms for graphile-worker's whole enqueue->handler
    // path. Two dispatches per step->step hop made it ~90ms of a ~120ms hop, so
    // a six-step run took ~600ms instead of ~70ms. Nothing errors — which is why
    // it needs a test rather than a comment.
    const e = env();
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 41_234, env: e });
    expect(e.WORKFLOW_LOCAL_BASE_URL).toBe("http://127.0.0.1:41234");
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

  test("names a data dir of its own rather than inheriting the DevKit's cwd default", () => {
    // `.workflow-data` relative to `process.cwd()` is what the DevKit picks on
    // its own, and a guest's cwd is not a location it chose: the platform image
    // sets no WORKDIR, and the subprocess backend hands EVERY guest `tmpdir()`.
    const e = env();
    configureWorkflowWorld({ databaseUrl: undefined, port: 3000, env: e });
    const dir = e.WORKFLOW_LOCAL_DATA_DIR ?? "";
    expect(isAbsolute(dir)).toBe(true);
    // Per process, because this world's queue is in memory: a successor
    // inheriting the directory recovers runs whose queue died with it.
    expect(dir).toContain(String(process.pid));
  });

  test("takes the caller's data dir over the default", () => {
    // `aai dev` passes the project directory — there a restart is a save, and
    // the runs are meant to survive it.
    const e = env();
    configureWorkflowWorld({ databaseUrl: undefined, port: 3000, dataDir: "/srv/app", env: e });
    expect(e.WORKFLOW_LOCAL_DATA_DIR).toBe("/srv/app");
  });

  test("leaves an operator's own data dir alone", () => {
    const e = env({ WORKFLOW_LOCAL_DATA_DIR: "/var/runs" });
    configureWorkflowWorld({ databaseUrl: undefined, port: 3000, dataDir: "/srv/app", env: e });
    expect(e.WORKFLOW_LOCAL_DATA_DIR).toBe("/var/runs");
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

describe("localWorkflowDataDir", () => {
  test("answers the directory configureWorkflowWorld agreed on", () => {
    const vars = env();
    configureWorkflowWorld({
      databaseUrl: undefined,
      port: 3000,
      dataDir: "/data/here",
      env: vars,
    });
    // READ from the env rather than recomputed: the upload store needs the same
    // directory the runs are in, and two callers deriving it independently is how
    // they come to disagree — silently, since neither errors.
    expect(localWorkflowDataDir(vars)).toBe("/data/here");
  });

  test("answers a per-process directory when nothing configured one", () => {
    // A `createServer` that never called `configureWorkflowWorld` — a self-hosted
    // embedder. Per-process is the honest answer there: so are its runs.
    expect(localWorkflowDataDir(env())).toContain(`aai-workflow-data-${process.pid}`);
  });
});

describe("startWorkflowWorldIfDeclared", () => {
  test("does nothing for an agent that declares no workflows", async () => {
    // The gate matters: migrating and subscribing a queue are both expensive,
    // and reaching a world at all would make every workflow-less agent pay for
    // a feature it never asked for.
    await expect(startWorkflowWorldIfDeclared(false, "postgres")).resolves.toBeUndefined();
  });

  /**
   * A postgres start that RELIABLY fails, pointed at a closed port.
   *
   * The database has to be named explicitly: this suite used to assert a failure
   * on the premise that "there is no world configured in this process", and that
   * premise is false — the start SUCCEEDS here, against whatever is on
   * `localhost:5432`. The old assertion (`errors.length > 0`) passed anyway,
   * satisfied by the world's OWN migration logging rather than by our catch, so
   * the failure path it was named for had never run.
   */
  function pointAtAClosedPort(): void {
    // Port 1 is never listening, so `connect` is refused immediately rather than
    // spending a connect timeout in a 5s tier.
    vi.stubEnv("WORKFLOW_POSTGRES_URL", "postgres://nobody@127.0.0.1:1/nothing");
  }

  test("reports a failure instead of throwing it", async () => {
    // A guest whose workflows cannot start must still boot and answer the phone.
    pointAtAClosedPort();
    const errors: unknown[] = [];
    // No `mockRestore()`: `restoreMocks` already restores every `vi.spyOn`
    // before each test, so the call was dead code.
    vi.spyOn(console, "error").mockImplementation((...args) => errors.push(args));
    // The waiter is INJECTED rather than virtualised: the retried operation does
    // real I/O, so fake timers freeze the work the backoff is waiting on and the
    // loop never advances (verified — both cases hung to the tier timeout).
    await expect(
      startWorkflowWorldIfDeclared(true, "postgres", { waitMs: async () => undefined }),
    ).resolves.toBeUndefined();
    // Swallowing it silently would leave an operator with no way to find out.
    expect(errors.length).toBeGreaterThan(0);
  });

  test("RETRIES a failed start, because its commonest failure is transient", async () => {
    // A blue-green handover runs two guests against one app role's connection
    // limit for a few seconds, so the replacement's start can be refused with
    // `too many connections for role "app_…"`. One attempt made that PERMANENT:
    // the catch logged and the replacement then served its whole life with no
    // queue worker, answering `/client-config` and voice sessions normally while
    // every durable run for the agent was stranded. Measured on a real redeploy
    // mid-run — see `WORLD_START_BACKOFF_MS`.
    pointAtAClosedPort();
    const lines: string[] = [];
    vi.spyOn(console, "error").mockImplementation((first) => {
      if (typeof first === "string") lines.push(first);
    });
    const waits: number[] = [];
    await startWorkflowWorldIfDeclared(true, "postgres", {
      waitMs: async (attempt) => {
        waits.push(attempt);
      },
    });
    // Five waits then a give-up, so six attempts — the budget is BOUNDED: a
    // genuinely broken world stops rather than spinning against a saturated role.
    expect(waits).toEqual([0, 1, 2, 3, 4]);
    expect(lines.filter((l) => l.includes("retrying")).length).toBe(5);
    expect(lines.filter((l) => l.includes("failed to start")).length).toBe(1);
  });

  /**
   * The same exhausted budget, the opposite answer — because a `workflowApp`
   * has no session surface to keep serving.
   *
   * Reproduced on eight workflow guests booted at once against a
   * 100-connection instance: five came up and three gave up, then answered
   * `/health` and `/client-config` with 200 while 500ing every
   * `POST /workflows/runs` for the life of the sandbox — and still 500ing after
   * the instance had drained, because nothing retries once the budget is spent.
   * A throw fails the SPAWN instead, so the slot never latches the broken guest
   * and the next broker call builds a fresh one.
   */
  test("THROWS for a workflow app, which has no phone to answer", async () => {
    pointAtAClosedPort();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      startWorkflowWorldIfDeclared(true, "postgres", {
        page: "static",
        waitMs: async () => undefined,
      }),
    ).rejects.toThrow(/front door is a page/);
  });

  test("a VOICE agent with a page declared still only logs", async () => {
    // The divergence is keyed on `"static"` and nothing else: an explicit
    // `page: "voice"` is the default front door, and taking a whole voice agent
    // down over its workflows is the total-outage-for-a-partial-one trade the
    // original contract refuses.
    pointAtAClosedPort();
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    await expect(
      startWorkflowWorldIfDeclared(true, "postgres", {
        page: "voice",
        waitMs: async () => undefined,
      }),
    ).resolves.toBeUndefined();
  });

  test("does not wait at all when the start succeeds", async () => {
    // The retry must cost a healthy boot nothing: with real timers this resolves
    // immediately, which it could not do if any backoff were awaited. `local`
    // needs no migration and no queue subscription, so it is the shape that
    // succeeds here.
    const waits: number[] = [];
    await startWorkflowWorldIfDeclared(true, "local", {
      waitMs: async (attempt) => {
        waits.push(attempt);
      },
    });
    expect(waits).toEqual([]);
  });
});

describe("an operator-supplied world", () => {
  /**
   * The DevKit loads whatever specifier it is handed, so every spelling of the
   * Postgres world has to be RECOGNIZED as one — otherwise it is loaded and
   * never migrated, and the log calls it `local`. An exact-equality check
   * (what this used to be) passes only the first row.
   */
  test.each([
    ["the bare package name", "@workflow/world-postgres"],
    ["a resolved absolute path", "/app/node_modules/@workflow/world-postgres/dist/index.js"],
    [
      "a pnpm virtual-store path",
      "/r/node_modules/.pnpm/@workflow+world-postgres@4.3.3_x/node_modules/@workflow/world-postgres/dist/index.js",
    ],
    ["a file: URL", "file:///app/node_modules/@workflow/world-postgres/dist/index.js"],
    ["a subpath", "@workflow/world-postgres/dist/index.js"],
  ])("is postgres when it is %s", (_label, target) => {
    const env = { WORKFLOW_TARGET_WORLD: target };
    expect(configureWorkflowWorld({ databaseUrl: undefined, port: 1, env })).toBe("postgres");
  });

  test.each([
    ["the local world", "local"],
    ["a third-party world", "@someone/world-redis"],
  ])("is local when it is %s — nothing here knows how to migrate one", (_label, target) => {
    const env = { WORKFLOW_TARGET_WORLD: target };
    expect(configureWorkflowWorld({ databaseUrl: undefined, port: 1, env })).toBe("local");
  });

  test("is left exactly as the operator set it", () => {
    const target = "/app/node_modules/@workflow/world-postgres/dist/index.js";
    const env = { WORKFLOW_TARGET_WORLD: target };
    configureWorkflowWorld({ databaseUrl: "postgres://x/y", port: 1, env });
    expect(env.WORKFLOW_TARGET_WORLD).toBe(target);
  });
});
