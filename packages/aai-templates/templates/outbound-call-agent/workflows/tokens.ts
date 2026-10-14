// Copyright 2026 the AAI authors. MIT license.
/**
 * The hook token the call's run parks on and the session's end signals.
 *
 * Two files have to derive it identically — `workflows/call.ts` waits on it,
 * `agent.ts`'s `onSessionEnd` answers it — and a template literal written
 * twice drifts once, silently: the only symptom is `signal()` answering
 * `false`, which is also what "nobody is waiting yet" looks like. Hence one
 * function, imported by both.
 *
 * Derived from the CALL id, which is the run's own input and unique per run,
 * so two runs can never claim one token.
 */
export function callEndedToken(callId: string): string {
  return `call-ended:${callId}`;
}
