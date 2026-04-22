// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import type { Manifest } from "./manifest.ts";

test("Manifest.stt/llm/tts are optional", () => {
  expectTypeOf<Manifest["stt"]>().toBeNullable();
  expectTypeOf<Manifest["llm"]>().toBeNullable();
  expectTypeOf<Manifest["tts"]>().toBeNullable();
});

test("parseManifest return includes mode", () => {
  type Parsed = ReturnType<typeof import("./manifest.ts").parseManifest>;
  expectTypeOf<Parsed["mode"]>().toEqualTypeOf<"s2s" | "pipeline">();
});
