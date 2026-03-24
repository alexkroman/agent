import { chmodSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { defineConfig } from "tsup";

export default defineConfig({
  entry: ["cli.ts"],
  format: "esm",
  platform: "node",
  target: "node20",
  outDir: "dist",
  banner: { js: "#!/usr/bin/env node" },
  bundle: true,
  // Keep workspace and npm packages external
  external: [/^[^./]/],
  esbuildOptions(options) {
    options.jsx = "automatic";
  },
  async onSuccess() {
    // Write color-force wrapper
    const wrapper = `#!/usr/bin/env node
if(!process.env.FORCE_COLOR&&!process.env.NO_COLOR&&process.stdout.isTTY){const c=process.env.COLORTERM;process.env.FORCE_COLOR=(c==='truecolor'||c==='24bit')?'3':c?'2':'1';}
import("./cli.mjs").catch(e=>{process.stderr.write(e?.message??"");process.exit(1)});
`;
    writeFileSync(resolve("dist/aai.js"), wrapper);
    chmodSync(resolve("dist/aai.js"), 0o755);
    chmodSync(resolve("dist/cli.mjs"), 0o755);
  },
});
