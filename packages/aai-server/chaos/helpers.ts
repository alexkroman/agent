// Copyright 2025 the AAI authors. MIT license.
/**
 * Chaos test helpers: WebSocket flooding, memory sampling, health checking.
 */

import { execFileSync } from "node:child_process";
import WebSocket from "ws";

export type MemorySample = {
  timestampMs: number;
  usageBytes: number;
  limitBytes: number;
  percent: number;
};

/**
 * Sample container memory usage via `docker stats --no-stream`.
 * Returns current memory usage and limit.
 */
export function sampleMemory(containerId: string): MemorySample {
  const output = execFileSync(
    "docker",
    ["stats", "--no-stream", "--format", "{{json .}}", containerId],
    { encoding: "utf-8", timeout: 10_000 },
  );
  const stats = JSON.parse(output.trim());

  // Parse "123.4MiB / 512MiB" format from MemUsage
  const memUsage: string = stats.MemUsage;
  const parts = memUsage.split(" / ");
  const usageStr = parts[0] ?? "0B";
  const limitStr = parts[1] ?? "0B";
  const usageBytes = parseMemValue(usageStr);
  const limitBytes = parseMemValue(limitStr);

  return {
    timestampMs: Date.now(),
    usageBytes,
    limitBytes,
    percent: (usageBytes / limitBytes) * 100,
  };
}

function parseMemValue(str: string): number {
  const trimmed = str.trim();
  const num = Number.parseFloat(trimmed);
  if (trimmed.endsWith("GiB")) return num * 1024 * 1024 * 1024;
  if (trimmed.endsWith("MiB")) return num * 1024 * 1024;
  if (trimmed.endsWith("KiB")) return num * 1024;
  if (trimmed.endsWith("B")) return num;
  return num;
}

/**
 * Open N WebSocket connections to the given URL.
 * Returns an array of open connections and an array of connections that failed to open.
 */
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
          ws.on("open", () => {
            clearTimeout(timer);
            resolve(ws);
          });
          ws.on("error", (err) => {
            clearTimeout(timer);
            reject(err);
          });
          ws.on("unexpected-response", () => {
            clearTimeout(timer);
            reject(new Error("Unexpected response"));
          });
        }),
    ),
  );

  const opened: WebSocket[] = [];
  let rejected = 0;
  for (const r of results) {
    if (r.status === "fulfilled") {
      opened.push(r.value);
    } else {
      rejected++;
    }
  }
  return { opened, rejected };
}

/** Close all WebSocket connections. */
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

/** Check that the health endpoint responds with 200. */
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

/**
 * Sample memory every intervalMs for durationMs.
 * Returns all samples collected.
 */
export async function monitorMemory(
  containerId: string,
  durationMs: number,
  intervalMs = 1000,
): Promise<MemorySample[]> {
  const samples: MemorySample[] = [];
  const end = Date.now() + durationMs;
  while (Date.now() < end) {
    try {
      samples.push(sampleMemory(containerId));
    } catch {
      // docker stats can occasionally fail; skip sample
    }
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  return samples;
}

/** Wait for a condition to be true, polling at intervalMs. */
export async function waitFor(
  fn: () => boolean | Promise<boolean>,
  timeoutMs: number,
  intervalMs = 500,
): Promise<void> {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    if (await fn()) return;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
  throw new Error(`waitFor timed out after ${timeoutMs}ms`);
}
