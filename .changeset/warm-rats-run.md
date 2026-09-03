---
"aai-studio-server": patch
---

Fix the studio's Connect GitHub button never becoming Sync: the connect flow went to the App's install page, which GitHub does not redirect back from once the App is installed, so the callback never ran. Connect now goes through /login/oauth/authorize, and the callback resolves the installation from the user token when the redirect names none.
