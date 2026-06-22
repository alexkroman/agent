// Copyright 2025 the AAI authors. MIT license.
/**
 * Testcontainers setup for load tests.
 * Starts the server + MinIO compose stack and deploys a minimal test agent.
 */

import path from "node:path";
import { DockerComposeEnvironment, Wait } from "testcontainers";

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

const SERVER_CONTAINER_NAME = "server-1";
const SERVER_PORT = 8080;

// CI runners under sustained load can take >60s to bring the stack up; the
// default Wait timeout is too tight and surfaces as the misleading
// "Cannot get container 'server-1' as it is not running" at getContainer().
const STARTUP_TIMEOUT_MS = 180_000;

export async function startLoadEnv(envOverrides: Record<string, string> = {}): Promise<LoadEnv> {
  const environment = await new DockerComposeEnvironment(REPO_ROOT, COMPOSE_FILES)
    .withEnvironment({ ...LOAD_DEFAULTS, ...envOverrides })
    .withBuild()
    .withWaitStrategy(
      SERVER_CONTAINER_NAME,
      Wait.forHttp("/health", SERVER_PORT)
        .forStatusCode(200)
        .withStartupTimeout(STARTUP_TIMEOUT_MS),
    )
    .up();

  const serverContainer = environment.getContainer(SERVER_CONTAINER_NAME);
  const host = serverContainer.getHost();
  const port = serverContainer.getMappedPort(SERVER_PORT);

  return {
    serverUrl: `http://${host}:${port}`,
    wsUrl: `ws://${host}:${port}`,
    containerId: serverContainer.getId(),
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
  const res = await fetch(`${serverUrl}/${slug}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      env: { ASSEMBLYAI_API_KEY: "fake-key" },
      worker: `export default ${JSON.stringify(agentConfig)};`,
      clientFiles: {
        "index.html": "<!DOCTYPE html><html><body>test</body></html>",
      },
      agentConfig,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deploy failed (${res.status}): ${body}`);
  }
}
