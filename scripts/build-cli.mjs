import * as esbuild from "esbuild";
import { chmodSync, readFileSync, writeFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const agentRoot = resolve(__dirname, "..");

// Read exports map from package.json to resolve aai/* self-references
const pkg = JSON.parse(readFileSync(resolve(agentRoot, "package.json"), "utf-8"));
const exportsMap = new Map();
for (const [subpath, target] of Object.entries(pkg.exports)) {
  const specifier = subpath === "." ? pkg.name : `${pkg.name}/${subpath.slice(2)}`;
  exportsMap.set(specifier, resolve(agentRoot, target));
  // Also map the old unscoped name for backwards compat
  const oldSpecifier = subpath === "." ? "aai" : `aai/${subpath.slice(2)}`;
  exportsMap.set(oldSpecifier, resolve(agentRoot, target));
}

/** Plugin to resolve self-referencing package imports to local source. */
const selfRefPlugin = {
  name: "self-ref",
  setup(build) {
    build.onResolve({ filter: /^(aai|@alexkroman1\/aai)(\/|$)/ }, (args) => {
      const local = exportsMap.get(args.path);
      if (local) return { path: local };
      return undefined;
    });
  },
};

await esbuild.build({
  entryPoints: ["cli/cli.ts"],
  bundle: true,
  outfile: "dist/cli.js",
  format: "esm",
  platform: "node",
  target: "node20",
  banner: { js: "#!/usr/bin/env node" },
  jsx: "automatic",
  packages: "external",
  plugins: [selfRefPlugin],
});

chmodSync("dist/cli.js", 0o755);

// Wrapper that sets FORCE_COLOR before chalk initializes
writeFileSync(
  resolve(agentRoot, "dist/aai.js"),
  `#!/usr/bin/env node
if(!process.env.FORCE_COLOR&&!process.env.NO_COLOR&&process.stdout.isTTY)process.env.FORCE_COLOR='1';
await import("./cli.js");
`,
);
chmodSync(resolve(agentRoot, "dist/aai.js"), 0o755);
