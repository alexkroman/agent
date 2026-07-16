// Copyright 2025 the AAI authors. MIT license.
/**
 * Shared test helpers for the sandbox-vm test files
 * (sandbox-vm.test.ts, sandbox-vm-rpc-handlers.test.ts).
 */

import { PassThrough } from "node:stream";
import { vi } from "vitest";
import { createNdjsonConnection, type NdjsonConnection } from "./ndjson-transport.ts";
import type { SandboxVmOptions, WarmHarness } from "./sandbox-vm.ts";

export function createTestConn(): {
  conn: NdjsonConnection;
  hostReadable: PassThrough;
  hostWritable: PassThrough;
  writtenLines: string[];
} {
  const hostReadable = new PassThrough();
  const hostWritable = new PassThrough();
  const writtenLines: string[] = [];
  hostWritable.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (line.trim()) writtenLines.push(line);
    }
  });
  const conn = createNdjsonConnection(hostReadable, hostWritable);
  return { conn, hostReadable, hostWritable, writtenLines };
}

export function makeWarm(conn: NdjsonConnection, cleanup: () => Promise<void>): WarmHarness {
  return {
    conn,
    cleanup,
    alive: () => true,
    onExit: () => undefined,
  };
}

export function writeResponse(stream: PassThrough, id: number, result: unknown): void {
  stream.push(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
}

/**
 * Attach an auto-responder to hostWritable that replies to bundle/load
 * requests on hostReadable. Returns a detach function.
 */
export function autorespondBundleLoad(
  hostWritable: PassThrough,
  hostReadable: PassThrough,
): () => void {
  const handler = (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n")) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.method === "bundle/load" && msg.id != null) {
          writeResponse(hostReadable, msg.id, { ok: true });
        }
      } catch {
        // ignore parse errors
      }
    }
  };
  hostWritable.on("data", handler);
  return () => hostWritable.off("data", handler);
}

export function baseOpts(overrides?: Partial<SandboxVmOptions>): SandboxVmOptions {
  return {
    slug: "test-agent",
    workerCode: 'export default { name: "test" };',
    env: { FOO: "bar" },
    harnessPath: "/tmp/harness.mjs",
    ...overrides,
  };
}

/** Wait until a JSON-RPC response with the given id appears in writtenLines. */
export async function waitForResponseId(writtenLines: string[], id: number): Promise<void> {
  await vi.waitFor(() => {
    const found = writtenLines.some((l) => {
      try {
        return JSON.parse(l).id === id;
      } catch {
        return false;
      }
    });
    if (!found) throw new Error(`Response with id ${id} not found yet`);
  });
}

/** Find a parsed JSON-RPC message by id in writtenLines. */
export function findResponseById(
  writtenLines: string[],
  id: number,
): Record<string, unknown> | undefined {
  return writtenLines
    .map((l) => {
      try {
        return JSON.parse(l);
      } catch {
        return null;
      }
    })
    .find((m: { id?: number } | null) => m?.id === id);
}

/** Reject every bundle/load request with a "Worker code not found" error. */
export function autorespondBundleLoadError(
  hostWritable: PassThrough,
  hostReadable: PassThrough,
): () => void {
  const handler = (chunk: Buffer) => onBundleLoadReject(chunk, hostReadable);
  hostWritable.on("data", handler);
  return () => hostWritable.off("data", handler);
}

function onBundleLoadReject(chunk: Buffer, hostReadable: PassThrough): void {
  for (const line of chunk.toString().split("\n")) {
    if (!line.trim()) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.method === "bundle/load" && msg.id != null) {
        hostReadable.push(
          `${JSON.stringify({
            jsonrpc: "2.0",
            id: msg.id,
            error: { code: -32_603, message: "Worker code not found" },
          })}\n`,
        );
      }
    } catch {
      // ignore
    }
  }
}
