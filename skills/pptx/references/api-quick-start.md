# API quick start

## Builder contract

Create a plain ES module that exports one async function and returns a PptxGenJS presentation:

```js
export default async function build({ createDeck, layouts, tokens, pptxgenjs, imageSizingCrop }) {
  const pptx = await createDeck({ title: 'Example deck' });

  layouts.titleSlide(pptx, tokens, {
    eyebrow: 'Example',
    title: 'A clear title',
    subtitle: 'One sentence of useful context.',
    meta: 'Team · 2026',
  });

  layouts.chartSlide(pptx, tokens, {
    title: 'Adoption increased in every segment',
    type: pptx.ChartType.bar,
    series: [{ name: 'Adoption', labels: ['A', 'B', 'C'], values: [42, 57, 71] }],
    takeaway: 'Segment C leads by 14 points.',
    source: 'Source: verified internal data',
    page: 2,
  });

  return pptx;
}
```

Run it through the skill so package resolution remains independent of the current project:

```bash
bash "$PPTX" build --builder deck.mjs --out deck.pptx
```

## Toolkit members

- `createDeck(options)`: create a themed wide-screen presentation.
- `layouts`: the 12 PilotDeck core layout functions.
- `tokens`: canvas, palette, typography, and spacing values.
- `pptxgenjs`: the PptxGenJS constructor and enum holder; access `pptx.ShapeType` and `pptx.ChartType` from the created instance when possible.
- `imageSizingCrop(path, x, y, w, h)`: prepare a centered crop.
- `imageSizingContain(path, x, y, w, h)`: fit an image without distortion.

## Object naming

Set PptxGenJS `objectName` for meaningful elements. Use stable names such as `Slide Title`, `Primary Chart`, `Hero Image`, and `Page Number`. Template frame maps address objects by the names exposed in `inspect` output.

## Useful commands

```bash
bash "$PPTX" scaffold --out deck.mjs
bash "$PPTX" build --builder deck.mjs --out deck.pptx --verify --qa-dir qa
bash "$PPTX" inspect --input deck.pptx --out manifest.json
bash "$PPTX" audit --input deck.pptx --out audit.json
bash "$PPTX" render --input deck.pptx --out-dir slides --montage montage.png
```
