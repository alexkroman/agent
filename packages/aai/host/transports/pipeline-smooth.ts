// Copyright 2026 the AAI authors. MIT license.
/**
 * Text-only word-coalescing stream transform for the pipeline's `streamText`.
 *
 * Replaces the SDK's `smoothStream`, which buffers `reasoning-delta` parts as
 * well as text. That loses Anthropic thinking signatures: the signature
 * arrives as a `reasoning-delta` with empty text whose `providerMetadata`
 * carries `anthropic.signature`, and `smoothStream` only re-emits stored
 * metadata when flushing a non-empty buffer. With Claude's default
 * `display: "omitted"` thinking the reasoning text is always empty, so the
 * signature is dropped, and the mid-turn tool-call replay then sends a
 * signature-less reasoning part — the provider warns "unsupported reasoning
 * metadata" and drops the model's thinking between tool steps.
 *
 * This transform coalesces only `text-delta` parts into whole words (the TTS
 * feed is the sole reason chunking exists here) and passes every other part —
 * including all `reasoning-*` parts and their metadata — through untouched.
 */

import type { ProviderMetadata, StreamTextTransform, TextStreamPart, ToolSet } from "ai";

/** Word-boundary chunker — mirrors `smoothStream`'s `chunking: "word"`. */
const WORD_CHUNK = /\S+\s+/m;

/**
 * Create a `streamText` transform that coalesces text deltas into whole words
 * (no added latency) and leaves all non-text parts untouched.
 */
export function smoothTextStream<TOOLS extends ToolSet>(): StreamTextTransform<TOOLS> {
  return () => {
    let buffer = "";
    let id = "";
    let providerMetadata: ProviderMetadata | undefined;

    function flushBuffer(controller: TransformStreamDefaultController<TextStreamPart<TOOLS>>) {
      if (buffer.length > 0) {
        controller.enqueue({
          type: "text-delta",
          text: buffer,
          id,
          ...(providerMetadata !== undefined ? { providerMetadata } : {}),
        });
        buffer = "";
        providerMetadata = undefined;
      }
    }

    return new TransformStream<TextStreamPart<TOOLS>, TextStreamPart<TOOLS>>({
      transform(part, controller) {
        if (part.type !== "text-delta") {
          // Preserve ordering: emit any buffered text before the next part.
          flushBuffer(controller);
          controller.enqueue(part);
          return;
        }
        if (part.id !== id && buffer.length > 0) flushBuffer(controller);
        buffer += part.text;
        id = part.id;
        if (part.providerMetadata !== undefined) providerMetadata = part.providerMetadata;
        let match = WORD_CHUNK.exec(buffer);
        while (match !== null) {
          const chunk = buffer.slice(0, match.index) + match[0];
          controller.enqueue({ type: "text-delta", text: chunk, id });
          buffer = buffer.slice(chunk.length);
          match = WORD_CHUNK.exec(buffer);
        }
      },
      flush(controller) {
        flushBuffer(controller);
      },
    });
  };
}
