// Copyright 2026 the AAI authors. MIT license.
/**
 * A tool declaration in WIRE form, and its zod mirror.
 *
 * Split out of `agent-config.ts` along the section divider that file already
 * carried, for the reason `tool-def.ts` and `type-schemas.ts` were split before
 * it: `agent-config.ts` reached the 500-line source cap, and this is the group
 * a reader already treats as one unit — what a `ToolDef` becomes once it has to
 * cross a process boundary. `agent-config.ts` is about the AGENT's config;
 * `ToolSchema` is about one tool, and the only thing the two shared was a file.
 *
 * Nothing moved on the published surface. `_internal-types.ts` and
 * `manifest-barrel.ts` re-export both names from here, so
 * `@alexkroman1/aai/manifest` and every in-repo importer resolve exactly what
 * they resolved before.
 */

import type { JSONSchema7 } from "json-schema";
import { z } from "zod";

import { type ToolMessages, ToolMessagesSchema } from "./tool-messages.ts";

/**
 * Zod schema for {@link ToolSchema}. `parameters` must be a valid JSON Schema
 * object — the Vercel AI SDK wraps it via `jsonSchema()`.
 *
 * @internal
 */
export const ToolSchemaSchema = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  messages: ToolMessagesSchema.optional(),
});

/**
 * A tool declaration in wire form: name, description, and JSON Schema
 * parameters — the serializable counterpart of `ToolDef`.
 */
export type ToolSchema = {
  type: "function";
  name: string;
  description: string;
  parameters: JSONSchema7;
  /**
   * The tool's spoken messages, NORMALIZED — see {@link ToolMessages}.
   *
   * It rides on the wire declaration rather than beside it because that is what
   * makes the feature mean the same thing in every mode: the deployed guest
   * builds this from the agent's own `ToolDef`s, and a host-mode client that
   * supplies its own tool declarations gets the behaviour by declaring the
   * field. Nothing here reaches the model — `toVercelTools` passes `name`,
   * `description` and `parameters` to the provider and reads this itself.
   *
   * Absent for every tool that declares none, which is what keeps an ordinary
   * tool's wire declaration byte-identical to what it was before the field
   * existed.
   */
  messages?: ToolMessages | undefined;
};
