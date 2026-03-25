// Copyright 2025 the AAI authors. MIT license.

import * as p from "@clack/prompts";

/**
 * Prompt the user for a password (masked input).
 * Returns the entered string.
 */
export async function askPassword(message: string): Promise<string> {
  const value = await p.password({ message });
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value;
}

/**
 * Prompt the user for text input with a default value.
 * Returns the entered string, or the default if empty.
 */
export async function askText(message: string, defaultValue: string): Promise<string> {
  const value = await p.text({ message, placeholder: defaultValue, defaultValue });
  if (p.isCancel(value)) {
    p.cancel("Cancelled.");
    process.exit(0);
  }
  return value || defaultValue;
}
