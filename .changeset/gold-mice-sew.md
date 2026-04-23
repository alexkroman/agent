---
"@alexkroman1/aai-cli": patch
---

Stop giget from dumping a stray '<owner>-<repo>' folder (alexkroman-agent) into the user's cwd during 'aai init'. Pass an explicit tmp 'dir' so the template tarball extracts outside the working directory.
