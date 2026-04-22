# Integration Test Fixtures

## hello-how-are-you.pcm16

Required by `pipeline-reference.integration.test.ts`. A ~2-second monoaural
16 kHz signed 16-bit little-endian PCM file of a voice saying "hello, how
are you?" (or any similar short question the LLM can respond to).

### Generating it

Easiest: record yourself via the macOS Terminal using `sox`:

```sh
sox -d -r 16000 -c 1 -b 16 -e signed-integer hello-how-are-you.pcm16 trim 0 2
```

Or export from a DAW as raw PCM16 mono @ 16 kHz.

Or use a CLI TTS to synthesize it (e.g. the same Cartesia voice we use at
runtime, piped through `ffmpeg -ar 16000 -ac 1 -f s16le`):

```sh
# sketch — adjust to your preferred TTS
curl -X POST https://api.cartesia.ai/tts/bytes ... \
  | ffmpeg -i pipe:0 -ar 16000 -ac 1 -f s16le hello-how-are-you.pcm16
```

### Why it's not checked in

Audio fixtures are binary blobs — we keep them out of the repo. Contributors
with API keys + local fixtures can run the integration test; CI should
provide both as secrets and generate/restore the fixture from a secure
artifact store before the integration job runs.

### Running the test

```sh
export ASSEMBLYAI_API_KEY=...
export OPENAI_API_KEY=...
export CARTESIA_API_KEY=...
VITEST_PROFILE=integration \
  VITEST_INCLUDE='host/integration/**/*.integration.test.ts' \
  pnpm --filter @alexkroman1/aai exec vitest run \
    -c ../../vitest.slow.config.ts
```

If the fixture is missing, the test throws a clear error pointing here. If
any of the env vars are missing, the whole suite is skipped via
`describe.skipIf`.
