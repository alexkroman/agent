---
"@alexkroman1/aai-runtime": patch
---

Fix a guest dialling itself for every platform call under the local microVM backend: split the URL a third party dials (AAI_PUBLIC_BASE_URL) from the URL the guest dials (AAI_PLATFORM_BASE_URL), which resolvePlatformQueue now reads.
