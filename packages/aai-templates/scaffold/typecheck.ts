/**
 * TypeScript type checking for agent projects.
 *
 * Runs the TypeScript compiler to validate agent code is type-correct.
 */

import { execFileSync } from "node:child_process";

try {
  execFileSync("npx", ["tsc", "--noEmit"], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
} catch {
  process.exit(1);
}
