---
"aai-server": minor
"aai-studio-server": minor
---

Remove the split-services deployment. There is now ONE Modal app (aai-server-web) serving both surfaces from the aai-studio-server entry. Deletes the aai-studio-web app, the STUDIO_UPSTREAM_URL reverse proxy (createStudioProxy/gracefulEventStream), the AAI_SERVICE=studio mode, and aai-server's own entry point — aai-server is now a library with no build. The split was never wired in production, so the combined branch was the only one that ever ran. isStudioPath moves to aai-server/studio-paths.ts. CI now deploys when EITHER server package version bumps, since the one app runs the studio entry.
