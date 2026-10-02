// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import {
  PUBLIC_URL_UNCONFIGURED_MESSAGE,
  rejectingWorkflows,
  WORKFLOWS_UNAVAILABLE_MESSAGE,
} from "./workflow-unavailable.ts";

describe("rejectingWorkflows", () => {
  const client = rejectingWorkflows("no workflows here");

  test.each<[string, () => Promise<unknown>]>([
    ["start", () => client.start("w")],
    ["get", () => client.get("r")],
    ["find", () => client.find("w", "k")],
    ["findByKey", () => client.findByKey("k")],
    ["recent", () => client.recent("w")],
    ["cancel", () => client.cancel("r")],
    ["cancelAll", () => client.cancelAll("w", "k")],
    ["wakeUp", () => client.wakeUp("r")],
    ["signal", () => client.signal("t")],
    ["stream", () => client.stream("r")],
    ["streamTail", () => client.streamTail("r")],
    ["lastLine", () => client.lastLine("r")],
  ])("%s REJECTS with the message, rather than being undefined", async (_method, call) => {
    await expect(call()).rejects.toThrow("no workflows here");
  });

  test("publicWebhookUrl throws synchronously, as the real one does", () => {
    expect(() => client.publicWebhookUrl("t")).toThrow("no workflows here");
  });

  test("lists nothing", () => {
    expect(client.listing()).toEqual([]);
  });
});

describe("the messages", () => {
  test("name the fix, not just the absence", () => {
    expect(WORKFLOWS_UNAVAILABLE_MESSAGE).toContain("agent({ workflows })");
    expect(PUBLIC_URL_UNCONFIGURED_MESSAGE).toContain("publicUrl");
    expect(PUBLIC_URL_UNCONFIGURED_MESSAGE).toContain("AAI_PUBLIC_ORIGIN");
  });
});
