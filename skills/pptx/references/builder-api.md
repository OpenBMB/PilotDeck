# Builder API

Use one plain JavaScript ES module for each candidate revision. Export one async function. The runtime owns dependency loading, input and output paths, validation, and candidate promotion.

## New presentations

Return a PptxGenJS presentation:

```js
export default async function build({ createDeck, pptxgenjs, imageSizingCrop }) {
  const pptx = await createDeck({
    title: 'Example',
    lang: 'zh-CN',
    headFontFace: 'Arial',
    bodyFontFace: 'Arial',
  });
  const slide = pptx.addSlide();
  slide.addText('A useful conclusion', {
    objectName: 'Slide Title',
    x: 0.8, y: 0.6, w: 11.7, h: 0.6,
    fontFace: 'Arial',
    fontSize: 28,
    bold: true,
    margin: 0,
  });
  return pptx;
}
```

Toolkit members include:

- `createDeck(options)` for a wide editable presentation with optional language, font, and metadata choices.
- The complete `pptxgenjs` package for slide authoring.
- `imageSizingCrop(...)` and `imageSizingContain(...)` are async. Await their result before spreading it into `slide.addImage()`, for example: `slide.addImage({ ...(await imageSizingCrop(path, x, y, w, h)), altText: '...' })`.
- `inputPath`, which is set when `build --input` is used.

`createDeck` does not choose a palette or slide composition. The starter builder is deliberately minimal; replace its content and composition rather than treating it as a template.

## Template inheritance and existing PPTX files

Scaffold with `--input source.pptx` to start from a builder that preserves the source slides, then build with the same input. Use `createTemplatePresentation()` inside the builder:

```js
export default async function build({ createTemplatePresentation }) {
  const template = await createTemplatePresentation();

  template.addSlide(3, (slide) => {
    slide.modifyElement('Title 1', [
      template.ModifyTextHelper.setText('Updated audience-facing title'),
    ]);

    slide.generate((canvas, pptxgenjs) => {
      canvas.addChart(pptxgenjs.ChartType.bar, [{
        name: 'Results', labels: ['A', 'B'], values: [12, 6],
      }], { x: 1, y: 1.6, w: 5, h: 3 });
      canvas.addTable([
        ['Metric', 'Value'],
        ['A', '12'],
        ['B', '6'],
      ], { x: 6.5, y: 1.6, w: 4.5, h: 2.2 });
    });
  });

  template.addSlide(7);
  template.setNotes(1, '[Sources]\n- source.pptx');
  return template;
}
```

The returned object exposes the underlying `presentation`, `automizer`, `ModifyTextHelper`, `ModifyImageHelper`, and `modify` APIs. `slide.generate()` supports editable PptxGenJS text, shapes, images, charts, and tables while the copied slide keeps its source master and layout. `template.setNotes(outputSlideNumber, text)` adds or replaces speaker notes by final output position. Use pptx-automizer directly for capabilities beyond the convenience methods.

Use `template.loadMedia(imagePath)` before replacing an image. Refer to object names from `inspect` output. Select, reorder, or repeat source slides according to the request; there is no frame-map schema or fixed action list.

Preserve charts, diagrams, media, OLE objects, animations, and complex master content when the requested change does not require touching them. If neither the builder nor the controlled fallback can express an edit safely, report the limitation instead of rebuilding the whole source deck or hiding replacement objects over inaccessible content.

## Controlled package fallback

When the standard APIs cannot express an important edit, write a local JavaScript patch instead of running an untracked ZIP rewrite. Read the temporary package directory from `PPTX_PACKAGE_DIR`; the wrapper also includes it in the command for traceability:

```bash
node patch.mjs --package-dir /temporary/unpacked/pptx
```

A minimal patch starts like this:

```js
import fs from 'node:fs';
import path from 'node:path';

const packageDir = process.env.PPTX_PACKAGE_DIR;
if (!packageDir) throw new Error('PPTX_PACKAGE_DIR is required');

// Inspect and modify only the package parts needed for this task.
const slidePath = path.join(packageDir, 'ppt/slides/slide1.xml');
const slideXml = fs.readFileSync(slidePath, 'utf8');
fs.writeFileSync(slidePath, slideXml);
```

Run it only through the wrapper:

```bash
bash "$PPTX" fallback-patch \
  --input "$INPUT_OR_CANDIDATE" \
  --script "$WORKSPACE/tmp/patch.mjs" \
  --out "$WORKSPACE/tmp/patched-candidate.pptx" \
  --report "$WORKSPACE/tmp/fallback-report.json"
```

The script may inspect and modify the temporary package according to the task. The wrapper preserves the input, records added, changed, and deleted parts, repacks the result, and promotes it to an internal candidate. Review that candidate and publish it through `deliver`; do not run the patch directly or copy its output into the project.

## Builder discipline

- Keep the builder under `PILOTDECK_WORK_DIR` and rerun it through `pptx.sh build`.
- Do not choose or write the final path inside the builder.
- Give important objects stable `objectName` values when future edits are likely.
- Keep source materials separate from the output candidate.
- Use native editable PowerPoint objects when practical; prepared SVG or raster assets are appropriate for complex visuals.
