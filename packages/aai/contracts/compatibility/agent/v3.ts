// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 3.
 *
 * Epoch 3 added `workflowApp()` and `StaticAgentParams` — a fourth arm of
 * `AgentParams`, keyed on the FRONT DOOR rather than on a session mode.
 * Everything epochs 1 and 2 could express still compiles (see `./v1.ts` and
 * `./v2.ts`, retained for exactly that reason); this file covers only what
 * epoch 3 added, so the three together are the whole contract.
 *
 * See `./v1.ts` for what "frozen" obliges and why the imports are relative.
 *
 * What it does NOT cover, deliberately: the fields this arm REFUSES. A frozen
 * example is a file that must keep compiling, so a rejection belongs where a
 * type error is the passing result — `sdk/define.test-d.ts`, which asserts
 * `not.toExtend<AgentParams>` for each one.
 */

import { z } from "zod";

import { agent, type StaticAgentParams, workflow, workflowApp } from "../../../index.ts";

const digest = workflow({
  description: "Digest a link.",
  input: z.object({ url: z.string() }),
  async run(input) {
    await Promise.resolve();
    return { url: input.url };
  },
});

/** The helper: a workflow app declares its front door by the call it makes. */
export const app = workflowApp({
  name: "Contract Fixture (workflow app)",
  greeting: "Paste a link.",
  workflows: { digest },
  requiredEnv: ["FIXTURE_KEY"],
});

/** The long form stays legal — the helper sets a field, it does not hide one. */
export const appViaAgent = agent({
  name: "Contract Fixture (workflow app, long form)",
  workflows: { digest },
  page: "static",
});

/** A voice agent may still say so explicitly, and may still own workflows. */
export const voiceAgentWithWorkflows = agent({
  name: "Contract Fixture (voice, with workflows)",
  page: "voice",
  workflows: { digest },
});

/** The new union arm is nameable, the way the other three already were. */
export type FixtureStaticParams = StaticAgentParams;

export const isStatic: "voice" | "static" | undefined = app.page;
