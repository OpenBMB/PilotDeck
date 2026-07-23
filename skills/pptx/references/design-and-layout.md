# Design and layout

## Choose a visual route

Use one visual source only:

1. A user-supplied PPTX or reference deck.
2. Explicit user art direction.
3. The PilotDeck core layout library when neither exists.

Do not mix the default library into a supplied template.

## Core layout library

Read `assets/layout-library/template-registry.json`, shortlist layouts by `useWhen`, `slots`, and `densityBudget`, then inspect only the relevant exports in `assets/layout-library/layouts/core.mjs`.

Available exports:

- `titleSlide`, `sectionSlide`, `statementSlide`
- `splitSlide`, `twoColumnSlide`
- `metricSlide`, `comparisonSlide`, `timelineSlide`
- `chartSlide`, `tableSlide`, `quoteSlide`, `closingSlide`

Treat these as composition scaffolds, not mandatory styling. Preserve margins, hierarchy, and density while adapting content.

## Presentation-native design

Favor flat editorial composition over UI panels. Avoid repeated cards, pills, buttons, navigation bars, and dense dashboards unless the subject is explicitly a product interface.

Maintain equal outer margins by default. Use alignment, whitespace, scale, and one accent color to create hierarchy. Vary slide silhouettes without introducing a different visual language on every page.

Use at most one primary visual on a standard content slide. Avoid decorative charts, unlabelled icons, and low-value diagrams.

## Typography and fit

Keep titles on one line. Shorten text before shrinking it. Resolve the appropriate typography profile from `typography-and-fonts.md`; use presentation density for projection and report density only for desktop-reading deliverables. Check Chinese and mixed-language wrapping in the rendered PNG and treat LibreOffice font substitution separately from target-PowerPoint compatibility.

## Images

Select the intended crop before placing the image. Do not stretch images. Keep important faces, labels, and product UI away from crop edges. Do not reuse the same non-background image on multiple slides by default.
