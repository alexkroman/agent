import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as esbuild from "esbuild";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliRoot = resolve(__dirname, "..");

mkdirSync(resolve(cliRoot, "dist"), { recursive: true });

await esbuild.build({
  entryPoints: [resolve(cliRoot, "cli.ts")],
  bundle: true,
  outfile: resolve(cliRoot, "dist/cli.js"),
  format: "esm",
  platform: "node",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  jsx: "automatic",
  packages: "external",
});

chmodSync(resolve(cliRoot, "dist/cli.js"), 0o755);

// Wrapper that sets FORCE_COLOR before chalk initializes
writeFileSync(
  resolve(cliRoot, "dist/aai.js"),
  `#!/usr/bin/env node
if(!process.env.FORCE_COLOR&&!process.env.NO_COLOR&&process.stdout.isTTY){const c=process.env.COLORTERM;process.env.FORCE_COLOR=(c==='truecolor'||c==='24bit')?'3':c?'2':'1';}
import("./cli.js").catch(e=>{process.stderr.write(e?.message??"");process.exit(1)});
`,
);
chmodSync(resolve(cliRoot, "dist/aai.js"), 0o755);
