---
"@alexkroman1/aai": patch
---

The default prompt's mis-hearing ladder now orders its retries: a spelled value is sent exactly as spelled before any variant (a spelled run covering two words is split where the heard words split), and only after that fails are the letter confusions tried — starting with a letter the caller says is wrong. A letter heard the same way twice is no longer treated as proof, since speech-to-text repeats the same mis-hearing; digits heard the same way twice stay fixed.
