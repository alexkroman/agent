// Copyright 2026 the AAI authors. MIT license.
/**
 * The guest fills the step slot a workflow BODY mints its callback URL from.
 *
 * Its own file rather than another `describe` in `harness.test.ts`, which is at
 * the 700-line test cap — and the seam is real: every assertion here is about
 * ONE global slot and the exec-env variable that decides whether it is filled,
 * where that file is about tool trials, dispatch and runtime laziness.
 *
 * A published capability that nothing fills is the failure mode these slots
 * have had before (the webhook ROUTE itself mounted on no door for a while, and
 * nothing could see it: a run waiting on a hook that never arrives reports as
 * healthily suspended). So the positive test here is the point of the file.
 */

import { stepWebhookUrl } from "@alexkroman1/aai/step";
import {
  publishWorkflowWebhookUrl,
  WORKFLOW_CALLBACK_ROUTES,
} from "@alexkroman1/aai-runtime/internal";
import { afterEach, describe, expect, test, vi } from "vitest";
import { emptyHarnessState, loadBundle } from "./harness-bundle.ts";

// The minimal loadable bundle: the harness refuses one that ships no runtime
// factory, and none of these tests needs a real runtime.
const CODE = `
  export const __aaiCreateRuntime = () => ({
    startSession() {},
    shutdown: async () => {},
  });
  export default { name: 'x', systemPrompt: 'p', greeting: 'g', tools: {} };`;

// The slot is GLOBAL, so a filled one would leak into the next file. Through the
// publisher rather than by hand-copying the SDK's `Symbol.for` key, for the
// reason `step-env.test.ts` gives: a rename of that constant would turn a
// hand-written teardown into a silent no-op.
afterEach(() => publishWorkflowWebhookUrl(undefined));

describe("loadBundle publishes the webhook minter", () => {
  test("a step can mint this run's public callback URL", async () => {
    // The gap this closes: a body and the steps it calls hold no `ToolContext`,
    // so `ctx.workflows.publicWebhookUrl` is out of reach — and three shipped
    // templates are `workflowApp()`s with no tools at all, so nothing in them
    // could mint one and they had to poll.
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "https://sandbox-9.example.com/");
    await loadBundle(emptyHarnessState(), { code: CODE, env: {} });
    // Derived from the route TABLE, never a literal: the URL handed out and the
    // path that answers it must come from one spelling, and the token is one
    // segment so it is encoded.
    expect(stepWebhookUrl("approval:9")).toBe(
      `https://sandbox-9.example.com${WORKFLOW_CALLBACK_ROUTES.webhook.path}/approval%3A9`,
    );
  });

  test("published BEFORE the surface is built, so a boot-time delivery cannot race it", async () => {
    // `ensureRuntime` is too late: it is lazy, and for a `page: "static"` app
    // the first thing that needs it may be a run the platform's queue delivers
    // the moment this process boots. So the load publishes, and no runtime has
    // been built at that point.
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "https://sandbox-9.example.com");
    const state = emptyHarnessState();
    await loadBundle(state, { code: CODE, env: {} });
    expect(state.runtime).toBeNull();
    expect(stepWebhookUrl("t")).toContain("https://sandbox-9.example.com");
  });

  test("no public URL in the exec env leaves the minter UNPUBLISHED", async () => {
    // A guest that cannot mint one must not publish a minter over an empty
    // base: that composes `/.well-known/…`, a relative URL nothing can call
    // back on. Unpublished, the step helper's own throw names the
    // configuration.
    vi.stubEnv("AAI_PUBLIC_BASE_URL", undefined);
    await loadBundle(emptyHarnessState(), { code: CODE, env: {} });
    expect(() => stepWebhookUrl("t")).toThrow(/cannot mint a public webhook URL/);
  });

  test("a blank exec-env value is treated as absent, not as an origin", async () => {
    // An exec env built from a template can carry an empty string.
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "   ");
    await loadBundle(emptyHarnessState(), { code: CODE, env: {} });
    expect(() => stepWebhookUrl("t")).toThrow(/cannot mint a public webhook URL/);
  });

  test("the AGENT env cannot supply the callback origin", async () => {
    // The parity rule `stepEnv` states, from the other side: the public origin
    // is a boot parameter of the DEPLOYMENT, set by the spawner, so a tenant's
    // own `.env` key of that name must never become the origin a third party is
    // handed. It is also why `requireStepEnv("AAI_PUBLIC_BASE_URL")` cannot
    // stand in for this slot in production.
    vi.stubEnv("AAI_PUBLIC_BASE_URL", undefined);
    await loadBundle(emptyHarnessState(), {
      code: CODE,
      env: { AAI_PUBLIC_BASE_URL: "https://attacker.example.com" },
    });
    expect(() => stepWebhookUrl("t")).toThrow(/cannot mint a public webhook URL/);
  });

  test("a repeat load REPLACES the minter, which is what a redeploy means", async () => {
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "https://old.example.com");
    await loadBundle(emptyHarnessState(), { code: CODE, env: {} });
    vi.stubEnv("AAI_PUBLIC_BASE_URL", "https://new.example.com");
    await loadBundle(emptyHarnessState(), { code: CODE, env: {} });
    expect(stepWebhookUrl("t")).toContain("https://new.example.com");
  });
});
