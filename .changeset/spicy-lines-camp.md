---
---

Server-only: cache PBKDF2 API key verifications and bundle manifest/config decryption to avoid redoing ~100ms+15ms of work on every authenticated request.
