# QA checklist

## Structural checks

- The PPTX opens as a valid OOXML package.
- Slide count and dimensions match the plan.
- All intended masters, layouts, images, charts, and relationships are present.
- No object extends beyond the slide canvas.
- No unresolved placeholder text remains.
- Template edits target only frame-map-approved objects.

Run `audit`. Treat `failed` as blocking. Treat `passed_with_warnings` as an intermediate state only: inspect every warning, then fix it or add a hash-bound disposition with evidence. Do not convert every heuristic warning into a defect, but do not seal an unresolved warning.

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
- Critical entries in an applicable requirements file are present in the extracted slide text.

## Compatibility checks

LibreOffice rendering is the automated baseline, not a guarantee of identical Microsoft PowerPoint rendering. Chinese OOXML text may be intact even when the baseline substitutes or omits glyphs. Classify that result as a renderer warning and inspect the same artifact in target PowerPoint before calling it an artifact defect. For high-risk delivery, smoke-test uncommon fonts, animations, SmartArt, macros, and extended chart types in the target environment.

For a legacy `.ppt`, inspect both conversion montages, confirm equal page counts, and review any fidelity warning before using the converted `.pptx`. Disclose that macros, legacy animation, OLE objects, WordArt, media, editable chart data, and uncommon fonts are not guaranteed lossless.

## Delivery checks

- Use `deliver --builder` for the last net-new build or `deliver --input` for template output. Seal a reviewed candidate with `deliver --input candidate.pptx --out final.pptx`.
- Confirm the delivery report has one SHA-256 before and after audit and rendering.
- Confirm applicable requirements were auto-discovered or explicitly supplied and `coverage=passed`.
- Confirm `unresolvedWarnings=0` and every disposition matches the final SHA-256.
- Confirm `delivery.seal.status=passed`; never deliver a QA candidate.
- Do not edit or rebuild the PPTX after the final delivery report.
- Resolve or disposition every warning; include a concrete reason for accepted limitations.
- Preserve source files and deliver a distinct output.
- Deliver only requested artifacts unless the user asks for builders or QA evidence.
