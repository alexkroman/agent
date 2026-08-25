---
---

Add the guest sandbox image as an OCI recipe — `packages/aai-server/guest-image.Dockerfile`,
built by `pnpm build:guest-image` and published to GHCR by the new Guest image
workflow — so one image can be pulled by every sandbox backend instead of being
reachable only through Modal. Modal spawns resolve it when
`GUEST_IMAGE_REGISTRY` is set; unset (the default, including production) the
server still builds and publishes its own Modal snapshot image.
