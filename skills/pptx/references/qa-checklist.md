# QA checklist

## Structural checks

- The PPTX opens as a valid OOXML package.
- Slide count and dimensions match the plan.
- All intended masters, layouts, images, charts, and relationships are present.
- No object extends beyond the slide canvas.
- No unresolved placeholder text remains.
- Template edits target only frame-map-approved objects.

Run `audit`. Treat errors as blockers. Treat overlap and text-fit warnings as mandatory inspection items.

## Visual checks

Render every slide at a consistent DPI. Inspect each full-size PNG for:

- Unexpected title or body wrapping.
- Cropped glyphs, substituted fonts, or missing characters.
- Unintended overlap and weak alignment.
- Stretched, blurry, or badly cropped images.
- Broken connector routing or objects hidden by layer order.
- Charts whose labels, legend, or values do not fit.
- Inconsistent page numbers, footers, margins, and color usage.

Use the montage to assess pacing, density, and visual consistency only after inspecting individual pages.

## Content checks

- Audience, objective, and takeaway remain clear.
- Each slide advances the narrative.
- Claims, quotations, and values are supported.
- Dates, units, terminology, and capitalization are consistent.
- Visible slide copy contains no production instructions.

## Compatibility checks

LibreOffice rendering is the automated baseline, not a guarantee of identical Microsoft PowerPoint rendering. For high-risk delivery, open a smoke-test copy in the target PowerPoint environment, especially when using uncommon fonts, animations, SmartArt, macros, or extended chart types.

## Delivery checks

- Rebuild the final PPTX from the retained `.mjs` or validated template map.
- Re-run `audit` and `render` after the final edit.
- Preserve source files and deliver a distinct output.
- Deliver only requested artifacts unless the user asks for builders or QA evidence.
