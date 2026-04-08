# Scripts

## S2S Load Test

Drives realistic S2S voice sessions with TTS audio, tool calling, barge-in
simulation, connection retries, and network chaos via Toxiproxy.

### Prerequisites

```sh
brew install toxiproxy
```

The script automatically starts and stops `toxiproxy-server`.

### Usage

```sh
# Default launch-day simulation (5000 sessions, 2500 concurrent)
npx tsx scripts/s2s-load-test.ts

# Quick smoke test
npx tsx scripts/s2s-load-test.ts -n 2 -c 2 --rampMs 0 -v

# See all options
npx tsx scripts/s2s-load-test.ts --help
```

Requires `$ASSEMBLYAI_API_KEY` environment variable.

### Toxiproxy

Toxiproxy adds realistic network conditions to every session. Configurable via:

- `--toxicLatency` / `--toxicJitter` — added latency (default: 50ms +/- 20ms)
- `--toxicBandwidth` — bandwidth limit in KB/s (default: unlimited)
- `--toxicReset` — connection reset probability (default: 2.5%)
