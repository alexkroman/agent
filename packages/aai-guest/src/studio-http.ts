// Copyright 2026 the AAI authors. MIT license.
/**
 * The small HTTP primitives the guest's `/studio/*` surfaces share.
 *
 * There are two of them now — the PUBLIC chat surface (`studio-chat.ts`,
 * gated by the per-session `chatToken`) and the PLATFORM session-install
 * surface (`studio-session-init.ts`, gated by the per-sandbox host token) —
 * and they must answer with the same CORS policy and the same bounded body
 * read. Copying `readBody` per surface is how one of them ends up without
 * the `close`-without-`end` guard that keeps an aborted upload from parking
 * a promise forever.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { writeJson } from "./harness-http.ts";

export const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers": "authorization, content-type",
};

/** The `/studio/*` responder: {@link writeJson} plus this surface's CORS policy. */
export function sendJson(res: ServerResponse, status: number, body: unknown): void {
  writeJson(res, status, body, CORS_HEADERS);
}

/** Read the request body with a hard byte cap. */
export function readBody(req: IncomingMessage, maxBytes: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) {
        reject(new Error("Request body too large"));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
    // `close` without `end` — client went away mid-upload. Node does not
    // reliably emit `error` for an aborted request, so without this the
    // promise parks forever and the accumulated chunks are retained for the
    // life of the guest (settling twice is harmless: first wins).
    req.on("close", () => reject(new Error("Request closed before body completed")));
  });
}
