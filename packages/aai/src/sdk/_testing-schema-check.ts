// Copyright 2026 the AAI authors. MIT license.
/**
 * The one Standard-Schema check the testing fakes share: `parseSchemaInput`,
 * `createWorkflowContext`'s `schema` option and `stubDelegate`'s typed
 * replies. A leaf module, because `stubDelegate` sits below
 * `_testing-schema.ts` in the import graph.
 *
 * @module _testing-schema-check
 */

import { formatSchemaIssues, type StandardSchemaV1 } from "./standard-schema.ts";

/**
 * Validate `value` against `schema` — awaiting, since a vendor's `validate` may
 * be sync or async — or throw the sentence `refusal` builds from the issues,
 * rendered as one line.
 */
export async function validatedBy(
  schema: StandardSchemaV1,
  value: unknown,
  refusal: (issues: string) => string,
): Promise<unknown> {
  const result = await schema["~standard"].validate(value);
  if (result.issues) throw new Error(refusal(formatSchemaIssues(result.issues)));
  return result.value;
}
