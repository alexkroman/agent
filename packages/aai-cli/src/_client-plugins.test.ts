// Copyright 2026 the AAI authors. MIT license.
/**
 * The plugins are resolved from the PROJECT's `node_modules`, so each case
 * builds one: fake `@vitejs/plugin-react` / `@tailwindcss/vite` packages whose
 * factories record the options they were called with.
 */

import path from "node:path";
import { describe, expect, test } from "vitest";
import {
  CLIENT_PLUGIN_PACKAGES,
  defaultClientPlugins,
  hasViteConfig,
  REACT_REFRESH_EXCLUDE,
} from "./_client-plugins.ts";
import { withTempDir, writeFiles } from "./_test-utils.ts";

/** A package whose default export returns `{ name, options }`. */
function fakePlugin(name: string): Record<string, string> {
  const dir = path.join("node_modules", name);
  return {
    [path.join(dir, "package.json")]: JSON.stringify({
      name,
      type: "module",
      exports: { ".": { default: "./index.js" } },
    }),
    [path.join(dir, "index.js")]:
      `export default (options) => ({ name: ${JSON.stringify(name)}, options });\n`,
  };
}

const PROJECT = { "package.json": '{"type":"module"}', "client.tsx": "" };

describe("hasViteConfig", () => {
  test.each(["vite.config.ts", "vite.config.mjs", "vite.config.cjs"])("sees %s", async (name) => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { [name]: "export default {};" });
      expect(hasViteConfig(dir)).toBe(true);
    });
  });

  test("a directory with none has none", async () => {
    await withTempDir(async (dir) => {
      expect(hasViteConfig(dir)).toBe(false);
    });
  });
});

describe("defaultClientPlugins", () => {
  test("yields to a project's own vite.config.ts", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { ...PROJECT, "vite.config.ts": "export default {};" });
      expect(await defaultClientPlugins(dir)).toBeUndefined();
    });
  });

  test("loads React (with the refresh exclude) and Tailwind from the project", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, {
        ...PROJECT,
        ...fakePlugin(CLIENT_PLUGIN_PACKAGES.react),
        ...fakePlugin(CLIENT_PLUGIN_PACKAGES.tailwind),
      });
      expect(await defaultClientPlugins(dir)).toEqual([
        { name: "@vitejs/plugin-react", options: { exclude: REACT_REFRESH_EXCLUDE } },
        { name: "@tailwindcss/vite", options: undefined },
      ]);
    });
  });

  test("names every missing package, and how to fix it", async () => {
    await withTempDir(async (dir) => {
      await writeFiles(dir, { ...PROJECT, ...fakePlugin(CLIENT_PLUGIN_PACKAGES.react) });
      await expect(defaultClientPlugins(dir)).rejects.toMatchObject({
        code: "client_plugins_missing",
        message: expect.stringContaining("@tailwindcss/vite"),
        hint: expect.stringContaining("npm i -D @tailwindcss/vite"),
      });
    });
  });
});

describe("REACT_REFRESH_EXCLUDE", () => {
  test("covers node_modules, a linked package's dist/, and the mounting entry", () => {
    const excluded = (file: string) => REACT_REFRESH_EXCLUDE.some((re) => re.test(file));
    expect(excluded("/p/node_modules/react/index.js")).toBe(true);
    expect(excluded("/sdk/packages/aai-ui/dist/index.js")).toBe(true);
    expect(excluded("/p/client.tsx")).toBe(true);
    expect(excluded("/p/components/panel.tsx")).toBe(false);
  });
});
