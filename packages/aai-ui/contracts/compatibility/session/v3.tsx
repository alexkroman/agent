// Copyright 2026 the AAI authors. MIT license.
/**
 * Frozen authoring example: `aai-ui:session` epoch 3.
 *
 * See `../client/v1.tsx` for what "frozen" obliges and why the imports are
 * relative.
 *
 * Epoch 3 REMOVED `SessionCoreOptions`. It was an exact alias of
 * `VoiceSessionOptions` with one referent — `createSessionCore`'s parameter,
 * which names `VoiceSessionOptions` directly now — and `client()` never took
 * it. Epoch 2 (`./v2.tsx`) is retained and compiles unchanged; epoch 1 is
 * DROPPED, because its example annotated a value with the removed alias, which
 * is exactly what "the epoch 1 authoring style no longer compiles" means.
 *
 * This file is epoch 1's headless client, rewritten the way epoch 3 spells it.
 */

import {
  createSessionCore,
  type SessionCore,
  type SessionSnapshot,
  type VoiceSessionOptions,
  type WebSocketConstructor,
} from "../../../index.ts";

/** One options type, named once. */
export function headless(WebSocketImpl: WebSocketConstructor): {
  core: SessionCore;
  detach: () => void;
} {
  const options: VoiceSessionOptions = {
    platformUrl: "https://agents.example.com/support",
    WebSocket: WebSocketImpl,
  };
  const core = createSessionCore(options);
  const detach = core.subscribe(() => {
    const snapshot: SessionSnapshot = core.getSnapshot();
    if (snapshot.running && !snapshot.recording) core.start();
  });
  core.connect({ signal: AbortSignal.timeout(30_000) });
  return { core, detach };
}

/** The options may also be written inline — the parameter type is the contract. */
export function quick(): SessionCore {
  return createSessionCore({ platformUrl: "https://agents.example.com/support" });
}
