// Copyright 2026 the AAI authors. MIT license.
// The API pane's generated content: the example request bodies it builds from
// a workflow's own input schema, and the snippets those bodies go into.
//
// This is the half of the pane that can be WRONG in a way no screenshot shows.
// A snippet with the field spelled differently than the workflow declared it
// renders perfectly and 400s when somebody pastes it, so the assertions here
// are about the field names and the shapes, not about the prose around them.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  agentBase,
  curlPoll,
  curlStart,
  endpointUrl,
  frontDoorEndpoints,
  PAGE_ENDPOINTS,
  sampleInput,
  startBody,
  tsStart,
  VOICE_ENDPOINTS,
  WORKFLOW_ENDPOINTS,
} from "./docs-content.ts";

/**
 * A workflow as `GET /workflows` lists one, with the schema under test.
 *
 * `omitUndefined` rather than a conditional spread: a workflow that declared
 * no input schema must have NO `inputSchema` key, since the whole point of
 * these cases is what the builders do with an absent one.
 */
function workflow(inputSchema?: unknown, uploads?: readonly string[]) {
  return {
    name: "digest",
    description: "Research a topic overnight",
    ...omitUndefined({ inputSchema, uploads }),
  };
}

const BASE = "https://build.test/demo-x7k2mq";

describe("sampleInput", () => {
  test("uses the declared property NAMES as the placeholders", () => {
    // The whole trick: a reader pasting the snippet sees which field they are
    // filling in. A generic "string" reads as a value somebody meant to keep.
    const input = sampleInput(
      workflow({ type: "object", properties: { topic: { type: "string" } } }),
    );
    expect(input).toEqual({ topic: "<topic>" });
  });

  test("answers an enum with a member, because that IS a legal value", () => {
    const input = sampleInput(
      workflow({ type: "object", properties: { tone: { enum: ["brief", "thorough"] } } }),
    );
    expect(input).toEqual({ tone: "brief" });
  });

  test("types that are not strings get values of their own type", () => {
    const input = sampleInput(
      workflow({
        type: "object",
        properties: {
          count: { type: "integer" },
          ratio: { type: "number" },
          verbose: { type: "boolean" },
          tags: { type: "array", items: { type: "string" } },
        },
      }),
    );
    expect(input).toEqual({ count: 0, ratio: 0, verbose: false, tags: ["<tags>"] });
  });

  test("an upload property says where the id comes from", () => {
    // The schema calls it a string; `uploads` is what says the string is a
    // file the caller has to store first — so the placeholder has to name the
    // request that produces it, or the snippet is unfollowable.
    const input = sampleInput(
      workflow({ type: "object", properties: { audio: { type: "string" } } }, ["audio"]),
    );
    expect(input).toEqual({ audio: "<upload id from POST /workflows/uploads>" });
  });

  test("follows nested objects", () => {
    const input = sampleInput(
      workflow({
        type: "object",
        properties: { source: { type: "object", properties: { url: { type: "string" } } } },
      }),
    );
    expect(input).toEqual({ source: { url: "<url>" } });
  });

  test("a workflow with no schema has no example input", () => {
    // A real shape — input is optional — and the snippets then omit the field
    // rather than sending an empty object that reads as required-but-unknown.
    expect(sampleInput(workflow())).toBeUndefined();
    expect(startBody(workflow())).toEqual({ workflow: "digest" });
  });

  test("a schema that is not an object is not guessed at", () => {
    expect(sampleInput(workflow("not a schema"))).toBeUndefined();
  });
});

describe("curlStart", () => {
  const declared = workflow({ type: "object", properties: { topic: { type: "string" } } });

  test("posts the run body to this agent's own runs route", () => {
    const script = curlStart(BASE, declared, false);
    expect(script).toContain(`curl -X POST ${BASE}/workflows/runs`);
    expect(script).toContain(`-d '{"workflow":"digest","input":{"topic":"<topic>"}}'`);
  });

  test("carries a bearer only when the agent's env closes the API", () => {
    // Whether a caller needs `Authorization` is a fact about this project's
    // secrets, not a caveat to leave in prose for the reader to work out.
    expect(curlStart(BASE, declared, false)).not.toContain("Authorization");
    expect(curlStart(BASE, declared, true)).toContain(
      "Authorization: Bearer $AAI_WORKFLOW_API_TOKEN",
    );
    expect(curlPoll(BASE, true)).toContain("Authorization");
    expect(curlPoll(BASE, false)).not.toContain("Authorization");
  });

  test("the poll reads a run back by id, waiting for it to settle", () => {
    expect(curlPoll(BASE, false)).toContain(`${BASE}/workflows/runs/$RUN_ID?wait=30000`);
  });
});

describe("tsStart", () => {
  test("passes the workflow name and the example input to the SDK client", () => {
    const script = tsStart(
      BASE,
      workflow({ type: "object", properties: { topic: { type: "string" } } }),
      false,
    );
    expect(script).toContain(`createWorkflowApiClient({ baseUrl: "${BASE}" })`);
    expect(script).toContain(`api.startAndWait("digest", {"topic":"<topic>"})`);
  });

  test("a schema-less workflow starts with the name alone", () => {
    expect(tsStart(BASE, workflow(), false)).toContain(`api.startAndWait("digest")`);
  });

  test("reads the token from the env rather than inlining one", () => {
    // The snippet is copied into a file and committed; a literal there is a
    // credential in somebody's repository.
    expect(tsStart(BASE, workflow(), true)).toContain("token: process.env.AAI_WORKFLOW_API_TOKEN");
  });
});

describe("the endpoint tables", () => {
  test("every documented path hangs off the agent's base URL", () => {
    const base = agentBase("https://build.test", "demo");
    expect(base).toBe("https://build.test/demo");
    // The page itself is the one row whose path is empty, and it must still
    // resolve to a real URL rather than to the base with no separator.
    expect(endpointUrl(base, { method: "GET", path: "", summary: "" })).toBe(
      "https://build.test/demo/",
    );
    expect(endpointUrl(base, { method: "GET", path: "workflows", summary: "" })).toBe(
      "https://build.test/demo/workflows",
    );
  });

  test("the workflow table covers all four methods the platform proxies", () => {
    // A platform serving a subset of what the guest answers is the bug
    // `GUEST_ROUTE_EXPOSURE` exists to catch — `cancel` is a DELETE and
    // `uploadStream` a PUT, and both worked under `aai dev` while 404ing
    // deployed. Documenting only GET and POST would hide the same gap.
    const methods = new Set(WORKFLOW_ENDPOINTS.map((row) => row.method));
    expect([...methods].sort()).toEqual(["DELETE", "GET", "POST", "PUT"]);
  });

  test("every row says what it is for", () => {
    for (const row of [...PAGE_ENDPOINTS, ...VOICE_ENDPOINTS, ...WORKFLOW_ENDPOINTS]) {
      expect(row.summary.length).toBeGreaterThan(0);
    }
  });

  test("a workflow app's front door is the page and its config, with no phone", () => {
    // `page: "static"` declines `/websocket` and defaults telephony OFF, so
    // the carrier webhook would be a URL that answers a call and hangs up.
    const paths = frontDoorEndpoints("static").map((row) => row.path);
    expect(paths).toEqual(["", "client-config"]);
    expect(paths).not.toContain("phone");
  });

  test("a voice agent's front door adds the carrier webhook", () => {
    // The negative above holds for a builder that returns nothing, so this is
    // what says the phone row is WITHHELD rather than gone.
    expect(frontDoorEndpoints("voice").map((row) => row.path)).toEqual([
      "",
      "client-config",
      "phone",
    ]);
  });
});
