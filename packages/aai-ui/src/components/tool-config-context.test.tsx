// Copyright 2026 the AAI authors. MIT license.

/** @jsxImportSource react */

/**
 * `ToolConfigContext` — the per-tool display config `mountClient()` installs
 * and the tool-call block reads. The default is an EMPTY config, so a tree
 * with no provider renders every tool under its raw name rather than failing.
 */

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { ToolConfigContext, type ToolDisplayConfig, useToolConfig } from "./tool-config-context.ts";

function Probe() {
  return <>{JSON.stringify(useToolConfig())}</>;
}

describe("useToolConfig", () => {
  test("is empty with no provider", () => {
    expect(renderToStaticMarkup(<Probe />)).toBe("{}");
  });

  test("reads the nearest provider's config", () => {
    const config: ToolDisplayConfig = { web_search: { icon: "🔎", label: "Searching" } };
    const html = renderToStaticMarkup(
      <ToolConfigContext.Provider value={config}>
        <Probe />
      </ToolConfigContext.Provider>,
    );
    expect(JSON.parse(html.replaceAll("&quot;", '"'))).toEqual(config);
  });
});
