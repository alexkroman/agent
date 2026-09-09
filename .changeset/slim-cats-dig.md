---
"aai-server": patch
---

The guest harness's Publish output carries the phone webhook URLs `aai deploy` now prints, one line per declared carrier with `?carrier=` filled in. Publish is the path most users take, so without this the URLs were printed only by a bare `aai deploy` that almost nobody types. The harness is baked into the sandbox image, so this needs a deploy to reach anyone.
