// Copyright 2026 the AAI authors. MIT license.
// The API pane's snippets: the SDK calls every section leads with, and the
// `curl` and CLI equivalents behind them.
//
// This is the half of the pane that can be WRONG in a way no screenshot shows.
// A snippet with a field spelled differently than the workflow declared it, or a
// bearer line for an open API, renders perfectly and fails when somebody pastes
// it — so the assertions are about the calls and the field names rather than the
// prose around them.

import { omitUndefined } from "@alexkroman1/aai/utils";
import { describe, expect, test } from "vitest";
import {
  cliCommands,
  curlConfig,
  curlFollow,
  curlPoll,
  curlStart,
  SDK_INSTALL,
  sdkClient,
  sdkConfig,
  sdkFollow,
  sdkFollowOutput,
  sdkRead,
  sdkStart,
} from "./docs-snippets.ts";

/** A workflow as `GET /workflows` lists one, with the schema under test. */
function workflow(inputSchema?: unknown, uploads?: readonly string[]) {
  return {
    name: "digest",
    description: "Research a topic overnight",
    // `omitUndefined` rather than a conditional spread: a workflow that declared
    // no input schema must have NO `inputSchema` key, since what the builders do
    // with an absent one is the case under test.
    ...omitUndefined({ inputSchema, uploads }),
  };
}

const BASE = "https://build.test/demo-x7k2mq";
const TOPIC = workflow({ type: "object", properties: { topic: { type: "string" } } });

describe("the SDK client every snippet opens with", () => {
  test("is ONE client for the whole agent, built from this agent's base URL", () => {
    // `createAgentClient`, not `createWorkflowApiClient`: the pane documents the
    // front door as well as the workflow routes, and a reader should not have to
    // know to build two clients to follow one page.
    const code = sdkClient(BASE, false);
    expect(code).toContain(`import { createAgentClient } from "@alexkroman1/aai/workflow-api";`);
    expect(code).toContain(`createAgentClient({ baseUrl: "${BASE}" })`);
    expect(SDK_INSTALL).toBe("npm i @alexkroman1/aai");
  });

  test("reads the token from the env rather than inlining one", () => {
    // The snippet is copied into a file and committed; a literal there is a
    // credential in somebody's repository.
    expect(sdkClient(BASE, true)).toContain("token: process.env.AAI_WORKFLOW_API_TOKEN");
    expect(sdkClient(BASE, false)).not.toContain("token");
  });
});

describe("sdkStart", () => {
  test("passes the workflow name and the example input to the client", () => {
    expect(sdkStart(BASE, TOPIC, false)).toContain(
      `agent.startAndWait("digest", {"topic":"<topic>"})`,
    );
  });

  test("a schema-less workflow starts with the name alone", () => {
    expect(sdkStart(BASE, workflow(), false)).toContain(`agent.startAndWait("digest")`);
  });

  test("an upload property becomes a CALL, not a placeholder string", () => {
    // The whole difference from the `curl` body: JSON can only say "get an id
    // from this route", where the SDK snippet shows the call that produces one
    // and references its result — which is also what says the bytes go in once
    // and the run carries the handle.
    const code = sdkStart(
      BASE,
      workflow({ type: "object", properties: { audio_file: { type: "string" } } }, ["audio_file"]),
      false,
    );
    expect(code).toContain(
      `const audioFileUpload = await agent.upload(file, { name: "audio_file" })`,
    );
    expect(code).toContain(`agent.startAndWait("digest", {"audio_file":audioFileUpload.id})`);
    // The sentinel that made the substitution possible must never survive it.
    expect(code).not.toContain("@@upload");
  });
});

describe("reading a run back, and following one", () => {
  test("the read branches on undefined, which is an ANSWER rather than a failure", () => {
    const code = sdkRead(BASE, false);
    expect(code).toContain(`agent.get("<run id>", { wait: 30_000 })`);
    expect(code).toContain("no such run");
  });

  test("following a run is an ordinary `for await`", () => {
    expect(sdkFollow(BASE, false)).toContain(`for await (const run of agent.follow("<run id>"))`);
    expect(sdkFollowOutput(BASE, false)).toContain(
      `for await (const chunk of agent.followOutput("<run id>"))`,
    );
  });

  test("the config read destructures what a caller actually branches on", () => {
    expect(sdkConfig(BASE, false)).toContain("await agent.config()");
    expect(sdkConfig(BASE, false)).toContain("page");
  });
});

describe("the shell and CLI alternates", () => {
  test("curl posts the run body to this agent's own runs route", () => {
    const script = curlStart(BASE, TOPIC, false);
    expect(script).toContain(`curl -X POST ${BASE}/workflows/runs`);
    expect(script).toContain(`-d '{"workflow":"digest","input":{"topic":"<topic>"}}'`);
  });

  test("a bearer appears only when the agent's env closes the API", () => {
    // Whether a caller needs `Authorization` is a fact about this project's
    // secrets, not a caveat to leave in prose for the reader to work out.
    expect(curlStart(BASE, TOPIC, false)).not.toContain("Authorization");
    expect(curlStart(BASE, TOPIC, true)).toContain("Authorization: Bearer $AAI_WORKFLOW_API_TOKEN");
    expect(curlPoll(BASE, true)).toContain("Authorization");
    expect(curlPoll(BASE, false)).not.toContain("Authorization");
    expect(curlFollow(BASE, true)).toContain("Authorization");
    expect(curlFollow(BASE, false)).not.toContain("Authorization");
  });

  test("the reads name the route they read", () => {
    expect(curlPoll(BASE, false)).toContain(`${BASE}/workflows/runs/$RUN_ID?wait=30000`);
    // `-N` is what stops curl buffering an event stream into invisibility.
    expect(curlFollow(BASE, false)).toContain(`-N "${BASE}/workflows/runs/$RUN_ID/events"`);
    expect(curlConfig(BASE)).toBe(`curl ${BASE}/client-config`);
  });

  test("the CLI commands are the ones `aai workflow` really has", () => {
    // `aai workflow` is list/runs/show/cancel — there is no `start`, so a
    // snippet offering one would be a command that does not exist.
    expect(cliCommands(workflow())).toEqual([
      "aai workflow list",
      "aai workflow runs digest",
      "aai workflow show $RUN_ID",
    ]);
  });
});
