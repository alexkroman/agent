// Copyright 2025 the AAI authors. MIT license.
/**
 * Load test helpers: WebSocket flooding, memory sampling, health checking.
 */

import { execFileSync } from "node:child_process";
import WebSocket from "ws";

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
  const unit = trimmed.match(/(GiB|MiB|KiB|B)$/)?.[1];
  return num * (MEM_UNITS[unit ?? "B"] ?? 1);
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

  const opened = results.filter((r) => r.status === "fulfilled").map((r) => r.value);
  return { opened, rejected: count - opened.length };
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
