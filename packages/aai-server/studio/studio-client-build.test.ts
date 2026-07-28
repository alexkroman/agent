// Copyright 2025 the AAI authors. MIT license.

import { describe, expect, test } from "vitest";
import { buildWorkspaceClient } from "./studio-client-build.ts";

const CLIENT_TSX = `import "@alexkroman1/aai-ui/styles.css";
import { client } from "@alexkroman1/aai-ui";

export default client(() => <div className="grid gap-4 p-8 text-xl">Hello</div>);
`;

describe("buildWorkspaceClient", () => {
  test("returns no files when the workspace has no client.tsx", async () => {
    expect(await buildWorkspaceClient({ "agent.ts": "export default {}" })).toEqual({});
  });

  test("builds client.tsx into index.html plus hashed assets", async () => {
    const files = await buildWorkspaceClient({
      "agent.ts": "export default {}",
      "client.tsx": CLIENT_TSX,
    });
    expect(Object.keys(files)).toContain("index.html");
    const assets = Object.keys(files).filter((f) => f.startsWith("assets/"));
    expect(assets.some((f) => f.endsWith(".js"))).toBe(true);
    expect(assets.some((f) => f.endsWith(".css"))).toBe(true);
  }, 60_000);

  test("compiles Tailwind utilities used by the workspace client", async () => {
    const files = await buildWorkspaceClient({
      "agent.ts": "export default {}",
      "client.tsx": CLIENT_TSX,
    });
    const css = Object.entries(files).find(([f]) => f.endsWith(".css"))?.[1] ?? "";
    // A real Tailwind pass over the workspace source emits the utilities the
    // client actually uses. Shipping aai-ui's prebuilt CSS would not.
    expect(css).toMatch(/\.p-8/);
    expect(css).toMatch(/\.text-xl/);
  }, 60_000);

  test("ignores a vite.config.ts smuggled into the workspace", async () => {
    // Workspace files are untrusted and a Vite config is executable code.
    const files = await buildWorkspaceClient({
      "agent.ts": "export default {}",
      "client.tsx": CLIENT_TSX,
      "vite.config.ts": `throw new Error("workspace config executed");`,
    });
    expect(Object.keys(files)).toContain("index.html");
  }, 60_000);
});
