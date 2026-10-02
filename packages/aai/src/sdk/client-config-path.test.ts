// Copyright 2026 the AAI authors. MIT license.
import { describe, expect, test } from "vitest";
import { CLIENT_CONFIG_PATH as REEXPORTED_PATH } from "./client-config.ts";
import { CLIENT_CONFIG_METHODS, CLIENT_CONFIG_PATH } from "./client-config-path.ts";

describe("client-config path", () => {
  test("is RELATIVE, so it resolves under an agent's base URL", () => {
    expect(CLIENT_CONFIG_PATH.startsWith("/")).toBe(false);
    expect(new URL(CLIENT_CONFIG_PATH, "https://agents.example/my-agent/").pathname).toBe(
      "/my-agent/client-config",
    );
  });

  test("is answered on GET alone", () => {
    expect(CLIENT_CONFIG_METHODS).toEqual(["GET"]);
  });

  test("is re-exported unchanged by the schema module", () => {
    expect(REEXPORTED_PATH).toBe(CLIENT_CONFIG_PATH);
  });
});
