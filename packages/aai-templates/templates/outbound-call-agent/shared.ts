// Copyright 2026 the AAI authors. MIT license.
/**
 * What the session knows about the call that the transcript does not say.
 *
 * `end_call` writes here when it hangs up on a voicemail greeting, and
 * `onSessionEnd` reads it back as the call ends — a fact the session
 * established, handed to the run beside the transcript rather than guessed
 * from the write-up afterwards. One slot, declared once, so the tool that
 * writes it and the hook that reads it cannot disagree about its key.
 */

import { sessionSlot } from "@alexkroman1/aai";

/** Whether the call reached an answering machine rather than a person. */
export const voicemailSlot = sessionSlot("voicemail", false);
