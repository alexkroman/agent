// Copyright 2026 the AAI authors. MIT license.
/**
 * The declaration that shapes what a workflow pushes to a DEVICE, outside any
 * session.
 *
 * A device that holds `WS /inbox` open (a speaker, a kiosk) is told things by
 * a run long after the conversation that asked for them ended — a reminder, a
 * finished job, a failure. `stepNotifyClient` delivers; `stepSayOnClient`
 * speaks and delivers. What the device can PLAY is a property of the device
 * fleet, not of each announcement, so an app threading its playback rate
 * through every call (`stepSpeak(said, { sampleRate: NOTICE_SAMPLE_RATE })`,
 * eight copies in one app) was declaring an agent-level fact at the call site.
 *
 * Its own interface that `AgentDef` extends, for the reason every group in
 * `types.ts` is: that file is at the source-length cap, and the ONE rule this
 * group shares is that it touches no session — nothing here changes a voice
 * turn, and a workflow app may declare it too.
 */

/**
 * What an agent declares about the audio it pushes to devices over `WS /inbox`.
 *
 * @public
 */
export type ClientInboxOptions = {
  /**
   * Samples per second the devices play pushed audio at — the default
   * `stepSayOnClient` synthesizes at when a call names none. An integer from
   * 8000 to 48000. Omitted, speech is synthesized at `stepSpeak`'s own default
   * (24 kHz).
   *
   * Match the device's own output rate so it needs no resampler (an ESP32
   * speaker playing at 16 kHz declares `16_000`).
   */
  sampleRate?: number | undefined;
};

/**
 * The device-inbox half of an agent declaration — see this module's header.
 *
 * @public
 */
export interface AgentClientInbox {
  /**
   * Defaults for what a workflow pushes to a device over `WS /inbox`: today the
   * `sampleRate` `stepSayOnClient` speaks at. Serializable, and read by the
   * host that serves the inbox, so it holds for every run in the deployment.
   *
   * ```ts
   * import { agent } from "@alexkroman1/aai";
   *
   * export default agent({ name: "Speaker", clientInbox: { sampleRate: 16_000 } });
   * ```
   */
  clientInbox?: ClientInboxOptions | undefined;
}
