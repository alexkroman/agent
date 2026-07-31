---
"aai-server": patch
---

Remove the legacy PBKDF2 credential-verify fallback and the orphaned base64url helpers; credential hashes are argon2id only. Secrets are stored in Supabase Vault with no app-layer encryption; stale comments claiming AES-GCM/HKDF encryption are corrected.
