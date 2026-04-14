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
const DEPLOY_KEY = "load-test-key";

export { DEPLOY_KEY };

/** Default env overrides for load tests — production-matching limits under constrained container. */
const LOAD_DEFAULTS: Record<string, string> = {
  MAX_CONNECTIONS: "100",
  SECURE_EXEC_V8_MAX_SESSIONS: "128",
};

const COMPOSE_FILES = ["docker-compose.yml", "docker-compose.load.yml"];

export async function startLoadEnv(envOverrides: Record<string, string> = {}): Promise<LoadEnv> {
  const environment = await new DockerComposeEnvironment(REPO_ROOT, COMPOSE_FILES)
    .withEnvironment({ ...LOAD_DEFAULTS, ...envOverrides })
    .withBuild()
    .withWaitStrategy("server-1", Wait.forHttp("/health", 8080).forStatusCode(200))
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
  const res = await fetch(`${serverUrl}/${slug}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      env: { ASSEMBLYAI_API_KEY: "fake-key" },
      worker: `export default { name: "test-agent", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };`,
      clientFiles: {
        "index.html": "<!DOCTYPE html><html><body>test</body></html>",
      },
      agentConfig: {
        name: "test-agent",
        systemPrompt: "Test",
        greeting: "",
        maxSteps: 1,
        tools: {},
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Deploy failed (${res.status}): ${body}`);
  }
}
