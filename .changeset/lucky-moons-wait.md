---
"@alexkroman1/aai-cli": patch
---

solo-rpg: a save taken while a roll was standing now resumes with the burn window still open. save_game is legal in `playing.rollResolved`, but load_game restored the flow to `playing.awaitingRoll` while `lastRoll` was still set, so burn_momentum refused a burn the campaign data allowed — and quoted an instruction telling the model to go and roll. The saved-data-to-position mapping is now one exhaustive function (`resumeStory`) beside the machine rather than a partial sequence in the tool.
