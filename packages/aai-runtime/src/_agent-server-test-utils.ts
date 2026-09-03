// Copyright 2026 the AAI authors. MIT license.
/**
 * The server harness `agent-server.test.ts` and `agent-server.scenario.test.ts`
 * share.
 *
 * Its own module for the reason `aai-cli/_dev-server-test-utils.ts` is: the two
 * suites cover one door and are split by TIER rather than by subject, so a copy
 * of this in each is two copies of the fake key that can disagree.
 *
 * @internal
 */

import { silentLogger } from "./_test-utils.ts";
import { createAgentServer } from "./agent-server.ts";

/**
 * The env every agent-server spec boots with.
 *
 * Deliberately a NON-CREDENTIAL. Nothing in either suite asserts anything about
 * a provider, and a real key in a spec would be a real key in a log — but note
 * what it does NOT buy: the runtime is real, so a spec that opens a session
 * really does dial AssemblyAI and really is told the key is invalid. That is why
 * two of these specs are scenario-tier; see that file's header.
 */
export const AGENT_SERVER_ENV = { ASSEMBLYAI_API_KEY: "sk-test" };

/** Boot the door on an ephemeral port, run `run` against it, and close it. */
export async function withServer(
  options: Omit<Parameters<typeof createAgentServer>[0], "env"> & {
    env?: Record<string, string>;
  },
  run: (baseUrl: string) => Promise<void>,
): Promise<void> {
  const server = createAgentServer({ env: AGENT_SERVER_ENV, logger: silentLogger, ...options });
  await server.listen(0);
  try {
    await run(`http://127.0.0.1:${server.port}`);
  } finally {
    await server.close();
  }
}
