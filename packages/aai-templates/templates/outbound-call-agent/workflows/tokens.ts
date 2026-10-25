// Copyright 2026 the AAI authors. MIT license.
/**
 * The hook token the call's run parks on and the session's end signals,
 * derived in one place from the CALL id — the run's own input and unique per
 * run, so two runs can never claim one token.
 */
export function callEndedToken(callId: string): string {
  return `call-ended:${callId}`;
}
