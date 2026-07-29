---
"aai-server": patch
---

Fix S3 key listing: the stock unstorage s3 driver's getKeys ignores the prefix and reads only the first ListObjects page (1000 keys), so studio projects vanished from the picker once the production bucket grew past 1000 objects, and the KV wipe on agent delete stopped short. Production storage now overrides getKeys with a signed ListObjectsV2 loop that passes the prefix and follows continuation tokens.
