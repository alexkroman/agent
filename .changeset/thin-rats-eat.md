---
"@alexkroman1/aai-cli": patch
---

aai pull merges the scaffold's package.json under the pulled workspace's own, so a pulled studio project installs the toolchain (vite, @vitejs/plugin-react, @tailwindcss/vite) its vite.config.ts imports instead of failing on the first aai dev.
