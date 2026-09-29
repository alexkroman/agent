// Copyright 2026 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import {
  callTwiml,
  escapeXml,
  normalizeCallStatus,
  parseCallTwiml,
  phoneStreamUrl,
  twilioAdvice,
} from "./_twilio-calls.ts";

describe("TwiML", () => {
  test("escapes every special in the URL and the parameters, and reads back what it wrote", () => {
    const parameters = { call: `a"b'c<d>&e`, 'n"<': "v" };
    const twiml = callTwiml("wss://x.test/phone?carrier=twilio&y=1", parameters);
    expect(twiml).not.toMatch(/value="a"b/);
    expect(twiml).toContain(escapeXml(`a"b'c<d>&e`));
    expect(parseCallTwiml(twiml)).toEqual({
      streamUrl: "wss://x.test/phone?carrier=twilio&y=1",
      parameters,
    });
  });

  test("the stream URL keeps the agent's path and takes the websocket scheme", () => {
    expect(phoneStreamUrl("https://host.test/my-agent/")).toBe(
      "wss://host.test/my-agent/phone?carrier=twilio",
    );
    expect(phoneStreamUrl("wss://host.test")).toBe("wss://host.test/phone?carrier=twilio");
    expect(phoneStreamUrl("http://localhost:3000")).toBe(
      "ws://localhost:3000/phone?carrier=twilio",
    );
  });
});

describe("statuses and advice", () => {
  test("Twilio's statuses normalize, initiated reads as queued, anything else is unknown", () => {
    expect(normalizeCallStatus("in-progress")).toBe("in-progress");
    expect(normalizeCallStatus("initiated")).toBe("queued");
    expect(normalizeCallStatus("teleported")).toBeUndefined();
    expect(normalizeCallStatus(7)).toBeUndefined();
  });

  test("an unknown code keeps Twilio's message and names the code or the status", () => {
    expect(twilioAdvice(13_224, "Invalid timeout", 400)).toBe(
      "Twilio couldn't place the call: Invalid timeout (Twilio error 13224)",
    );
    expect(twilioAdvice(undefined, "HTTP 502", 502)).toMatch(/\(Twilio HTTP 502\)$/);
  });
});
