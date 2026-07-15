// Copyright 2025 the AAI authors. MIT license.
/**
 * Load test helpers: WebSocket flooding, memory sampling, health checking.
 */

import { execFileSync } from "node:child_process";
import WebSocket from "ws";

/** POST a deploy to `${serverUrl}/${slug}/deploy`, throwing on non-OK. */
export async function deployAgent(
  serverUrl: string,
  slug: string,
  opts: {
    key: string;
    worker: string;
    agentConfig: Record<string, unknown>;
    indexHtml: string;
    errorLabel?: string;
  },
): Promise<void> {
  const res = await fetch(`${serverUrl}/${slug}/deploy`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${opts.key}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      env: { ASSEMBLYAI_API_KEY: "fake-key" },
      worker: opts.worker,
      clientFiles: { "index.html": opts.indexHtml },
      agentConfig: opts.agentConfig,
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`${opts.errorLabel ?? "Deploy"} failed (${res.status}): ${body}`);
  }
}

export type MemorySample = {
  timestampMs: number;
  usageBytes: number;
  limitBytes: number;
  percent: number;
};

const MEM_UNITS: Record<string, number> = {
  GiB: 1024 ** 3,
  MiB: 1024 ** 2,
  KiB: 1024,
  B: 1,
};

function parseMemValue(str: string): number {
  const trimmed = str.trim();
  const num = Number.parseFloat(trimmed);
  for (const [suffix, factor] of Object.entries(MEM_UNITS)) {
    if (trimmed.endsWith(suffix)) return num * factor;
  }
  return num;
}

export function sampleMemory(containerId: string): MemorySample {
  const output = execFileSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", containerId],
    { encoding: "utf-8", timeout: 10_000 },
  );
  const stats = JSON.parse(output.trim());
  const [usageStr = "0B", limitStr = "0B"] = String(stats.MemUsage).split(" / ");
  const usageBytes = parseMemValue(usageStr);
  const limitBytes = parseMemValue(limitStr);

  return {
    timestampMs: Date.now(),
    usageBytes,
    limitBytes,
    percent: (usageBytes / limitBytes) * 100,
  };
}

export async function openConnections(
  wsUrl: string,
  slug: string,
  count: number,
  timeoutMs = 5000,
): Promise<{ opened: WebSocket[]; rejected: number }> {
  const results = await Promise.allSettled(
    Array.from(
      { length: count },
      () =>
        new Promise<WebSocket>((resolve, reject) => {
          const ws = new WebSocket(`${wsUrl}/${slug}/websocket`);
          const timer = setTimeout(() => {
            ws.close();
            reject(new Error("Connection timeout"));
          }, timeoutMs);
          const settle = (fn: () => void) => {
            clearTimeout(timer);
            fn();
          };
          ws.on("open", () => settle(() => resolve(ws)));
          ws.on("error", (err) => settle(() => reject(err)));
          ws.on("unexpected-response", () =>
            settle(() => reject(new Error("Unexpected response"))),
          );
        }),
    ),
  );

  const opened: WebSocket[] = [];
  let rejected = 0;
  for (const r of results) {
    if (r.status === "fulfilled") opened.push(r.value);
    else rejected++;
  }
  return { opened, rejected };
}

export async function closeAll(connections: WebSocket[]): Promise<void> {
  await Promise.allSettled(
    connections.map(
      (ws) =>
        new Promise<void>((resolve) => {
          if (ws.readyState === WebSocket.CLOSED) {
            resolve();
            return;
          }
          ws.on("close", () => resolve());
          ws.close();
        }),
    ),
  );
}

export async function checkHealth(serverUrl: string, timeoutMs = 5000): Promise<boolean> {
  try {
    const res = await fetch(`${serverUrl}/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    return res.ok;
  } catch {
    return false;
  }
}
