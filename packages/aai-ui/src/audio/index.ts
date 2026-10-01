// Copyright 2026 the AAI authors. MIT license.
/**
 * The browser audio layer's import surface for the rest of the package: the
 * {@link VoiceIO} a live call plays and captures through, and the pre-connect
 * capture that buffers the mic before the server names its rates.
 *
 * `capture.ts` (the grant checks and the capture node both halves share) is
 * private to this directory — guard-invariants rule 37 fails an import from
 * outside `audio/` that names any module but this one.
 *
 * The session core reaches this module only through a DYNAMIC `import()`
 * (`session/audio-setup.ts`, `session/preconnect.ts`), so it is a lazily
 * fetched chunk; a static VALUE import of it from session code would put it
 * back on the main bundle. Type imports are free.
 *
 * @module
 */

export { openPreConnectCapture, type PreConnectCapture } from "./preconnect.ts";
export { createVoiceIO, type VoiceIO, type VoiceIOOptions } from "./voice-io.ts";
