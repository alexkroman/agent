// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai:testing` epoch 7.
 *
 * Epoch 7 adds {@link stubGateway} — the fake LLM gateway a spec installs to
 * drive a `"use step"` function that calls a model. It is a pure addition, so
 * epoch 6 is retained; what this file demonstrates is the shape the addition is
 * meant to be written in.
 *
 * The INSTALLATION deliberately stays outside the helper, and this example shows
 * why it is not an omission: `stubGateway` returns a `fetch` rather than
 * replacing the global, so the module carries no test-runner dependency and the
 * spec keeps control of the stub's lifetime.
 *
 * See `../agent/v3.ts` for what "frozen" obliges and why the imports are
 * relative.
 */

import type { StandardSchemaV1 } from "../../../sdk/standard-schema.ts";
import { type StubGateway, type StubGatewayCall, stubGateway } from "../../../sdk/testing.ts";
import { stepGenerateJson } from "../../../sdk/utils.ts";

/** The step under test: it asks a model for a shape. */
export async function planAngles<S extends StandardSchemaV1>(
  topic: string,
  schema: S,
): Promise<unknown> {
  "use step";

  return await stepGenerateJson(topic, { schema, system: "Reply with JSON only." });
}

/**
 * The spec shape: build the fake, install it, then read back what was ASKED.
 *
 * A QUEUE rather than one fixed reply, because a step whose model call sits in a
 * loop needs different answers per turn — the last one repeats, so a spec names
 * only the turns it cares about.
 */
export function exerciseStep(install: (fetchImpl: StubGateway["fetch"]) => void): {
  calls: StubGatewayCall[];
  prompt: string | undefined;
} {
  const gateway: StubGateway = stubGateway(['{"angles":["one"]}', '{"angles":[]}'], {
    status: 200,
    headers: { "Retry-After": "30" },
  });
  install(gateway.fetch);

  // What a spec asserts on: the prompt, the system instruction, the headers the
  // key rode in, and the whole decoded body for anything else.
  const first: StubGatewayCall | undefined = gateway.calls[0];
  const system: string | undefined = first?.system;
  const auth: string | undefined = first?.headers.authorization;
  const model: unknown = first?.body.model;
  void system;
  void auth;
  void model;

  return { calls: gateway.calls, prompt: first?.prompt };
}
