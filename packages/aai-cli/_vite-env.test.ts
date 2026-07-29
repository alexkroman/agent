// Copyright 2025 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { withPreservedNodeEnv } from "./_vite-env.ts";

/**
 * These tests operate on a FAKE env object, never process.env: mutating and
 * deleting the real NODE_ENV mid-suite is shared-global churn that other
 * tests (and vitest itself) can observe, and the save/restore afterEach
 * dance it required was easy to get subtly wrong.
 */
type FakeEnv = { NODE_ENV?: string };

/** A promise that resolves only when `release()` is called. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Fake Vite build: mimics `build()` setting NODE_ENV, resolving on `done`. */
function fakeViteBuild(env: FakeEnv, done: Promise<void>): () => Promise<void> {
  return async () => {
    env.NODE_ENV = "production";
    await done;
  };
}

describe("withPreservedNodeEnv", () => {
  test("restores an unset NODE_ENV after a single build", async () => {
    const env: FakeEnv = {};
    await withPreservedNodeEnv(fakeViteBuild(env, Promise.resolve()), env);
    expect(env.NODE_ENV).toBeUndefined();
  });

  test("restores a pre-set NODE_ENV after a single build", async () => {
    const env: FakeEnv = { NODE_ENV: "development" };
    await withPreservedNodeEnv(fakeViteBuild(env, Promise.resolve()), env);
    expect(env.NODE_ENV).toBe("development");
  });

  test("restores after failed build", async () => {
    const env: FakeEnv = {};
    await expect(
      withPreservedNodeEnv(async () => {
        env.NODE_ENV = "production";
        throw new Error("build failed");
      }, env),
    ).rejects.toThrow("build failed");
    expect(env.NODE_ENV).toBeUndefined();
  });

  // The regression this guards: two wrapped builds run in parallel
  // (Promise.all in buildAgentBundle / studio deploy). With per-call
  // snapshots the second entrant snapshots the "production" the first
  // build's Vite set, and its restore leaves NODE_ENV=production forever.
  test("two overlapping builds restore an unset NODE_ENV (worker finishes first)", async () => {
    const env: FakeEnv = {};
    const worker = gate();
    const client = gate();

    const workerBuild = withPreservedNodeEnv(fakeViteBuild(env, worker.promise), env);
    const clientBuild = withPreservedNodeEnv(fakeViteBuild(env, client.promise), env);

    worker.release();
    await workerBuild;
    // Still inside the client build: NODE_ENV must stay as Vite set it so the
    // in-flight build keeps a consistent view.
    expect(env.NODE_ENV).toBe("production");

    client.release();
    await clientBuild;
    expect(env.NODE_ENV).toBeUndefined();
  });

  test("two overlapping builds restore an unset NODE_ENV (client finishes first)", async () => {
    const env: FakeEnv = {};
    const worker = gate();
    const client = gate();

    const workerBuild = withPreservedNodeEnv(fakeViteBuild(env, worker.promise), env);
    const clientBuild = withPreservedNodeEnv(fakeViteBuild(env, client.promise), env);

    client.release();
    await clientBuild;
    worker.release();
    await workerBuild;

    expect(env.NODE_ENV).toBeUndefined();
  });

  test("two overlapping builds restore a pre-set NODE_ENV", async () => {
    const env: FakeEnv = { NODE_ENV: "development" };
    const worker = gate();
    const client = gate();

    const workerBuild = withPreservedNodeEnv(fakeViteBuild(env, worker.promise), env);
    const clientBuild = withPreservedNodeEnv(fakeViteBuild(env, client.promise), env);

    worker.release();
    await workerBuild;
    client.release();
    await clientBuild;

    expect(env.NODE_ENV).toBe("development");
  });

  test("sequential wrapped builds each restore independently", async () => {
    const env: FakeEnv = {};
    await withPreservedNodeEnv(fakeViteBuild(env, Promise.resolve()), env);
    env.NODE_ENV = "staging";
    await withPreservedNodeEnv(fakeViteBuild(env, Promise.resolve()), env);
    expect(env.NODE_ENV).toBe("staging");
  });
});
