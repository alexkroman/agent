// Copyright 2025 the AAI authors. MIT license.
import { afterEach, describe, expect, test } from "vitest";
import { withPreservedNodeEnv } from "./_vite-env.ts";

/** A promise that resolves only when `release()` is called. */
function gate(): { promise: Promise<void>; release: () => void } {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

/** Fake Vite build: mimics `build()` setting NODE_ENV, resolving on `done`. */
function fakeViteBuild(done: Promise<void>): () => Promise<void> {
  return async () => {
    process.env.NODE_ENV = "production";
    await done;
  };
}

const originalNodeEnv = process.env.NODE_ENV;

afterEach(() => {
  if (originalNodeEnv === undefined) delete process.env.NODE_ENV;
  else process.env.NODE_ENV = originalNodeEnv;
});

describe("withPreservedNodeEnv", () => {
  test("restores an unset NODE_ENV after a single build", async () => {
    delete process.env.NODE_ENV;
    await withPreservedNodeEnv(fakeViteBuild(Promise.resolve()));
    expect(process.env.NODE_ENV).toBeUndefined();
  });

  test("restores a pre-set NODE_ENV after a single build", async () => {
    process.env.NODE_ENV = "development";
    await withPreservedNodeEnv(fakeViteBuild(Promise.resolve()));
    expect(process.env.NODE_ENV).toBe("development");
  });

  test("restores after failed build", async () => {
    delete process.env.NODE_ENV;
    await expect(
      withPreservedNodeEnv(async () => {
        process.env.NODE_ENV = "production";
        throw new Error("build failed");
      }),
    ).rejects.toThrow("build failed");
    expect(process.env.NODE_ENV).toBeUndefined();
  });

  // The regression this guards: two wrapped builds run in parallel
  // (Promise.all in buildAgentBundle / studio deploy). With per-call
  // snapshots the second entrant snapshots the "production" the first
  // build's Vite set, and its restore leaves NODE_ENV=production forever.
  test("two overlapping builds restore an unset NODE_ENV (worker finishes first)", async () => {
    delete process.env.NODE_ENV;
    const worker = gate();
    const client = gate();

    const workerBuild = withPreservedNodeEnv(fakeViteBuild(worker.promise));
    const clientBuild = withPreservedNodeEnv(fakeViteBuild(client.promise));

    worker.release();
    await workerBuild;
    // Still inside the client build: NODE_ENV must stay as Vite set it so the
    // in-flight build keeps a consistent view.
    expect(process.env.NODE_ENV).toBe("production");

    client.release();
    await clientBuild;
    expect(process.env.NODE_ENV).toBeUndefined();
  });

  test("two overlapping builds restore an unset NODE_ENV (client finishes first)", async () => {
    delete process.env.NODE_ENV;
    const worker = gate();
    const client = gate();

    const workerBuild = withPreservedNodeEnv(fakeViteBuild(worker.promise));
    const clientBuild = withPreservedNodeEnv(fakeViteBuild(client.promise));

    client.release();
    await clientBuild;
    worker.release();
    await workerBuild;

    expect(process.env.NODE_ENV).toBeUndefined();
  });

  test("two overlapping builds restore a pre-set NODE_ENV", async () => {
    process.env.NODE_ENV = "development";
    const worker = gate();
    const client = gate();

    const workerBuild = withPreservedNodeEnv(fakeViteBuild(worker.promise));
    const clientBuild = withPreservedNodeEnv(fakeViteBuild(client.promise));

    worker.release();
    await workerBuild;
    client.release();
    await clientBuild;

    expect(process.env.NODE_ENV).toBe("development");
  });

  test("sequential wrapped builds each restore independently", async () => {
    delete process.env.NODE_ENV;
    await withPreservedNodeEnv(fakeViteBuild(Promise.resolve()));
    process.env.NODE_ENV = "test";
    await withPreservedNodeEnv(fakeViteBuild(Promise.resolve()));
    expect(process.env.NODE_ENV).toBe("test");
  });
});
