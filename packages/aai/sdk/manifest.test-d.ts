// Copyright 2025 the AAI authors. MIT license.
import { expectTypeOf, test } from "vitest";
import type { Manifest } from "./manifest.ts";
import type { S2sProvider } from "./providers.ts";

test("Manifest.stt/llm/tts are optional", () => {
  expectTypeOf<Manifest["stt"]>().toBeNullable();
  expectTypeOf<Manifest["llm"]>().toBeNullable();
  expectTypeOf<Manifest["tts"]>().toBeNullable();
});

test("Manifest.s2s is optional and typed as S2sProvider", () => {
  expectTypeOf<Manifest["s2s"]>().toEqualTypeOf<S2sProvider | undefined>();
});

test("parseManifest return includes mode", () => {
  type Parsed = ReturnType<typeof import("./manifest.ts").parseManifest>;
  expectTypeOf<Parsed["mode"]>().toEqualTypeOf<"s2s" | "pipeline">();
});
