/**
 * Validates all templates typecheck.
 * Runs as a standalone script (not vitest) to avoid worker pool issues.
 *
 * Usage: node --experimental-strip-types scripts/check-typecheck.ts
 */
import { execFileSync } from "node:child_process";

const cwd = new URL("..", import.meta.url).pathname.replace(/\/$/, "");

try {
  execFileSync("npx", ["tsc", "--noEmit"], {
    cwd,
    stdio: "inherit",
  });
  console.log("All templates typecheck passed.");
} catch {
  console.error("Typecheck failed.");
  process.exit(1);
}
