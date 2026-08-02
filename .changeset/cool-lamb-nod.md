---
"@alexkroman1/aai": patch
---

web_search now falls back to DuckDuckGo's lite endpoint when the primary HTML endpoint returns a bot-detection challenge or HTTP error, detects the anomaly interstitial as a challenge, and sends browser-like Accept headers
