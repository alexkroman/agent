// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:workflow` epoch 1.
 *
 * Epoch 2 widened `createWorkflowApi`'s return from `WorkflowApi` to the full
 * `AgentClient` (a documented superset) and re-exported `AgentClient` here.
 * A widened return is only safe if epoch-1 code that stored the value in a
 * `WorkflowApi`-typed binding still compiles — which is precisely what this
 * file pins, and the reason the annotation below is written out rather than
 * inferred.
 */

import type { WorkflowApi } from "@alexkroman1/aai-ui";
import { createWorkflowApi } from "@alexkroman1/aai-ui";

// The annotation is the assertion: a superset must remain assignable to it.
const api: WorkflowApi = createWorkflowApi();

// The hoisted-client pattern epoch 1 taught. Epoch 2 defaults it, but passing
// one explicitly is still how a page reaches a different `baseUrl`.
export const remote: WorkflowApi = createWorkflowApi({ baseUrl: "https://example.invalid" });

export const listed = async (): Promise<unknown> => api.list();
