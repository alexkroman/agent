// Copyright 2025 the AAI authors. MIT license.
/**
 * Testcontainers setup for load tests.
 * Starts the server + MinIO compose stack and deploys a minimal test agent.
 */

import path from "node:path";
import { DockerComposeEnvironment, Wait } from "testcontainers";
import { deployAgent } from "./helpers.ts";

export type LoadEnv = {
  serverUrl: string;
  wsUrl: string;
  containerId: string;
  stop: () => Promise<void>;
};

const REPO_ROOT = path.resolve(import.meta.dirname, "../../..");
export const DEPLOY_KEY = "load-test-key";

/** Default env overrides for load tests — production-matching limits under constrained container. */
const LOAD_DEFAULTS = {
  MAX_CONNECTIONS: "100",
  SECURE_EXEC_V8_MAX_SESSIONS: "128",
};

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.load.yml"];

// CI runners under sustained load can take >60s to bring the stack up; the
// default Wait timeout is too tight and surfaces as the misleading
// "Cannot get container 'server-1' as it is not running" at getContainer().
const STARTUP_TIMEOUT_MS = 180_000;

export async function startLoadEnv(envOverrides: Record<string, string> = {}): Promise<LoadEnv> {
  const environment = await new DockerComposeEnvironment(REPO_ROOT, COMPOSE_FILES)
    .withEnvironment({ ...LOAD_DEFAULTS, ...envOverrides })
    .withBuild()
    .withWaitStrategy(
      "server-1",
      Wait.forHttp("/health", 8080).forStatusCode(200).withStartupTimeout(STARTUP_TIMEOUT_MS),
    )
    .up();

  const serverContainer = environment.getContainer("server-1");
  const host = serverContainer.getHost();
  const port = serverContainer.getMappedPort(8080);
  const containerId = serverContainer.getId();

  const serverUrl = `http://${host}:${port}`;
  const wsUrl = `ws://${host}:${port}`;

  return {
    serverUrl,
    wsUrl,
    containerId,
    stop: async () => {
      await environment.down({ removeVolumes: true });
    },
  };
}

export async function deployTestAgent(
  serverUrl: string,
  slug: string,
  key = DEPLOY_KEY,
): Promise<void> {
  const agentConfig = {
    name: "test-agent",
    systemPrompt: "Test",
    greeting: "",
    maxSteps: 1,
    tools: {},
  };
  await deployAgent(serverUrl, slug, {
    key,
    worker: `export default ${JSON.stringify(agentConfig)};`,
    agentConfig,
    indexHtml: "<!DOCTYPE html><html><body>test</body></html>",
  });
}
