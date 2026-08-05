// Kokoro TTS loader for the load-test harnesses.
//
// kokoro-js is deliberately NOT a devDependency. It drags in
// @huggingface/transformers + onnxruntime (~480MB installed, a quarter of
// node_modules) to serve two scripts that never run in CI, so it is an
// install-on-demand tool instead:
//
//   pnpm add -Dw kokoro-js
//
// Absent, `await import` fails with a bare ERR_MODULE_NOT_FOUND naming a
// package that is missing on purpose — hence the hint below. The specifier is
// typed `string` so tsc does not try to resolve a normally-absent package:
// scripts/ sits outside the turbo typecheck graph today, and this keeps it
// clean if that ever changes.

import { createRequire } from "node:module";

const KOKORO: string = "kokoro-js";

/** The Kokoro model the load tests synthesize with. */
const KOKORO_MODEL = "onnx-community/Kokoro-82M-v1.0-ONNX";

const INSTALL_HINT = [
  "kokoro-js is not installed — the load tests need it to synthesize audio.",
  "",
  "  pnpm add -Dw kokoro-js",
  "",
  "It is not a checked-in devDependency because it pulls in",
  "@huggingface/transformers + onnxruntime (~480MB) that nothing else uses.",
].join("\n");

type KokoroModule = {
  KokoroTTS: {
    // `voices_path` is supported at runtime but absent from the shipped types,
    // so the options bag stays loose rather than needing a @ts-expect-error.
    from_pretrained(model: string, opts: Record<string, unknown>): Promise<unknown>;
  };
};

/**
 * Load Kokoro and return a ready TTS handle, or throw with an install hint.
 *
 * Returns `unknown` because the real types ship with the optional package and
 * cannot be referenced from here — callers cast to their own local `TTS` shape.
 */
export async function loadKokoroTts(): Promise<unknown> {
  let mod: KokoroModule;
  try {
    mod = (await import(KOKORO)) as KokoroModule;
  } catch (err) {
    if (err instanceof Error && "code" in err && err.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(INSTALL_HINT, { cause: err });
    }
    throw err;
  }
  const require = createRequire(import.meta.url);
  const voicesPath = require.resolve(KOKORO).replace(/dist.*/, "voices/");
  return mod.KokoroTTS.from_pretrained(KOKORO_MODEL, {
    dtype: "q8",
    device: "cpu",
    voices_path: voicesPath,
  });
}
