// Copyright 2025 the AAI authors. MIT license.

import fs from "node:fs";
import path from "node:path";
import { describe, expect, test } from "vitest";
import { renderCheck } from "../sdk/_render_check.ts";

const dir = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname);
const templatesDir = path.resolve(dir, "..", "templates");

const templates = fs
  .readdirSync(templatesDir, { withFileTypes: true })
  .filter((d) => d.isDirectory() && !d.name.startsWith("_"))
  .map((d) => d.name)
  .filter((name) => fs.existsSync(path.join(templatesDir, name, "client.tsx")));

describe("template render smoke tests", () => {
  for (const name of templates) {
    test(`${name}/client.tsx renders without errors`, async () => {
      const templateDir = path.join(templatesDir, name);
      const clientEntry = path.join(templateDir, "client.tsx");
      await expect(renderCheck(clientEntry, templateDir)).resolves.toBeUndefined();
    });
  }
});
