// Copyright 2025 the AAI authors. MIT license.

import WebSocket from "ws";
import { checkHealth, openConnections, sampleMemory } from "../load/helpers.ts";
import { DEPLOY_KEY } from "./setup.ts";

export async function deployAdversarialAgent(
  serverUrl: string,
  slug: string,
  workerCode: string,
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
      worker: workerCode,
      clientFiles: {
        // biome-ignore lint/security/noSecrets: HTML template, not a secret
        "index.html": "<!DOCTYPE html><html><body>adversarial</body></html>",
      },
      agentConfig: {
        name: slug,
        systemPrompt: "",
        greeting: "",
        maxSteps: 1,
        tools: {},
      },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Adversarial deploy failed (${res.status}): ${body}`);
  }
}

export async function deployGoodAgent(serverUrl: string, slug: string): Promise<void> {
  await deployAdversarialAgent(
    serverUrl,
    slug,
    `export default { name: "good-agent", systemPrompt: "Test", greeting: "", maxSteps: 1, tools: {} };`,
  );
}

export async function assertServerSurvived(
  serverUrl: string,
  wsUrl: string,
  goodSlug: string,
  containerId: string,
): Promise<void> {
  const healthy = await checkHealth(serverUrl, 10_000);
  if (!healthy) throw new Error("Server health check failed after adversarial test");

  const { opened, rejected } = await openConnections(wsUrl, goodSlug, 1, 10_000);
  if (opened.length === 0) {
    throw new Error(`Good agent connection failed (${rejected} rejected)`);
  }
  for (const ws of opened) {
    if (ws.readyState === WebSocket.OPEN) ws.close();
  }

  const mem = sampleMemory(containerId);
  if (mem.percent > 90) {
    throw new Error(`Memory dangerously high after adversarial test: ${mem.percent.toFixed(1)}%`);
  }
}
