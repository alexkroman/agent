// Copyright 2025 the AAI authors. MIT license.
/**
 * Tiny level-gated logger. Use for lifecycle traces that are useful in
 * incidents but should not appear in steady-state logs.
 *
 * Set `LOG_LEVEL=DEBUG` to enable. Otherwise no-op.
 */
export function debug(msg: string, fields?: Record<string, unknown>): void {
  if (process.env.LOG_LEVEL !== "DEBUG") return;
  if (fields === undefined) console.info(msg);
  else console.info(msg, fields);
}
