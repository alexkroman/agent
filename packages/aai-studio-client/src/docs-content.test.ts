// Copyright 2026 the AAI authors. MIT license.
// The API pane's generated content: the route tables, and the example inputs it
// builds from a workflow's own input schema.
//
// This is the half of the pane that can be WRONG in a way no screenshot shows.
// An example input with the field spelled differently than the workflow declared
// it renders perfectly and 400s when somebody pastes it, so the assertions here
// are about the field names and the shapes, not about the prose around them. The
// snippets those inputs go into are `docs-snippets.test.ts`.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  agentBase,
  endpointUrl,
  frontDoorEndpoints,
  PAGE_ENDPOINTS,
  sampleInput,
  startBody,
  UPLOADS_PATH,
  uploadingWorkflow,
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
    expect(input).toEqual({ audio: "<upload id for audio>" });
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
    // `page: "static"` declines `/websocket` and cannot declare a carrier, so
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

describe("the workflow the upload card documents itself with", () => {
  test("is the first one that declares an upload, with its first such property", () => {
    // The routes are the same for every agent; what the card needs from the
    // listing is a real workflow name and a real property to put the id in,
    // because the start-first example invents a `400` otherwise.
    const declared = [
      workflow({ type: "object", properties: { topic: { type: "string" } } }),
      { ...workflow({ type: "object" }, ["audio_file", "cover"]), name: "transcribe" },
    ];
    expect(uploadingWorkflow(declared)).toEqual({
      workflow: declared[1],
      property: "audio_file",
    });
  });

  test("is undefined when no declared workflow takes a file", () => {
    // The gate on the whole card: documenting a file upload to a project with
    // nothing to upload to teaches a call nobody there can make.
    expect(uploadingWorkflow([workflow()])).toBeUndefined();
    expect(uploadingWorkflow([])).toBeUndefined();
    // An EMPTY `uploads` is the same answer as none — `?.[0]` covers both, and
    // a length check that read `uploads !== undefined` would not.
    expect(uploadingWorkflow([workflow(undefined, [])])).toBeUndefined();
  });

  test("the upload routes hang off the workflow prefix, spelled once", () => {
    expect(UPLOADS_PATH).toBe("workflows/uploads");
    // Every upload row in the table is built from it, so a prefix rename cannot
    // leave half the rows behind.
    const uploadRows = WORKFLOW_ENDPOINTS.filter((row) => row.path.includes("uploads"));
    expect(uploadRows).toHaveLength(4);
    for (const row of uploadRows) expect(row.path.startsWith(UPLOADS_PATH)).toBe(true);
  });
});
