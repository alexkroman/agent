// Copyright 2026 the AAI authors. MIT license.
// The the boot sweep's resumable-run half case list, run against the memory reference on its own.
//
// `conformance.test.ts` runs every list against every unit-tier arm through
// `journalConformance`; this file is the list's co-located claim, so a case
// that stops holding on the REFERENCE fails beside the module that states it.

import { createMemoryJournal } from "./backends/memory.ts";
import { type JournalArm, journalIds } from "./conformance-cases.ts";
import { journalResumeConformance } from "./conformance-resume.ts";

const store = createMemoryJournal();

const arm: JournalArm = {
  label: "memory (resume list)",
  // ONE store across every case, as every arm uses: a fresh one per case would
  // hide a case that leaks state.
  journal: () => store,
  uid: journalIds("mem-resume"),
  resumable: true,
};

journalResumeConformance(arm);
