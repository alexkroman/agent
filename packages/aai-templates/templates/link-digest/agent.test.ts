// Copyright 2026 the AAI authors. MIT license.
/**
 * Specs for the link digest — the workflow-app template.
 *
 * There are no tools to exercise, which is the point: what this template
 * demonstrates is a DECLARATION, so the spec asserts the declaration. Three
 * things carry the shape and each is silent when wrong — the `page: "static"`
 * field (without it the deployed agent still offers a `/websocket` nothing will
 * answer), the workflow's NAME (the page starts a run by that string, so a
 * rename here is a runtime 400 there), and the input schema (which is both the
 * call-site validation and the JSON Schema `GET /workflows` serves).
 *
 * The workflow BODY is not tested here: it is only durable once the Workflow
 * DevKit's build has transformed it, so a unit test of it would exercise a plain
 * async function and prove nothing about replay.
 */

import { describe, expect, test } from "vitest";
import agentDef, { digest } from "./agent.ts";

describe("the agent declares itself a workflow app", () => {
  test("its front door is a page, not a microphone", () => {
    // Not decoration: `createServer` declines `/websocket` with a reason for a
    // static agent, and telephony defaults off.
    expect(agentDef.page).toBe("static");
  });

  test("it declares no voice pipeline and no tools, because nothing talks", () => {
    expect(agentDef.stt).toBeUndefined();
    expect(agentDef.llm).toBeUndefined();
    expect(agentDef.tts).toBeUndefined();
    expect(agentDef.s2s).toBeUndefined();
    expect(agentDef.tools).toEqual({});
  });

  test("under the name the page starts a run by", () => {
    // `api.start("digest", …)` in client.tsx names this key. Nothing else
    // records it, so a rename here is a 400 there rather than a compile error.
    expect(Object.keys(agentDef.workflows ?? {})).toEqual(["digest"]);
    expect(agentDef.workflows?.digest).toBe(digest);
  });
});

describe("the input schema", () => {
  test("accepts a URL", async () => {
    const result = await digest.input?.["~standard"].validate({ url: "https://example.com/a" });
    expect(result?.issues).toBeUndefined();
  });

  test("rejects a non-URL at the CALL SITE rather than three steps into a run", async () => {
    const result = await digest.input?.["~standard"].validate({ url: "not a url" });
    expect(result?.issues).toBeDefined();
  });

  test("carries a description, which is what a rendered form labels the field with", () => {
    expect(digest.description).toBeTruthy();
    expect(digest.input).toBeDefined();
  });
});
