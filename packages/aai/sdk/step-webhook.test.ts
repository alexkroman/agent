// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the step webhook URL.
 *
 * The property that cannot be asserted here is the one the module doc argues
 * for — that a step reading the slot and the host publishing it are two module
 * instances of this file in one realm — for the reason `step-env.test.ts`
 * states: two instances need two bundles and a real transform. What IS
 * assertable is every rule the slot carries, and the one that matters most is
 * the UNFILLED case: a helper that answered `undefined` there would mint a
 * submission with no callback, which polls forever with nobody having said so.
 */

import { afterEach, describe, expect, test } from "vitest";
import {
  publishStepWebhookUrl,
  STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE,
  stepWebhookUrl,
} from "./step-webhook.ts";

// Back to "nothing has published", through the module's own unpublish rather
// than by hand-copying its private `Symbol.for` key — the reason
// `step-env.test.ts` gives: a rename of the constant would turn a hand-written
// teardown into a silent no-op and the unfilled test into one that passes on
// the previous test's leftovers.
afterEach(() => publishStepWebhookUrl(undefined));

describe("stepWebhookUrl", () => {
  test("mints through the published minter, which owns the route", () => {
    publishStepWebhookUrl(
      (token) => `https://agent.example.com/.well-known/workflow/v1/webhook/${token}`,
    );
    expect(stepWebhookUrl("approval:order-9")).toBe(
      "https://agent.example.com/.well-known/workflow/v1/webhook/approval:order-9",
    );
  });

  test("THROWS when nothing has published, naming what to do", () => {
    // Not `undefined`: a step that reads one would hand a third party nothing,
    // submit the job anyway, and park — and a run waiting on a hook nobody was
    // told about is indistinguishable from a payer who never paid.
    expect(() => stepWebhookUrl("t")).toThrow(STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE);
    expect(() => stepWebhookUrl("t")).toThrow(/aai dev/);
  });

  test("publishing `undefined` unpublishes", () => {
    publishStepWebhookUrl((token) => `https://x/${token}`);
    expect(stepWebhookUrl("t")).toBe("https://x/t");
    publishStepWebhookUrl(undefined);
    expect(() => stepWebhookUrl("t")).toThrow(STEP_WEBHOOK_URL_UNAVAILABLE_MESSAGE);
  });

  test("publishing REPLACES, which is what a redeploy means", () => {
    publishStepWebhookUrl((token) => `https://old/${token}`);
    publishStepWebhookUrl((token) => `https://new/${token}`);
    expect(stepWebhookUrl("t")).toBe("https://new/t");
  });

  test("an empty token is refused before the minter sees it", () => {
    // The token names the waitpoint. An empty one composes to the route's own
    // prefix, which `webhookToken` refuses — so the failure would arrive at the
    // far end, days later, as a 404 on a URL nobody can re-issue.
    publishStepWebhookUrl((token) => `https://x/${token}`);
    expect(() => stepWebhookUrl("")).toThrow(/token cannot be empty/);
  });

  test("the minter's own failure is not swallowed", () => {
    // A host that published a minter over an unusable base still owes the step
    // an error rather than a URL: `report`'s swallow-everything rule is for
    // NARRATION, and this value is acted on.
    publishStepWebhookUrl(() => {
      throw new Error("no public URL");
    });
    expect(() => stepWebhookUrl("t")).toThrow("no public URL");
  });
});
