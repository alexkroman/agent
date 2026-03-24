import { mkdirSync, writeFileSync, chmodSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(__dirname, "..");

mkdirSync(resolve(agentRoot, "dist"), { recursive: true });

writeFileSync(
  resolve(agentRoot, "dist/aai.js"),
  `#!/usr/bin/env node
import { execFileSync } from "node:child_process";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, "..");

try {
  execFileSync("npx", ["tsx", resolve(root, "cli/cli.ts"), ...process.argv.slice(2)], {
    stdio: "inherit",
    cwd: process.cwd(),
    env: process.env,
  });
} catch (e) {
  process.exit(e.status ?? 1);
}
`,
);

chmodSync(resolve(agentRoot, "dist/aai.js"), 0o755);
console.log("Wrote dev shim to dist/aai.js");
