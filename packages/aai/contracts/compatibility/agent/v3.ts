// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 3.
 *
 * Epoch 3 added `workflowApp()` and `StaticAgentParams` — a fourth arm of
 * `AgentParams`, keyed on the FRONT DOOR rather than on a session mode. This
 * file covers only what epoch 3 added.
 *
 * It is the OLDEST epoch still supported, and it survives for a reason worth
 * knowing: epoch 8 dropped `agent({ tools })`, which took every other example
 * up to it, and a workflow app never declared a tool in the first place — that
 * arm refuses `tools` outright, as `WorkflowAppOnlyField` still does.
 *
 * **"Frozen" means this file must keep compiling against current source for as
 * long as epoch 3 is advertised as supported.** A compile error here is the
 * finding, not something to edit away. Imports are RELATIVE
 * (`../../../index.ts`) because the package cannot resolve itself by name, and
 * `contracts/` is excluded from the declaration emit and from the tarball.
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
