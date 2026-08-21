---
"@alexkroman1/aai-cli": minor
---

Add the call-audit template: a workflow app with ffmpeg on both sides of the model. It levels any recording with a two-pass loudnorm, maps its pauses with silencedetect, cuts the transcription fan-out inside those pauses rather than every 90 seconds (so there is no segment overlap and no seam-stitching), and masters the spoken audit to MP3. transcription-workflow's classic flow now converts non-PCM recordings itself instead of telling the caller to run ffmpeg, so an m4a off a phone works.
