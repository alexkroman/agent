// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `agent` epoch 9.
 *
 * Epoch 9 took `tools` OFF the parameter shape. A tool is declared by its FILE —
 * `tools/greet.ts` that default-exports `tool({ … })` IS the tool `greet`,
 * enumerated where the bundle is assembled and named by nothing — so an
 * `agent.ts` at this epoch mentions tools not at all, and `agent({ tools })` is
 * the {@link InlineToolsMisuse} message naming the file to create.
 *
 * Epochs 1, 2 and 4 through 8 are DROPPED for that reason and their examples are
 * gone; epoch 3 (`workflowApp()`, in `./v3.ts`) never declared a tool and still
 * compiles beside this one.
 *
 * **What a single file can and cannot evidence.** The declaration half is here in
 * full: an agent with no tools, and the module-level shape a `tools/` file
 * default-exports. What is deliberately absent is the ATTACHMENT — `withTools`
 * lives on `@alexkroman1/aai/manifest`, which is not part of the contracted
 * authoring surface, because a build performs it and an author never writes it.
 * A spec's half of the same thing is `withDiscoveredTools`, and it belongs to the
 * `testing` capability.
 *
 * See `./v3.ts` for what "frozen" obliges and why the imports are relative.
 */

import { z } from "zod";

import { agent, type ToolDef, tool } from "../../../index.ts";

/**
 * What `tools/greet.ts` holds at this epoch: a default export and no name.
 *
 * Written as a named `const` because a frozen example is one module and a file
 * per tool cannot be; the SHAPE is what the contract is about, and this is it.
 */
export const greet: ToolDef<z.ZodObject<{ who: z.ZodString }>> = tool({
  description: "Greet someone by name.",
  inputSchema: z.object({ who: z.string() }),
  execute: ({ who }) => `Hello, ${who}.`,
});

/**
 * The agent: every field epochs 1-8 declared, minus the one that went away.
 *
 * `state` is what carries a shape into a tool's own module (`sessionSlot` is the
 * `state` capability's business), and it is still the only thing `S` is inferred
 * from — which is why moving tools out of this shape cost no inference.
 */
export const desk = agent({
  name: "Contract Fixture (voice)",
  greeting: "Contract fixture speaking.",
  systemPrompt: "Answer in one sentence.",
  maxSteps: 4,
  toolChoice: "auto",
  builtinTools: ["calculate"],
  voice: "jane",
  requiredEnv: ["FIXTURE_KEY"],
  state: () => ({ turns: 0 }),
  syncState: (state) => ({ turns: state?.turns ?? 0 }),
});

/** The table a declaration starts with, now that nothing authors it. */
export const startsEmpty: boolean = Object.keys(desk.tools).length === 0;
