import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, "../packages/aai-cli");

mkdirSync(resolve(cliRoot, "dist"), { recursive: true });

writeFileSync(
  resolve(cliRoot, "dist/aai.js"),
  `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

try {
  execFileSync(resolve(root, "node_modules/.bin/tsx"), ["--tsconfig", resolve(root, "tsconfig.json"), resolve(root, "cli.ts"), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
`,
);

chmodSync(resolve(cliRoot, "dist/aai.js"), 0o755);
console.log("Wrote dev shim to packages/aai-cli/dist/aai.js");
