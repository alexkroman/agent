// Copyright 2026 the AAI authors. MIT license.
import { createHmac } from "node:crypto";
import { describe, expect, test, vi } from "vitest";
import { PHONE_READY_TIMEOUT_MS } from "./phone-handler.ts";
import type { Sandbox } from "./sandbox.ts";
import { createSlotCache, setSlot } from "./sandbox-slots.ts";
import { createTestOrchestrator, deployAgent, fakeSandbox } from "./test-utils.ts";

type TestFetch = Awaited<ReturnType<typeof createTestOrchestrator>>["fetch"];

/**
 * An orchestrator with `slug` deployed and a live fake sandbox parked in its
 * slot, as the broker specs do.
 *
 * It builds the slot cache and the orchestrator too, because that three-line
 * preamble opened seven tests here and none of them touched `slots` again — the
 * slot is an input to the setup, not to the subject.
 */
async function residentHarness(
  slug = "my-agent",
): Promise<Awaited<ReturnType<typeof createTestOrchestrator>>> {
  const slots = createSlotCache();
  const harness = await createTestOrchestrator({ slots });
  await deployAgent(harness.fetch, slug);
  setSlot(slots, {
    slug,
    sandbox: fakeSandbox(),
    version: (await harness.store.getAgentVersion(slug)) ?? 1,
  });
  return harness;
}

/** POST a carrier webhook the way Twilio does: form-encoded, no JSON. */
async function callWebhook(
  fetch: TestFetch,
  path: string,
  init: { body?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; contentType: string | null; xml: string }> {
  const res = await fetch(path, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", ...init.headers },
    body: init.body ?? "CallSid=CA1&From=%2B15551234567",
  });
  return {
    status: res.status,
    contentType: res.headers.get("Content-Type"),
    xml: await res.text(),
  };
}

describe("POST /:slug/phone", () => {
  test("answers with TwiML pointing at the guest's media-stream endpoint", async () => {
    const harness = await residentHarness();

    const { status, contentType, xml } = await callWebhook(harness.fetch, "/my-agent/phone");

    expect(status).toBe(200);
    expect(contentType).toContain("text/xml");
    expect(xml).toContain('<Stream url="wss://tunnel.test:443/phone?carrier=twilio" />');
    expect(xml).toContain("<Connect>");
  });

  test("passes the requested carrier through to the stream URL", async () => {
    const harness = await residentHarness();

    const { xml } = await callWebhook(harness.fetch, "/my-agent/phone?carrier=telnyx");
    expect(xml).toContain("?carrier=telnyx");
  });

  test("answers a GET too, since the webhook method is the operator's choice", async () => {
    const harness = await residentHarness();

    const res = await harness.fetch("/my-agent/phone");
    expect(res.status).toBe(200);
    expect(await res.text()).toContain("<Stream");
  });

  test("rejects an unsupported carrier with a 400 rather than a spoken error", async () => {
    const harness = await residentHarness();

    const { status } = await callWebhook(harness.fetch, "/my-agent/phone?carrier=vonage");
    expect(status).toBe(400);
  });

  test("hangs up on an unknown slug instead of retrying", async () => {
    // Waiting cannot make an unknown agent exist.
    const harness = await createTestOrchestrator();
    const { status, xml } = await callWebhook(harness.fetch, "/no-such-agent/phone");
    expect(status).toBe(200);
    expect(xml).toContain("<Hangup />");
    expect(xml).toContain("could not be found");
    expect(xml).not.toContain("<Redirect");
  });

  describe("while the sandbox is still booting", () => {
    /**
     * An orchestrator holding a sandbox that never publishes its URLs — the
     * handler's own per-attempt budget is what ends the wait, exactly as in
     * production.
     */
    async function bootingHarness() {
      const slots = createSlotCache();
      const harness = await createTestOrchestrator({ slots });
      await deployAgent(harness.fetch, "my-agent");
      const booting: Sandbox = {
        ...fakeSandbox(),
        sessionUrl: vi.fn(() => new Promise<string>(() => undefined)),
        guestOrigin: vi.fn(() => new Promise<string>(() => undefined)),
      };
      setSlot(slots, {
        slug: "my-agent",
        sandbox: booting,
        version: (await harness.store.getAgentVersion("my-agent")) ?? 1,
      });
      return harness;
    }

    /**
     * Drive one attempt's readiness budget on VIRTUAL time.
     *
     * The budget is 8 seconds and there are five of these specs; waiting it
     * out would put 40 seconds of wall clock in the unit suite and make every
     * one of them a race on a contended runner. Fake timers are installed
     * only around the request itself — the deploy and the slot seeding above
     * run on the real clock.
     */
    async function callWhileBooting(fetch: TestFetch, path: string) {
      vi.useFakeTimers();
      try {
        const pending = callWebhook(fetch, path);
        await vi.advanceTimersByTimeAsync(PHONE_READY_TIMEOUT_MS + 1);
        return await pending;
      } finally {
        vi.useRealTimers();
      }
    }

    test("pauses and redirects back rather than holding the request open", async () => {
      // A carrier times out a webhook in ~15s, under a cold boot's budget —
      // so the retry loop lives in the markup, not in the request.
      const harness = await bootingHarness();
      const { status, xml } = await callWhileBooting(harness.fetch, "/my-agent/phone");

      expect(status).toBe(200);
      expect(xml).toContain("<Pause length=");
      expect(xml).toContain('<Redirect method="POST">');
      expect(xml).toContain("attempt=1");
      expect(xml).toContain("carrier=twilio");
    });

    test("escapes the ampersand in the redirect URL", async () => {
      // Two query parameters in an XML attribute-free text node: a raw `&`
      // is malformed XML and the carrier rejects the whole document.
      const harness = await bootingHarness();
      const { xml } = await callWhileBooting(harness.fetch, "/my-agent/phone");
      expect(xml).toContain("&amp;");
      expect(xml).not.toMatch(/&(?!amp;|lt;|gt;|quot;|apos;)/);
    });

    test("counts up across attempts", async () => {
      const harness = await bootingHarness();
      const { xml } = await callWhileBooting(harness.fetch, "/my-agent/phone?attempt=2");
      expect(xml).toContain("attempt=3");
    });

    test("gives up and hangs up once the attempts are spent", async () => {
      const harness = await bootingHarness();
      const { xml } = await callWhileBooting(harness.fetch, "/my-agent/phone?attempt=5");
      expect(xml).toContain("<Hangup />");
      expect(xml).not.toContain("<Redirect");
    });

    test("treats a malformed attempt count as spent rather than looping", async () => {
      const harness = await bootingHarness();
      const { xml } = await callWhileBooting(harness.fetch, "/my-agent/phone?attempt=abc");
      expect(xml).toContain("<Hangup />");
    });
  });

  describe("signature verification", () => {
    const AUTH_TOKEN = "12345678901234567890123456789012";
    const BODY = "CallSid=CA1&From=%2B15551234567";

    async function signedHarness() {
      const harness = await residentHarness();
      await harness.store.putEnv("my-agent", { TWILIO_AUTH_TOKEN: AUTH_TOKEN });
      return harness;
    }

    /** The signature Twilio would send for this request. */
    function signatureFor(url: string, body: string): string {
      const params = new URLSearchParams(body);
      let payload = url;
      for (const name of [...new Set(params.keys())].sort()) {
        for (const value of params.getAll(name)) payload += name + value;
      }
      return createHmac("sha1", AUTH_TOKEN).update(payload, "utf-8").digest("base64");
    }

    test("accepts a correctly signed webhook", async () => {
      const harness = await signedHarness();
      const { status, xml } = await callWebhook(harness.fetch, "/my-agent/phone", {
        body: BODY,
        headers: {
          "x-twilio-signature": signatureFor("http://localhost/my-agent/phone", BODY),
        },
      });
      expect(status).toBe(200);
      expect(xml).toContain("<Stream");
    });

    test("refuses an unsigned webhook once the token is stored", async () => {
      const harness = await signedHarness();
      const { status } = await callWebhook(harness.fetch, "/my-agent/phone", { body: BODY });
      expect(status).toBe(403);
    });

    test("refuses a webhook whose body was modified in flight", async () => {
      const harness = await signedHarness();
      const { status } = await callWebhook(harness.fetch, "/my-agent/phone", {
        body: "CallSid=CA1&From=%2B15559999999",
        headers: {
          "x-twilio-signature": signatureFor("http://localhost/my-agent/phone", BODY),
        },
      });
      expect(status).toBe(403);
    });

    test("leaves an agent with no stored token open, like /client-config", async () => {
      const harness = await residentHarness();
      const { status } = await callWebhook(harness.fetch, "/my-agent/phone");
      expect(status).toBe(200);
    });

    test("?carrier= cannot steer a signed agent onto the unchecked branch", async () => {
      // The whole attack, at the route: this endpoint carries `slugMw` and no
      // auth middleware, and `?carrier=` is the caller's to write. Against an
      // agent with TWILIO_AUTH_TOKEN stored, naming a carrier whose secret is
      // absent used to skip both branches and answer 200 with TwiML carrying
      // the guest's auth-free `wss://…/phone` URL — a sandbox boot and a media
      // stream, unauthenticated, for anyone who knows the slug.
      const harness = await signedHarness();
      const { status, xml } = await callWebhook(harness.fetch, "/my-agent/phone?carrier=telnyx", {
        body: BODY,
      });
      expect(status).toBe(403);
      expect(xml).not.toContain("<Stream");
      expect(xml).not.toContain("wss://tunnel.test");
    });

    test("a Telnyx-only agent is not bypassed by omitting the parameter", async () => {
      // The mirror image: the route defaults to `twilio`, so leaving the
      // parameter off was the same bypass in the other direction.
      const harness = await residentHarness();
      await harness.store.putEnv("my-agent", { TELNYX_PUBLIC_KEY: "AAAA" });
      const { status, xml } = await callWebhook(harness.fetch, "/my-agent/phone", { body: BODY });
      expect(status).toBe(403);
      expect(xml).not.toContain("<Stream");
    });
  });
});
