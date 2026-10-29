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
import type { ToolEffect, ToolUi } from "./tool-def.ts";
import { type ToolMessages, ToolMessagesSchema } from "./tool-messages.ts";

/**
 * Zod mirror of `ToolUi` (`tool-def.ts`). `.strict()`, like the MCP server config: a
 * misspelled `lable` would otherwise ship as nothing and render as the raw
 * tool name, with no line saying why.
 *
 * @internal
 */
export const ToolUiSchema: z.ZodType<ToolUi> = z
  .object({ icon: z.string().optional(), label: z.string().optional() })
  .strict();

// The annotation is the type zod infers, written out — a published declaration
// with an explicit type keeps the API hash off the compiler
// (`check:api-shape`'s isolatedDeclarations ratchet), and `messages` has to be
// the full `ZodObject` rather than a `ZodType<ToolMessages>`, because a reader
// of `HostConfigSchema` (`/protocol`) is promised `.shape` on it.
/**
 * Zod schema for {@link ToolSchema}. `parameters` must be a valid JSON Schema
 * object — the Vercel AI SDK wraps it via `jsonSchema()`.
 *
 * @internal
 */
export const ToolSchemaSchema: z.ZodObject<
  {
    type: z.ZodLiteral<"function">;
    name: z.ZodString;
    description: z.ZodString;
    parameters: z.ZodRecord<z.ZodString, z.ZodUnknown>;
    messages: z.ZodOptional<
      z.ZodObject<
        {
          start: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  content: z.ZodString;
                  when: z.ZodOptional<
                    z.ZodArray<
                      z.ZodObject<
                        {
                          arg: z.ZodString;
                          op: z.ZodOptional<
                            z.ZodEnum<{
                              eq: "eq";
                              gt: "gt";
                              gte: "gte";
                              lt: "lt";
                              lte: "lte";
                              neq: "neq";
                            }>
                          >;
                          value: z.ZodUnion<
                            readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                          >;
                        },
                        z.core.$strip
                      >
                    >
                  >;
                  blocking: z.ZodOptional<z.ZodBoolean>;
                },
                z.core.$strip
              >
            >
          >;
          delayed: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  content: z.ZodString;
                  when: z.ZodOptional<
                    z.ZodArray<
                      z.ZodObject<
                        {
                          arg: z.ZodString;
                          op: z.ZodOptional<
                            z.ZodEnum<{
                              eq: "eq";
                              gt: "gt";
                              gte: "gte";
                              lt: "lt";
                              lte: "lte";
                              neq: "neq";
                            }>
                          >;
                          value: z.ZodUnion<
                            readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                          >;
                        },
                        z.core.$strip
                      >
                    >
                  >;
                  afterMs: z.ZodNumber;
                },
                z.core.$strip
              >
            >
          >;
          complete: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  content: z.ZodString;
                  when: z.ZodOptional<
                    z.ZodArray<
                      z.ZodObject<
                        {
                          arg: z.ZodString;
                          op: z.ZodOptional<
                            z.ZodEnum<{
                              eq: "eq";
                              gt: "gt";
                              gte: "gte";
                              lt: "lt";
                              lte: "lte";
                              neq: "neq";
                            }>
                          >;
                          value: z.ZodUnion<
                            readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                          >;
                        },
                        z.core.$strip
                      >
                    >
                  >;
                  role: z.ZodOptional<
                    z.ZodEnum<{
                      assistant: "assistant";
                      system: "system";
                    }>
                  >;
                },
                z.core.$strip
              >
            >
          >;
          failed: z.ZodOptional<
            z.ZodArray<
              z.ZodObject<
                {
                  content: z.ZodString;
                  when: z.ZodOptional<
                    z.ZodArray<
                      z.ZodObject<
                        {
                          arg: z.ZodString;
                          op: z.ZodOptional<
                            z.ZodEnum<{
                              eq: "eq";
                              gt: "gt";
                              gte: "gte";
                              lt: "lt";
                              lte: "lte";
                              neq: "neq";
                            }>
                          >;
                          value: z.ZodUnion<
                            readonly [z.ZodString, z.ZodNumber, z.ZodBoolean, z.ZodNull]
                          >;
                        },
                        z.core.$strip
                      >
                    >
                  >;
                  role: z.ZodOptional<
                    z.ZodEnum<{
                      assistant: "assistant";
                      system: "system";
                    }>
                  >;
                },
                z.core.$strip
              >
            >
          >;
        },
        z.core.$strip
      >
    >;
    ui: z.ZodOptional<z.ZodType<ToolUi>>;
    effect: z.ZodOptional<z.ZodEnum<{ read: "read"; write: "write"; handoff: "handoff" }>>;
  },
  z.core.$strip
> = z.object({
  type: z.literal("function"),
  name: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.string(), z.unknown()),
  messages: ToolMessagesSchema.optional(),
  ui: ToolUiSchema.optional(),
  effect: z.enum(["read", "write", "handoff"]).optional(),
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
  /**
   * How a page displays the tool — see `ToolUi` (`tool-def.ts`). Rides here
   * for the reason `messages` does: the deployed guest builds the declaration
   * from the agent's own `ToolDef`s, and the pre-connection client config
   * carries the same hints (`toolUiMap`, `tool-ui.ts`), so the default client
   * renders the same thing everywhere. Absent for a tool that declares none.
   */
  ui?: ToolUi | undefined;
  /**
   * What the tool does to the world — see `ToolDef.effect`. A host-mode client
   * declaring its own tools sets it the same way; an MCP tool's comes from its
   * server's `readOnlyHint`. Never sent to the model.
   */
  effect?: ToolEffect | undefined;
};
