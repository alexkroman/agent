---
"@alexkroman1/aai-runtime": patch
---

installStubFfmpeg on @alexkroman1/aai-runtime/testing/vitest scripts the child
the SDK's ffmpeg runners spawn, so a step that shells out to ffmpeg runs end to
end in a unit test with no binary; the SDK's ffmpegProcess seam is on
/host-internal for it
