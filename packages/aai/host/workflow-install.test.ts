// Copyright 2026 the AAI authors. MIT license.
/**
 * `installWorkflowSupport` publishes THREE step slots, and this asserts all
 * three, because each one's absence is silent in a different way.
 *
 * An unpublished upload reader at least names itself
 * (`UPLOADS_UNAVAILABLE_MESSAGE`). An unpublished reporter degrades to the
 * console. An unpublished `stepFetch` degrades to `globalThis.fetch`, which
 * WORKS — over HTTP/2 — so a fan-out that lost that line would collect stream
 * resets against a live provider and nothing else, with no error naming the gap.
 * That is the failure this file exists for; the module had no spec at all.
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { publishStepFetch, stepFetch } from "../sdk/step-fetch.ts";
import { publishStepReporter, report } from "../sdk/step-report.ts";
import {
  publishUploadReader,
  readUpload,
  UPLOADS_UNAVAILABLE_MESSAGE,
} from "../sdk/step-uploads.ts";
import { installWorkflowSupport } from "./workflow-install.ts";

let dir = "";

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "aai-workflow-install-"));
  // Every slot is process-global, so a test has to start from nothing published
  // or it cannot tell "installed it" from "a previous test left it".
  publishUploadReader(undefined);
  publishStepReporter(undefined);
  publishStepFetch(undefined);
});

afterEach(async () => {
  publishUploadReader(undefined);
  publishStepReporter(undefined);
  publishStepFetch(undefined);
  // `vitest.shared.ts` sets `unstubEnvs` but there is no `unstubGlobals`
  // counterpart, so a `vi.stubGlobal("fetch", …)` outlives its test: the two
  // specs below the stubbed ones ran `install()` against a `fetch` answering
  // every request with `Response("global")`.
  vi.unstubAllGlobals();
  await rm(dir, { recursive: true, force: true });
});

/** A logger that records nothing anybody asserts on — see the `report` test for one that does. */
function quietLogger() {
  return { info: vi.fn(), error: vi.fn(), warn: vi.fn(), debug: vi.fn() };
}

function install() {
  return installWorkflowSupport({ dataDir: dir, logger: quietLogger() });
}

describe("installWorkflowSupport", () => {
  test("publishes the upload reader, so a step's readUpload reaches a store", async () => {
    await expect(readUpload("upl_missing")).rejects.toThrow(UPLOADS_UNAVAILABLE_MESSAGE);
    install();
    // A different failure, which is the point: "no such upload" means the store
    // is there and answered.
    await expect(readUpload("upl_missing")).rejects.toThrow("No upload with id upl_missing");
  });

  test("publishes the reporter, so a step's report reaches the logger", async () => {
    const info = vi.fn();
    installWorkflowSupport({ dataDir: dir, logger: { ...quietLogger(), info } });
    await report("halfway");
    expect(info).toHaveBeenCalledWith("Workflow: halfway", expect.anything());
  });

  test("publishes stepFetch, so a step's HTTP does NOT go through the global", async () => {
    const global = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", global);
    install();
    // The published fetch is a real undici dispatcher, so this request is
    // expected to fail — what matters is that the GLOBAL was not what tried it.
    await stepFetch("http://127.0.0.1:1/never").catch(() => undefined);
    expect(global).not.toHaveBeenCalled();
  });

  test("without it, stepFetch silently falls back to the global — the regression to catch", async () => {
    const global = vi.fn(async () => new Response("global"));
    vi.stubGlobal("fetch", global);
    await stepFetch("http://127.0.0.1:1/never").catch(() => undefined);
    // Green here and green above is what makes the assertion above meaningful:
    // the fallback is real, works, and speaks HTTP/2.
    expect(global).toHaveBeenCalledOnce();
  });

  test("returns the store it published, so a server can serve the upload routes", () => {
    const { uploads } = install();
    expect(uploads.create).toBeTypeOf("function");
    expect(uploads.info).toBeTypeOf("function");
    expect(uploads.read).toBeTypeOf("function");
  });

  test("hands back a close, because the pools it opens are the SERVER's to release", async () => {
    // `aai dev` re-runs `createServer` on every save. Before this, each rebuild
    // stranded an upload pool and an undici keep-alive pool — nothing anywhere
    // held a reference to close. Idempotent, since a server may close twice.
    const support = install();
    await expect(support.close()).resolves.toBeUndefined();
    await expect(support.close()).resolves.toBeUndefined();
  });
});
