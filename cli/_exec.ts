// Copyright 2025 the AAI authors. MIT license.
import { execFile } from "node:child_process";
import { promisify } from "node:util";

/** Promisified `child_process.execFile`. */
export const execFileAsync = promisify(execFile);
