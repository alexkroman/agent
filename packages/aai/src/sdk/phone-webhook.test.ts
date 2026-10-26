// Copyright 2026 the AAI authors. MIT license.

import { Parser } from "htmlparser2";
import { describe, expect, test } from "vitest";
import {
  callParametersFromQuery,
  connectStreamTwiml,
  escapeXml,
  MAX_CALL_PARAMETER_CHARS,
  phoneWebhookUrl,
} from "./phone-webhook.ts";

describe("phoneWebhookUrl", () => {
  test("keeps the agent's path, takes the http scheme, and carries each parameter", () => {
    expect(phoneWebhookUrl("https://host.test/my-agent/", "twilio", { call: "c_1" })).toBe(
      "https://host.test/my-agent/phone?carrier=twilio&param.call=c_1",
    );
    expect(phoneWebhookUrl("wss://host.test", "twilio", {})).toBe(
      "https://host.test/phone?carrier=twilio",
    );
  });

  test("round-trips parameters with every special through the query", () => {
    const parameters = { call: `a"b'c<d>&e= ?`, "n.x": "v&w" };
    const url = new URL(phoneWebhookUrl("https://host.test", "twilio", parameters));
    expect(callParametersFromQuery(url.searchParams)).toEqual(parameters);
  });

  test("refuses a URL with a query or an unsupported scheme, and oversized parameters", () => {
    expect(() => phoneWebhookUrl("https://host.test/?t=1", "twilio", {})).toThrow(/base URL/);
    expect(() => phoneWebhookUrl("ftp://host.test", "twilio", {})).toThrow(/https/);
    expect(() =>
      phoneWebhookUrl("https://host.test", "twilio", { p: "x".repeat(MAX_CALL_PARAMETER_CHARS) }),
    ).toThrow(/under 500/);
  });
});

describe("callParametersFromQuery", () => {
  test("reads only prefixed keys, so carrier and attempt are not parameters", () => {
    const query = new URLSearchParams("carrier=twilio&attempt=2&param.call=c_1");
    expect(callParametersFromQuery(query)).toEqual({ call: "c_1" });
  });

  test("throws on more than 32", () => {
    const query = new URLSearchParams(
      Array.from({ length: 33 }, (_, i) => [`param.p${i}`, "v"] as [string, string]),
    );
    expect(() => callParametersFromQuery(query)).toThrow(/at most 32/);
  });
});

/** The `<Parameter>`s an XML parser reads out of `twiml`, by name. */
function parameterValues(twiml: string): Record<string, string> {
  const values: Record<string, string> = {};
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        if (name === "Parameter") values[attribs.name ?? ""] = attribs.value ?? "";
      },
    },
    { xmlMode: true },
  );
  parser.write(twiml);
  parser.end();
  return values;
}

describe("connectStreamTwiml", () => {
  test("a multi-line value survives as character references, never as raw whitespace", () => {
    // XML attribute-value normalization turns a literal newline, carriage
    // return or tab into a space, so a brief's prompt that reached Twilio
    // raw would come back altered and no longer verify.
    const value = "Line one\nLine two\ttab\rend";
    const twiml = connectStreamTwiml("wss://x.test/phone", { p0: value });
    expect(twiml).not.toMatch(/[\n\r\t]/);
    expect(twiml).toContain('value="Line one&#10;Line two&#9;tab&#13;end"');
    expect(parameterValues(twiml)).toEqual({ p0: value });
  });

  test("escapes every special in the URL and the parameters", () => {
    const twiml = connectStreamTwiml("wss://x.test/phone?carrier=twilio&y=1", {
      call: `a"b'c<d>&e`,
    });
    expect(twiml).not.toMatch(/value="a"b/);
    expect(twiml).toBe(
      `<Connect><Stream url="${escapeXml("wss://x.test/phone?carrier=twilio&y=1")}">` +
        `<Parameter name="call" value="${escapeXml(`a"b'c<d>&e`)}"/></Stream></Connect>`,
    );
  });
});
