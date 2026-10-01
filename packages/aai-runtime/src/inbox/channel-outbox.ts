// Copyright 2026 the AAI authors. MIT license.
/**
 * `AAI_CHANNEL_OUTBOX` — capture every text and channel post into a file
 * instead of sending it.
 *
 * The runtime half of the SDK's channel outbox (`publishChannelOutbox`, whose
 * module doc carries why the sink is checked in `postToChannel` and why it is
 * a global slot). Set the variable to a file path in the shell that runs
 * `aai dev` (or a self-hosted server) and each send — the `text_me` builtin,
 * a workflow step's `sendToChannel` — is appended to it as one JSON line,
 * `{ at, kind, to, body }`, and reported to the agent as delivered. Nothing
 * leaves the process, so an agent that texts its owner can be exercised end to
 * end with the real key in `.env` and nobody's phone buzzing.
 *
 * Read from `process.env`, not the agent's env: like `AAI_DEV_HOST` it
 * configures the PROCESS, not the agent, and an agent must never be able to
 * turn its own deliveries off from a `.env` that ships with it.
 *
 * What the SDK hands the sink has no credential in it; what this LOGS has even
 * less — the kind and the length. The recipient is a phone number and the body
 * is whatever the agent wrote about its user, so neither goes to a log line;
 * the file is where they are, and the file is the one thing the developer
 * asked for.
 *
 * @internal
 */

import { appendFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  type ChannelOutbox,
  type ChannelOutboxEntry,
  publishChannelOutbox,
} from "@alexkroman1/aai/host-internal";
import type { Logger } from "../logger.ts";

/** The process-env variable naming the outbox file. @internal */
export const CHANNEL_OUTBOX_ENV = "AAI_CHANNEL_OUTBOX";

/** Append one line to the file — injected so the unit tier writes nothing. */
export type OutboxWriter = (file: string, line: string) => Promise<void>;

const appendLine: OutboxWriter = async (file, line) => {
  await mkdir(path.dirname(file), { recursive: true });
  await appendFile(file, line, "utf8");
};

/**
 * The sink that appends each entry to `file` as a JSON line stamped with the
 * time it was captured.
 *
 * @internal
 */
export function createChannelOutbox(options: {
  file: string;
  logger: Logger;
  write?: OutboxWriter | undefined;
  now?: (() => Date) | undefined;
}): ChannelOutbox {
  const write = options.write ?? appendLine;
  const now = options.now ?? (() => new Date());
  return async (entry: ChannelOutboxEntry) => {
    const record = { at: now().toISOString(), ...entry };
    await write(options.file, `${JSON.stringify(record)}\n`);
    // Kind and size only: the number and the text are the user's (module doc).
    options.logger.info("Channel send captured in the outbox", {
      kind: entry.kind,
      chars: JSON.stringify(entry.body).length,
    });
  };
}

/**
 * Publish the outbox when `AAI_CHANNEL_OUTBOX` names a file, and say so once.
 *
 * Called by `installWorkflowSupport`, which every `createServerForRuntime` runs
 * whether or not the agent declares a workflow — `text_me` is a builtin, so an
 * agent with no workflows sends too. Unset (or blank), nothing is published and
 * sends go out as usual; nothing is UNpublished either, so a sink a test
 * published itself is left alone.
 *
 * @returns the resolved file, or `undefined` when the outbox is off.
 * @internal
 */
export function installChannelOutbox(
  logger: Logger,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  const raw = env[CHANNEL_OUTBOX_ENV]?.trim();
  if (!raw) return;
  const file = path.resolve(raw);
  publishChannelOutbox(createChannelOutbox({ file, logger }));
  logger.info("Channels go to an outbox", {
    path: file,
    detail: "nothing is sent: texts and posts are appended to this file",
  });
  return file;
}
