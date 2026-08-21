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
