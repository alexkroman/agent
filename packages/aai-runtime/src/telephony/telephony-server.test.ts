// Copyright 2026 the AAI authors. MIT license.
/**
 * `enabledCarriers` — the one place a `telephony` declaration becomes a set of
 * routes.
 *
 * It is worth a spec of its own because two readers depend on it agreeing with
 * itself: the upgrade handler admits what it returns, and `createAgentServer`'s
 * boot line ADVERTISES what it returns. A disagreement between those two is a
 * log that lies about the surface, which is the failure the resolution was
 * folded into one function to prevent.
 */

import type http from "node:http";
import type { TelephonyAccess } from "@alexkroman1/aai";
import { describe, expect, test } from "vitest";
import { silentLogger } from "../logger.ts";
import { enabledCarriers, handleTelephonyWebhook } from "./telephony-server.ts";

describe("enabledCarriers", () => {
  test("an absent declaration serves nothing", () => {
    // The default, and the point of the whole allow-list: an agent that says
    // nothing about phone calls answers none.
    expect(enabledCarriers(undefined)).toEqual([]);
  });

  test.each([
    ["false", false as const],
    ["an empty list", [] as const],
  ])("%s is the same refusal", (_label, access) => {
    expect(enabledCarriers(access)).toEqual([]);
  });

  test("true is every carrier this build ships a codec for", () => {
    expect(enabledCarriers(true)).toEqual(["twilio", "telnyx"]);
  });

  test("a list is honoured, and normalized to the shipped order", () => {
    // Order is normalized rather than preserved, because the boot line reads
    // this: two agents declaring the same carriers should print the same line.
    expect(enabledCarriers(["telnyx", "twilio"])).toEqual(["twilio", "telnyx"]);
    expect(enabledCarriers(["telnyx"])).toEqual(["telnyx"]);
  });

  test("a name this build has no codec for is dropped, not fatal", () => {
    // The type refuses one in an `agent.ts`; what reaches here is a stored
    // config a newer SDK may have written. Dropping it keeps the carriers this
    // build understands — refusing the lot would take a working Twilio number
    // down over an entry this build cannot serve anyway.
    // Spelled as a PARSE rather than a cast, because that is the route such a
    // value really takes: a stored agent config is JSON, and the names in it
    // were validated by whichever SDK wrote them.
    const stored: TelephonyAccess = JSON.parse('["twilio", "vonage"]');
    expect(enabledCarriers(stored)).toEqual(["twilio"]);
  });
});

/** Answer one webhook request; the response is captured, nothing is bound. */
function webhook(
  url: string,
  headers: http.IncomingHttpHeaders = { host: "agent.example.test" },
  carriers: readonly string[] = ["twilio"],
): { status: number; body: string } {
  const out = { status: 0, body: "" };
  const res = {
    writeHead(status: number) {
      out.status = status;
    },
    end(body: string) {
      out.body = body;
    },
  };
  handleTelephonyWebhook({
    req: { url, headers },
    res,
    logger: silentLogger,
    carriers,
  });
  return out;
}

describe("handleTelephonyWebhook", () => {
  test("answers TwiML streaming to this server's own WS /phone, with each param.*", () => {
    // What `stepPlaceCall` dials through on a self-hosted server or `aai dev`.
    const { status, body } = webhook("/phone?carrier=twilio&param.call=c_1", {
      host: "abc.trycloudflare.com",
      "x-forwarded-proto": "https",
    });
    expect(status).toBe(200);
    expect(body).toContain(
      '<Stream url="wss://abc.trycloudflare.com/phone?carrier=twilio">' +
        '<Parameter name="call" value="c_1"/></Stream>',
    );
  });

  test("streams over plain ws when the request was not https", () => {
    expect(webhook("/phone?carrier=twilio").body).toContain(
      'url="ws://agent.example.test/phone?carrier=twilio"',
    );
  });

  test("refuses with a status when the agent declares no carriers, or not this one", () => {
    expect(webhook("/phone?carrier=twilio", undefined, []).status).toBe(404);
    expect(webhook("/phone?carrier=telnyx").status).toBe(404);
    expect(webhook("/phone?carrier=pigeon").status).toBe(400);
  });

  test("refuses parameters past Twilio's limits", () => {
    expect(webhook(`/phone?carrier=twilio&param.p=${"x".repeat(600)}`).status).toBe(400);
  });
});
