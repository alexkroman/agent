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
  mutates: z.boolean().optional(),
  completes: z.boolean().optional(),
});

/**
 * A tool declaration in wire form: name, description, and JSON Schema
 * parameters — the serializable counterpart of `ToolDef`.
 *
 * `mutates` and `completes` ride along because the tool CLASSIFICATION is what
 * the fast/slow gate routes on, and on the platform arm the runtime holds only
 * these schemas — the `ToolDef` lives in the guest. Without them a deployed
 * agent's gate would classify every tool as a read and verify nothing, which
 * is the shape of bug the `guest-route-exposure` convention exists for: it
 * works under `aai dev` and silently does nothing once deployed.
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
  /**
   * See `ToolDef.mutates`. Absent means "not declared", never "read-only".
   *
   * `| undefined` explicitly, unlike the four members above it: under
   * `exactOptionalPropertyTypes` a bare `mutates?: boolean` is a DIFFERENT
   * type from what `ToolSchemaSchema` infers for an `.optional()` key, and
   * `schema-alignment.test.ts` asserts the two are interchangeable. The four
   * required members never had to say so.
   */
  mutates?: boolean | undefined;
  /** See `ToolDef.completes`. */
  completes?: boolean | undefined;
};
