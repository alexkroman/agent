// Copyright 2026 the AAI authors. MIT license.
/**
 * Silero VAD in the browser — finding where nobody is speaking.
 *
 * Separate from `chunker.ts` (which decides where to CUT, and is a pure
 * function) because this half is all environment: a WASM runtime, a 1.7 MB
 * model, and a page whose CSP has opinions about both. Keeping them apart is
 * also what lets a VAD that will not load degrade to fixed windows instead of
 * failing the upload — see {@link speechRegions}'s return of `undefined`.
 *
 * **Every asset is IMPORTED, never fetched from a CDN, and that is forced from
 * two directions.** `AGENT_CSP` is `connect-src 'self' wss: ws:`, so a jsDelivr
 * URL is blocked outright; and the platform routes only `/:slug/assets/*`, so a
 * file dropped in `public/` resolves under `aai dev` (Vite serves the project
 * root) and 404s the moment it is deployed. A `?url` import is the one form
 * that satisfies both: Vite emits the file into `assets/` and hands back its
 * hashed path.
 *
 * The cost is real and worth stating: ~14.7 MB of assets, mostly the ONNX
 * runtime. They are fetched once and then cached `immutable` by the platform's
 * asset route.
 */

import { NonRealTimeVAD } from "@ricky0123/vad-web";
// `NonRealTimeVAD` runs `SileroLegacy` — it does NOT read the v5 model, whatever
// `silero_vad_v5.onnx` sitting beside it in the package suggests. Pointing this
// at v5 loads a graph the wrapper cannot drive.
import modelUrl from "@ricky0123/vad-web/dist/silero_vad_legacy.onnx?url";
// Exported at the package ROOT rather than under `dist/` — onnxruntime-web's
// `exports` map lists each runtime file by bare name, and a `./dist/…` path is
// refused outright ("is not exported under the conditions …").
import wasmMjsUrl from "onnxruntime-web/ort-wasm-simd-threaded.mjs?url";
import wasmUrl from "onnxruntime-web/ort-wasm-simd-threaded.wasm?url";
import type { Span } from "./chunker.ts";

/**
 * The model is loaded once per page, not once per file.
 *
 * ~14.7 MB and a WASM instantiation; a second recording must not pay it again.
 * Held as the PROMISE so two overlapping picks join one load rather than
 * starting two.
 */
let vadPromise: Promise<NonRealTimeVAD> | undefined;

function loadVad(): Promise<NonRealTimeVAD> {
  vadPromise ??= NonRealTimeVAD.new({
    modelURL: modelUrl,
    ortConfig: (ort) => {
      // The runtime's own files, by exact URL rather than a base path: Vite
      // hashes emitted asset names, so no prefix could find them.
      ort.env.wasm.wasmPaths = { wasm: wasmUrl, mjs: wasmMjsUrl };
      // No cross-origin isolation on an agent page (no COOP/COEP headers), so
      // `SharedArrayBuffer` is unavailable and a threaded runtime cannot start.
      // Saying so outright beats letting ORT probe, fail, and fall back.
      ort.env.wasm.numThreads = 1;
    },
  }).catch((cause: unknown) => {
    // Let the next attempt retry rather than pinning the failure for the life
    // of the page — a transient asset fetch is the likeliest cause.
    vadPromise = undefined;
    throw cause;
  });
  return vadPromise;
}

/**
 * Find the spans of `samples` that contain speech.
 *
 * @param samples 16 kHz mono float samples — the rate the page already
 *   resamples to, so the VAD does no conversion of its own.
 * @param sampleRate Rate of `samples`, for converting the VAD's millisecond
 *   answers back into sample indices.
 * @returns Ascending, non-overlapping spans, or `undefined` when the VAD could
 *   not run at all. `undefined` is a real answer rather than an error: the
 *   caller falls back to fixed windows, which is what this template did before
 *   and costs only transcript quality at the seams.
 */
export async function speechRegions(
  samples: Float32Array,
  sampleRate: number,
): Promise<Span[] | undefined> {
  let vad: NonRealTimeVAD;
  try {
    vad = await loadVad();
  } catch (err) {
    console.warn("Speech detection unavailable; falling back to fixed chunks.", err);
    return;
  }

  const regions: Span[] = [];
  try {
    for await (const segment of vad.run(samples, sampleRate)) {
      regions.push({
        start: Math.round((segment.start / 1000) * sampleRate),
        end: Math.round((segment.end / 1000) * sampleRate),
      });
    }
  } catch (err) {
    // A model that loaded can still fail on a particular input. Same answer.
    console.warn("Speech detection failed; falling back to fixed chunks.", err);
    return;
  }
  return regions;
}
