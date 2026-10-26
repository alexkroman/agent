// Copyright 2026 the AAI authors. MIT license.
/**
 * The plugins are resolved from the PROJECT's `node_modules`, so each case
 * builds one: fake `@vitejs/plugin-react` / `@tailwindcss/vite` packages whose
 * factories record the options they were called with.
 */

import path from "node:path";
import { describe, expect } from "vitest";
import {
  CLIENT_ONLY_DEPENDENCIES,
  CLIENT_PLUGIN_PACKAGES,
  defaultClientPlugins,
  hasViteConfig,
  REACT_REFRESH_EXCLUDE,
} from "./_client-plugins.ts";
import { test, writeFiles } from "./_test-utils.ts";

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
  test.for(["vite.config.ts", "vite.config.mjs", "vite.config.cjs"])(
    "sees %s",
    async (name, { tmpDir: dir }) => {
      await writeFiles(dir, { [name]: "export default {};" });
      expect(hasViteConfig(dir)).toBe(true);
    },
  );

  test("a directory with none has none", async ({ tmpDir: dir }) => {
    expect(hasViteConfig(dir)).toBe(false);
  });
});

describe("defaultClientPlugins", () => {
  test("yields to a project's own vite.config.ts", async ({ tmpDir: dir }) => {
    await writeFiles(dir, { ...PROJECT, "vite.config.ts": "export default {};" });
    expect(await defaultClientPlugins(dir)).toBeUndefined();
  });

  test("loads React (with the refresh exclude) and Tailwind from the project", async ({
    tmpDir: dir,
  }) => {
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

  test("names every missing package, and how to fix it", async ({ tmpDir: dir }) => {
    await writeFiles(dir, { ...PROJECT, ...fakePlugin(CLIENT_PLUGIN_PACKAGES.react) });
    await expect(defaultClientPlugins(dir)).rejects.toMatchObject({
      code: "client_plugins_missing",
      message: expect.stringContaining("@tailwindcss/vite"),
      hint: expect.stringContaining("npm i -D @tailwindcss/vite"),
    });
  });

  test("the hint names everything `aai init` removed from a headless project, by field", async ({
    tmpDir: dir,
  }) => {
    // The failure this pins: the hint named the two plugins, and a project
    // that installed exactly those then failed on `@alexkroman1/aai-ui/styles.css`.
    await writeFiles(dir, PROJECT);
    const failure = await defaultClientPlugins(dir).catch((err: unknown) => err);
    const hint = (failure as { hint: string }).hint;
    expect(hint).toContain(`npm i ${CLIENT_ONLY_DEPENDENCIES.dependencies.join(" ")}`);
    expect(hint).toContain(`npm i -D ${CLIENT_ONLY_DEPENDENCIES.devDependencies.join(" ")}`);
    for (const name of [
      "@alexkroman1/aai-ui",
      "react",
      "react-dom",
      "tailwindcss",
      "@tailwindcss/vite",
      "@types/react",
      "@types/react-dom",
      "@vitejs/plugin-react",
    ]) {
      expect(hint).toContain(name);
    }
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
