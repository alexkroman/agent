---
"@alexkroman1/aai-ui": patch
---

Fix six accessibility and responsive defects in the built-in UI components found by a manual browser QA pass: keyboard focus was invisible on every Button and URL chip (outline-none with no replacement, WCAG 2.4.7), buttons had no hover state at all, SidebarLayout squeezed ChatView to an unreadable column on phones instead of stacking, the Controls footer overflowed the viewport below 330px, a long tool name pushed ToolCallRow's expand chevron out of its clipped container, and the neutral text steps are now derived from the theme so a dark ClientTheme no longer leaves labels, tool details and chips below contrast minimums.
