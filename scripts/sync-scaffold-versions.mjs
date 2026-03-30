#!/usr/bin/env node

/**
 * Syncs @alexkroman1/* dependency versions in the scaffold package.json
 * to match current workspace package versions (as ^x.y.z ranges).
 *
 * Run automatically after `changeset version` in the release workflow.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = new URL("..", import.meta.url).pathname;
const scaffoldPath = join(
  root,
  "packages/aai-templates/scaffold/package.json",
);

const pkgMap = {
  "@alexkroman1/aai": "packages/aai/package.json",
  "@alexkroman1/aai-ui": "packages/aai-ui/package.json",
  "@alexkroman1/aai-cli": "packages/aai-cli/package.json",
};

const scaffold = JSON.parse(readFileSync(scaffoldPath, "utf8"));
let changed = false;

for (const [dep, pkgPath] of Object.entries(pkgMap)) {
  const { version } = JSON.parse(readFileSync(join(root, pkgPath), "utf8"));
  const caretRange = `^${version}`;

  for (const section of ["dependencies", "devDependencies"]) {
    if (scaffold[section]?.[dep] && scaffold[section][dep] !== caretRange) {
      console.log(`${section}.${dep}: ${scaffold[section][dep]} → ${caretRange}`);
      scaffold[section][dep] = caretRange;
      changed = true;
    }
  }
}

if (changed) {
  writeFileSync(scaffoldPath, JSON.stringify(scaffold, null, 2) + "\n");
  console.log("Scaffold package.json updated.");
} else {
  console.log("Scaffold package.json already in sync.");
}
