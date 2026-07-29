import "@alexkroman1/aai-ui/styles.css";
import {
  CAPTURE_WORKLET_MODULE_URL,
  client,
  createSyncSession,
  DEFAULT_SYNC_MIC_SAMPLE_RATE,
  floatToPcm16,
  type SyncTurnResult,
  useTheme,
} from "@alexkroman1/aai-ui";
import { useEffect, useRef, useState } from "react";

// Push-to-talk: recording runs exactly while the button is held, so there
// is no VAD — releasing the button endpoints the utterance. The clip goes
// out as one `POST /sync` request (sync STT → LLM translation → sync TTS)
// and the spoken translation plays from the response. No WebSocket.

const SYNC_URL = new URL("sync", globalThis.location.origin + globalThis.location.pathname).href;
const SAMPLE_RATE = DEFAULT_SYNC_MIC_SAMPLE_RATE;

/** Hold-to-record recorder built on the same WebRTC capture pipeline as
 *  sync mode's VAD microphone — `getUserMedia` voice processing feeding an
 *  AudioWorklet — minus the VAD: the button is the endpointing. */
type PttRecorder = {
  start(): Promise<void>;
  /** Stop and return everything recorded since `start()` as PCM16. */
  stop(): Promise<Int16Array>;
  close(): Promise<void>;
};

function createPttRecorder(): PttRecorder {
  let ctx: AudioContext | null = null;
  let stream: MediaStream | null = null;
  let node: AudioWorkletNode | null = null;
  let chunks: Float32Array[] = [];
  let recording = false;

  async function ensureOpen(): Promise<void> {
    if (ctx) return;
    const streamPromise = navigator.mediaDevices.getUserMedia({
      audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
    });
    const audioCtx = new AudioContext({ sampleRate: SAMPLE_RATE, latencyHint: "interactive" });
    try {
      const [media] = await Promise.all([
        streamPromise,
        audioCtx.resume(),
        audioCtx.audioWorklet.addModule(CAPTURE_WORKLET_MODULE_URL),
      ]);
      stream = media;
    } catch (err) {
      void streamPromise.then((s) => {
        for (const t of s.getTracks()) t.stop();
      });
      await audioCtx.close().catch(() => undefined);
      throw err;
    }
    const workletNode = new AudioWorkletNode(audioCtx, "aai-sync-capture", {
      channelCount: 1,
      channelCountMode: "explicit",
    });
    workletNode.port.onmessage = (e: MessageEvent) => {
      const data = e.data as { event?: string; samples?: Float32Array };
      if (recording && data.event === "chunk" && data.samples) chunks.push(data.samples);
    };
    audioCtx.createMediaStreamSource(stream).connect(workletNode);
    ctx = audioCtx;
    node = workletNode;
  }

  return {
    async start() {
      await ensureOpen();
      chunks = [];
      recording = true;
    },
    async stop() {
      // Give the worklet one beat to post the batch in flight; anything
      // still inside a partial batch (<~130ms) is dropped.
      await new Promise((r) => setTimeout(r, 150));
      recording = false;
      const total = chunks.reduce((n, c) => n + c.length, 0);
      const all = new Float32Array(total);
      let offset = 0;
      for (const c of chunks) {
        all.set(c, offset);
        offset += c.length;
      }
      chunks = [];
      return floatToPcm16(all);
    },
    async close() {
      recording = false;
      node?.disconnect();
      if (stream) for (const t of stream.getTracks()) t.stop();
      await ctx?.close().catch(() => undefined);
      ctx = null;
      node = null;
      stream = null;
    },
  };
}

type Exchange = { id: number; heard: string; translation: string };

function playTranslation(ctxRef: { current: AudioContext | null }, turn: SyncTurnResult): void {
  if (!(turn.pcm && turn.sampleRate)) return;
  ctxRef.current ??= new AudioContext();
  const ctx = ctxRef.current;
  const buffer = ctx.createBuffer(1, turn.pcm.length, turn.sampleRate);
  const channel = buffer.getChannelData(0);
  turn.pcm.forEach((sample, i) => {
    channel[i] = sample / 0x80_00;
  });
  const source = ctx.createBufferSource();
  source.buffer = buffer;
  source.connect(ctx.destination);
  source.start();
}

function TranslatorApp() {
  const theme = useTheme();
  const [exchanges, setExchanges] = useState<Exchange[]>([]);
  const [state, setState] = useState<"idle" | "recording" | "translating">("idle");
  const [error, setError] = useState<string | null>(null);
  const recorder = useRef<PttRecorder | null>(null);
  const playbackCtx = useRef<AudioContext | null>(null);

  const sessionRef = useRef(
    createSyncSession({
      url: SYNC_URL,
      onTurn: (turn) => {
        setExchanges((prev) => [
          { id: prev.length, heard: turn.transcript, translation: turn.reply },
          ...prev,
        ]);
        setState("idle");
        setError(turn.ttsError ? `TTS unavailable: ${turn.ttsError}` : null);
        playTranslation(playbackCtx, turn);
      },
      onError: (err) => {
        setState("idle");
        setError(err.message);
      },
    }),
  );

  useEffect(
    () => () => {
      void recorder.current?.close();
      void playbackCtx.current?.close();
    },
    [],
  );

  async function pressStart(): Promise<void> {
    if (state !== "idle") return;
    try {
      recorder.current ??= createPttRecorder();
      await recorder.current.start();
      setState("recording");
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }

  async function pressEnd(): Promise<void> {
    if (state !== "recording" || !recorder.current) return;
    setState("translating");
    const pcm = await recorder.current.stop();
    // Sub-quarter-second presses are button fumbles, not speech.
    if (pcm.length < SAMPLE_RATE / 4) {
      setState("idle");
      return;
    }
    sessionRef.current.sendPcm16(pcm, SAMPLE_RATE).catch(() => {
      // surfaced via onError
    });
  }

  const label =
    state === "recording"
      ? "Listening… release to translate"
      : state === "translating"
        ? "Translating…"
        : "Hold to talk";

  return (
    <div
      className="flex flex-col h-screen max-w-2xl mx-auto"
      style={{ background: theme.bg, color: theme.text }}
    >
      <header className="px-4 py-3 border-b shrink-0" style={{ borderColor: theme.border }}>
        <h1 className="font-bold">Push-to-Talk Translator</h1>
        <p className="text-xs opacity-60">English ⇄ Spanish — one HTTP request per phrase</p>
      </header>

      <main className="flex-1 overflow-y-auto px-4 py-3 space-y-3">
        {exchanges.length === 0 && (
          <p className="opacity-60 text-sm">
            Hold the button, say something in English or Spanish, and release.
          </p>
        )}
        {exchanges.map((ex) => (
          <div
            key={ex.id}
            className="rounded-lg border px-3 py-2 text-sm space-y-1"
            style={{ borderColor: theme.border, background: theme.surface }}
          >
            <p className="opacity-60">{ex.heard}</p>
            <p className="font-medium">{ex.translation}</p>
          </div>
        ))}
        {error && (
          <p className="text-sm" style={{ color: "#dc2626" }}>
            {error}
          </p>
        )}
      </main>

      <footer className="p-4 shrink-0 flex justify-center">
        <button
          type="button"
          className="rounded-full px-8 py-4 font-medium select-none touch-none"
          style={{
            background: state === "recording" ? "#dc2626" : theme.primary,
            color: "#fff",
            opacity: state === "translating" ? 0.6 : 1,
          }}
          onPointerDown={() => void pressStart()}
          onPointerUp={() => void pressEnd()}
          onPointerLeave={() => void pressEnd()}
        >
          {label}
        </button>
      </footer>
    </div>
  );
}

client({ component: TranslatorApp });
