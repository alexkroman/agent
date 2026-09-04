// Copyright 2026 the AAI authors. MIT license.
/**
 * The one JSON responder the guest's HTTP surfaces share.
 *
 * There were four spellings of these two lines: a private copy in
 * `harness-manage.ts`, the same two lines inlined in `harness-workflow-gate.ts`
 * (which cannot import from `harness-manage.ts` — that module imports IT), and
 * `studio-http.ts`'s CORS-carrying variant. So `/manage/*` and `/workflows/*`
 * answered the identical `{ error: "unauthorized" }` through two code paths,
 * and four places decided what a JSON error body looks like. `studio-http.ts`'s
 * own header already argues this for `readBody`; the writer beside it was left
 * out.
 *
 * `headers` is how the CORS variant is expressed rather than copied — and why
 * this default is BARE: `CORS_HEADERS` belongs on the two browser-facing
 * `/studio/*` surfaces and would be wrong on a platform-only route.
 */

import type { ServerResponse } from "node:http";

export function writeJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): void {
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}
