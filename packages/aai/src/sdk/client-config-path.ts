// Copyright 2026 the AAI authors. MIT license.
/**
 * The client-config endpoint's PATH, alone in a module.
 *
 * It is declared here rather than beside the schema that parses the body
 * (`client-config.ts`) because the two have different costs: the schema imports
 * zod, and the path is needed by `agent-client.ts`, which is reached from
 * `@alexkroman1/aai/workflow-api` — a subpath whose whole graph is zod-free and
 * which a workflow app's page bundles. Importing the const from the schema
 * module is a VALUE import, so it pulls the module, and with it a schema
 * construction no bundler can be relied on to shake out.
 *
 * `client-config.ts` re-exports it, so `/protocol` and every existing importer
 * are unchanged.
 */

/** Relative path of the client-config endpoint under an agent's base URL. */
export const CLIENT_CONFIG_PATH = "client-config";

/**
 * The only method the endpoint answers — read by the host's route dispatch, so
 * this is the value and not a description of it.
 *
 * Beside the path for the same reason the path is exported at all: the platform
 * proxies this route, and `aai-server`'s `GUEST_ROUTE_EXPOSURE` has to name the
 * verbs the guest answers. A hardcoded `"GET"` on that side would be a second
 * source of truth for a one-word fact, which is the shape that rots — see
 * `WORKFLOW_API_METHODS` on `@alexkroman1/aai-runtime` for the same rule on the
 * workflow route, where it has already cost two incidents.
 */
export const CLIENT_CONFIG_METHODS: readonly string[] = ["GET"];
