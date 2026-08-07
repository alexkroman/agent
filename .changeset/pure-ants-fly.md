---
"@alexkroman1/aai": patch
---

Put max_turn_silence back to 3500 and the default gateway model back to gpt-5.5. The 2500 ceiling was the one number in the endpointing pair with no measurement of its own — it was reasoned from a run where the minimum and maximum moved together, which cannot apportion the damage between them; 1600/3500 is the pair with a measured 0.68 on two independent runs. The ordering it protected still holds at 3500, with more margin over the false-interruption window.
