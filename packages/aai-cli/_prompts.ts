// Copyright 2025 the AAI authors. MIT license.

import { createInterface } from "node:readline";
import ci from "ci-info";

/**
 * Prompt the user for a password (masked input).
 * Throws in CI or non-TTY environments instead of hanging.
 */
export async function askPassword(message: string): Promise<string> {
  if (ci.isCI || !process.stdin.isTTY) {
    throw new Error(
      `Interactive prompt requires a terminal. Set ${message} as an environment variable in CI.`,
    );
  }

  const rl = createInterface({ input: process.stdin, output: process.stdout });
  process.stdout.write(`${message}: `);

  const stdin = process.stdin;
  const wasRaw = stdin.isRaw;
  stdin.setRawMode(true);

  try {
    return await readMasked(stdin);
  } finally {
    stdin.setRawMode(wasRaw ?? false);
    rl.close();
  }
}

function readMasked(stdin: NodeJS.ReadStream): Promise<string> {
  return new Promise((resolve) => {
    let buf = "";
    const onData = (ch: Buffer) => {
      const c = ch.toString();
      if (c === "\n" || c === "\r") {
        stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(buf);
      } else if (c === "\u0003") {
        stdin.removeListener("data", onData);
        process.exit(0);
      } else if (c === "\u007F" || c === "\b") {
        buf = buf.slice(0, -1);
      } else {
        buf += c;
      }
    };
    stdin.on("data", onData);
  });
}
