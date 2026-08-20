---
"@alexkroman1/aai": minor
---

Add `@alexkroman1/aai/ffmpeg`: run ffmpeg from a step with a bounded, abortable child (`runFfmpeg`), read a file's streams with `probeMedia`, and convert anything to linear-PCM WAV with `transcodeToWav`. Guest sandboxes now ship the ffmpeg binary, so a workflow can transcode and probe media in-pipeline instead of asking the caller to do it first.
