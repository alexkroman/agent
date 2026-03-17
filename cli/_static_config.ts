// Copyright 2025 the AAI authors. MIT license.
/**
 * Static AST-based config extraction from agent.ts.
 *
 * Parses TypeScript source with ts-morph to extract config values and tool
 * schemas from the `defineAgent({...})` call without evaluating user code.
 *
 * @module
 */

import fs from "node:fs/promises";
import type { JSONSchema7 } from "@types/json-schema";
import type { AgentConfig, ToolSchema } from "aai/internal-types";
import { DEFAULT_GREETING, DEFAULT_INSTRUCTIONS } from "aai/types";
import {
  type CallExpression,
  type Expression,
  type ObjectLiteralExpression,
  Project,
  type PropertyAssignment,
  type SourceFile,
  type SpreadAssignment,
  SyntaxKind,
} from "ts-morph";
import { BundleError } from "./_bundler.ts";

/** Result of static config extraction. */
export type ExtractResult = {
  config: AgentConfig;
  toolSchemas: ToolSchema[];
};

const project = new Project({ useInMemoryFileSystem: true });

/**
 * Extract agent config and tool schemas from an agent.ts file path.
 */
export async function extractStaticConfig(agentPath: string): Promise<ExtractResult> {
  const source = await fs.readFile(agentPath, "utf-8");
  return extractStaticConfigFromSource(source, agentPath);
}

/** Extract agent config and tool schemas from source text. */
function extractStaticConfigFromSource(source: string, fileName = "agent.ts"): ExtractResult {
  const sf = project.createSourceFile(fileName, source, { overwrite: true });

  const call = findDefineAgentCall(sf);
  if (!call) {
    throw new BundleError(
      `Could not find a defineAgent({...}) call in ${fileName}. ` +
        "Make sure your agent.ts has `export default defineAgent({...})`.",
    );
  }

  const args = call.getArguments();
  const arg = args[0];
  if (!arg || !arg.isKind(SyntaxKind.ObjectLiteralExpression)) {
    throw new BundleError("The argument to defineAgent() must be an inline object literal");
  }

  const obj = arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  const config = extractConfig(obj, fileName);
  const toolSchemas = extractToolSchemas(obj, fileName);

  return { config, toolSchemas };
}

// ── AST search ────────────────────────────────────────────────────────────────

/** Walk the AST to find a `defineAgent(...)` call expression. */
function findDefineAgentCall(sf: SourceFile): CallExpression | undefined {
  return sf.getFirstDescendant((node) => {
    if (!node.isKind(SyntaxKind.CallExpression)) return false;
    const expr = (node as CallExpression).getExpression();
    return expr.isKind(SyntaxKind.Identifier) && expr.getText() === "defineAgent";
  }) as CallExpression | undefined;
}

// ── Config extraction ─────────────────────────────────────────────────────────

function extractConfig(obj: ObjectLiteralExpression, fileName: string): AgentConfig {
  const name = requireString(obj, "name", fileName);

  const config: AgentConfig = {
    name,
    instructions: optionalString(obj, "instructions", fileName) ?? DEFAULT_INSTRUCTIONS,
    greeting: optionalString(obj, "greeting", fileName) ?? DEFAULT_GREETING,
    voice: optionalString(obj, "voice", fileName) ?? "",
  };

  const mode = optionalString(obj, "mode", fileName);
  config.mode = (mode as AgentConfig["mode"]) ?? "s2s";

  const sttPrompt = optionalString(obj, "sttPrompt", fileName);
  if (sttPrompt !== undefined) config.sttPrompt = sttPrompt;

  // maxSteps: only extract if numeric literal (skip functions)
  const maxStepsProp = getProperty(obj, "maxSteps");
  if (maxStepsProp) {
    const init = maxStepsProp.getInitializer()!;
    if (init.isKind(SyntaxKind.NumericLiteral)) {
      config.maxSteps = Number(init.getLiteralValue());
    }
    // If function/arrow, omit — runtime only
  }

  // toolChoice
  const toolChoiceProp = getProperty(obj, "toolChoice");
  if (toolChoiceProp) {
    config.toolChoice = evalLiteral(
      toolChoiceProp.getInitializer()!,
      "toolChoice",
      fileName,
    ) as AgentConfig["toolChoice"];
  }

  // builtinTools
  const builtinToolsProp = getProperty(obj, "builtinTools");
  if (builtinToolsProp) {
    config.builtinTools = evalStringArray(
      builtinToolsProp.getInitializer()!,
      "builtinTools",
      fileName,
    ) as AgentConfig["builtinTools"];
  }

  // activeTools
  const activeToolsProp = getProperty(obj, "activeTools");
  if (activeToolsProp) {
    config.activeTools = evalStringArray(
      activeToolsProp.getInitializer()!,
      "activeTools",
      fileName,
    );
  }

  // transport
  const transportProp = getProperty(obj, "transport");
  if (transportProp) {
    const init = transportProp.getInitializer()!;
    if (init.isKind(SyntaxKind.StringLiteral)) {
      config.transport = [init.getLiteralValue()] as AgentConfig["transport"];
    } else if (init.isKind(SyntaxKind.ArrayLiteralExpression)) {
      config.transport = evalStringArray(init, "transport", fileName) as AgentConfig["transport"];
    } else {
      throw new BundleError(
        `${fileName}: \`transport\` must be a string literal or array of strings.`,
      );
    }
  }

  return config;
}

// ── Tool schema extraction ────────────────────────────────────────────────────

function extractToolSchemas(obj: ObjectLiteralExpression, fileName: string): ToolSchema[] {
  const toolsProp = getProperty(obj, "tools");
  if (!toolsProp) return [];

  const init = toolsProp.getInitializer()!;
  if (!init.isKind(SyntaxKind.ObjectLiteralExpression)) {
    throw new BundleError(`${fileName}: \`tools\` must be an inline object literal.`);
  }

  const toolsObj = init.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
  const schemas: ToolSchema[] = [];

  for (const member of toolsObj.getProperties()) {
    if (member.isKind(SyntaxKind.SpreadAssignment)) {
      const text = (member as SpreadAssignment).getExpression().getText();
      throw new BundleError(
        `${fileName}: Spread expressions like \`...${text}\` in tools ` +
          "cannot be statically analyzed. Define each tool directly in the `tools` object.",
      );
    }

    if (!member.isKind(SyntaxKind.PropertyAssignment)) continue;

    const prop = member as PropertyAssignment;
    const toolName = prop.getName();

    const toolInit = prop.getInitializer()!;
    if (!toolInit.isKind(SyntaxKind.ObjectLiteralExpression)) {
      throw new BundleError(`${fileName}: Tool \`${toolName}\` must be an inline object literal.`);
    }

    const toolObj = toolInit.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const descProp = getProperty(toolObj, "description");
    if (!descProp) {
      throw new BundleError(`${fileName}: Tool \`${toolName}\` is missing a \`description\`.`);
    }
    const description = evalStringLiteral(descProp.getInitializer()!, toolName, fileName);

    const paramsProp = getProperty(toolObj, "parameters");
    const parameters: JSONSchema7 = paramsProp
      ? zodAstToJsonSchema(paramsProp.getInitializer()!, toolName, fileName)
      : { type: "object", properties: {}, additionalProperties: false };

    schemas.push({ name: toolName, description, parameters });
  }

  return schemas;
}

// ── Zod AST → JSON Schema ────────────────────────────────────────────────────

type ZodResult = { schema: JSONSchema7; optional: boolean };

function zodAstToJsonSchema(node: Expression, toolName: string, fileName: string): JSONSchema7 {
  return parseZodExpr(node, toolName, fileName).schema;
}

function parseZodExpr(node: Expression, toolName: string, fileName: string): ZodResult {
  if (!node.isKind(SyntaxKind.CallExpression)) {
    throw zodError(node, toolName, fileName);
  }

  const call = node.asKindOrThrow(SyntaxKind.CallExpression);
  const expr = call.getExpression();

  // z.type(...) — base Zod constructors like z.string(), z.object({...})
  if (expr.isKind(SyntaxKind.PropertyAccessExpression)) {
    const propAccess = expr.asKindOrThrow(SyntaxKind.PropertyAccessExpression);
    const obj = propAccess.getExpression();
    const method = propAccess.getName();

    // z.<method>(...)
    if (obj.isKind(SyntaxKind.Identifier) && obj.getText() === "z") {
      return parseZodBase(method, call, toolName, fileName);
    }

    // .<method>() chain on inner expression
    if (method === "describe") {
      const result = parseZodExpr(obj as Expression, toolName, fileName);
      const args = call.getArguments();
      if (args[0]) {
        result.schema.description = evalStringLiteral(args[0] as Expression, toolName, fileName);
      }
      return result;
    }

    if (method === "optional") {
      const result = parseZodExpr(obj as Expression, toolName, fileName);
      result.optional = true;
      return result;
    }

    if (method === "default" || method === "nullable") {
      return parseZodExpr(obj as Expression, toolName, fileName);
    }

    // For other chain methods (.min(), .max(), .regex(), etc.) pass through
    return parseZodExpr(obj as Expression, toolName, fileName);
  }

  throw zodError(node, toolName, fileName);
}

function parseZodBase(
  method: string,
  call: CallExpression,
  toolName: string,
  fileName: string,
): ZodResult {
  switch (method) {
    case "string":
      return { schema: { type: "string" }, optional: false };

    case "number":
      return { schema: { type: "number" }, optional: false };

    case "boolean":
      return { schema: { type: "boolean" }, optional: false };

    case "enum": {
      const args = call.getArguments();
      const arg = args[0];
      if (!arg || !arg.isKind(SyntaxKind.ArrayLiteralExpression)) {
        throw new BundleError(
          `${fileName}: Tool \`${toolName}\`: z.enum() requires an array literal argument.`,
        );
      }
      const arr = arg.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
      const values = arr.getElements().map((el) => {
        if (!el.isKind(SyntaxKind.StringLiteral)) {
          throw new BundleError(
            `${fileName}: Tool \`${toolName}\`: z.enum() values must be string literals.`,
          );
        }
        return el.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
      });
      return {
        schema: { type: "string", enum: values },
        optional: false,
      };
    }

    case "array": {
      const args = call.getArguments();
      const arg = args[0];
      if (!arg) {
        return { schema: { type: "array" }, optional: false };
      }
      const items = parseZodExpr(arg as Expression, toolName, fileName);
      return {
        schema: { type: "array", items: items.schema },
        optional: false,
      };
    }

    case "object": {
      const args = call.getArguments();
      const arg = args[0];
      if (!arg || !arg.isKind(SyntaxKind.ObjectLiteralExpression)) {
        return {
          schema: {
            type: "object",
            properties: {},
            additionalProperties: false,
          },
          optional: false,
        };
      }

      const objLit = arg.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
      const properties: Record<string, JSONSchema7> = {};
      const required: string[] = [];

      for (const member of objLit.getProperties()) {
        if (!member.isKind(SyntaxKind.PropertyAssignment)) continue;
        const prop = member as PropertyAssignment;
        const propName = prop.getName();

        const result = parseZodExpr(prop.getInitializer()! as Expression, toolName, fileName);
        properties[propName] = result.schema;
        if (!result.optional) {
          required.push(propName);
        }
      }

      const schema: JSONSchema7 = {
        type: "object",
        properties,
        additionalProperties: false,
      };
      if (required.length > 0) {
        schema.required = required;
      }
      return { schema, optional: false };
    }

    default:
      throw new BundleError(
        `${fileName}: Tool \`${toolName}\`: unsupported Zod type \`z.${method}()\`. ` +
          "Supported: z.string(), z.number(), z.boolean(), z.enum([...]), " +
          "z.array(...), z.object({...}).",
      );
  }
}

function zodError(node: Expression, toolName: string, fileName: string): BundleError {
  const text = node.getText().slice(0, 60);
  return new BundleError(
    `${fileName}: Tool \`${toolName}\`: unsupported Zod pattern \`${text}\`. ` +
      "Supported: z.string(), z.number(), z.boolean(), z.enum([...]), " +
      "z.array(...), z.object({...}), .describe(), .optional().",
  );
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Get a PropertyAssignment by name from an object literal. */
function getProperty(obj: ObjectLiteralExpression, name: string): PropertyAssignment | undefined {
  const prop = obj.getProperty(name);
  if (!prop) return undefined;
  if (!prop.isKind(SyntaxKind.PropertyAssignment)) return undefined;
  return prop as PropertyAssignment;
}

/** Require a string property. */
function requireString(obj: ObjectLiteralExpression, field: string, fileName: string): string {
  const prop = getProperty(obj, field);
  if (!prop) {
    throw new BundleError(`${fileName}: The \`${field}\` field is required in defineAgent({...}).`);
  }
  return evalStringLiteral(prop.getInitializer()!, field, fileName);
}

/** Get an optional string property. */
function optionalString(
  obj: ObjectLiteralExpression,
  field: string,
  fileName: string,
): string | undefined {
  const prop = getProperty(obj, field);
  if (!prop) return undefined;
  return evalStringLiteral(prop.getInitializer()!, field, fileName);
}

/** Evaluate a node as a string literal or template literal. */
function evalStringLiteral(node: Expression, context: string, fileName: string): string {
  if (node.isKind(SyntaxKind.StringLiteral)) {
    return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
  }
  if (node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return node.asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral).getLiteralValue();
  }
  if (node.isKind(SyntaxKind.TemplateExpression)) {
    throw new BundleError(
      `${fileName}: \`${context}\` uses template expressions with substitutions, ` +
        "which cannot be statically analyzed. Use a plain string literal.",
    );
  }
  throw new BundleError(
    `${fileName}: \`${context}\` must be a static string literal. ` +
      "Dynamic expressions cannot be analyzed at build time.",
  );
}

/** Evaluate an array of string literals. */
function evalStringArray(node: Expression, context: string, fileName: string): string[] {
  if (!node.isKind(SyntaxKind.ArrayLiteralExpression)) {
    throw new BundleError(`${fileName}: \`${context}\` must be an array literal.`);
  }
  const arr = node.asKindOrThrow(SyntaxKind.ArrayLiteralExpression);
  return arr.getElements().map((el) => evalStringLiteral(el as Expression, context, fileName));
}

/** Evaluate a literal value (string, number, boolean, array, object). */
function evalLiteral(node: Expression, context: string, fileName: string): unknown {
  if (node.isKind(SyntaxKind.StringLiteral)) {
    return node.asKindOrThrow(SyntaxKind.StringLiteral).getLiteralValue();
  }
  if (node.isKind(SyntaxKind.NoSubstitutionTemplateLiteral)) {
    return node.asKindOrThrow(SyntaxKind.NoSubstitutionTemplateLiteral).getLiteralValue();
  }
  if (node.isKind(SyntaxKind.NumericLiteral)) {
    return Number(node.asKindOrThrow(SyntaxKind.NumericLiteral).getLiteralValue());
  }
  if (node.isKind(SyntaxKind.TrueKeyword)) return true;
  if (node.isKind(SyntaxKind.FalseKeyword)) return false;

  if (node.isKind(SyntaxKind.ArrayLiteralExpression)) {
    return node
      .asKindOrThrow(SyntaxKind.ArrayLiteralExpression)
      .getElements()
      .map((el) => evalLiteral(el as Expression, context, fileName));
  }

  if (node.isKind(SyntaxKind.ObjectLiteralExpression)) {
    const obj = node.asKindOrThrow(SyntaxKind.ObjectLiteralExpression);
    const result: Record<string, unknown> = {};
    for (const member of obj.getProperties()) {
      if (member.isKind(SyntaxKind.PropertyAssignment)) {
        const prop = member as PropertyAssignment;
        result[prop.getName()] = evalLiteral(
          prop.getInitializer()! as Expression,
          context,
          fileName,
        );
      }
    }
    return result;
  }

  throw new BundleError(
    `${fileName}: \`${context}\` must be a static literal value. ` +
      "Dynamic expressions cannot be analyzed at build time.",
  );
}
