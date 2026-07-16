# Template following

## Safety model

Treat the supplied PPTX as both the visual specification and the editable object inventory. Copy source slides, then modify only named objects authorized by a validated frame map. Do not rebuild a visually similar slide from scratch when the source object can be inherited.

Animations, embedded audio/video, OLE objects, macros, SmartArt, extended charts, and complex content placed only on slide layouts are high risk. Preserve them untouched when possible. Stop if the requested edit requires unsafe structural changes.

## Inspect the entire source

Run `inspect` and `render` before planning. Review every slide, not only the pages selected for output. Record:

- Slide size, order, masters, layouts, theme fonts, and colors.
- Object names, IDs, types, bounds, and visible text.
- Reusable page families and content density.
- Footers, page markers, logos, and brand chrome.
- Risky objects that should remain untouched.

## Frame map schema

```json
{
  "version": 1,
  "source": "/absolute/path/template.pptx",
  "slides": [
    {
      "outputSlide": 1,
      "sourceSlide": 3,
      "editTargets": [
        { "name": "Title 1", "action": "replace-text" },
        { "name": "Hero Image", "action": "replace-image" }
      ]
    }
  ]
}
```

Allowed actions are `replace-text`, `replace-image`, `replace-table`, and `remove`. Prefer the exact object name emitted by `inspect`.

## Edit schema

```json
{
  "slides": [
    {
      "outputSlide": 1,
      "operations": [
        { "type": "text", "target": "Title 1", "value": "New audience-facing title" },
        { "type": "image", "target": "Hero Image", "path": "/absolute/path/hero.png" }
      ]
    }
  ]
}
```

Table operations use `rows`, where each row is an array or `{ "label": "row-1", "values": [...] }`. A remove operation needs only `type` and `target`.

Every operation must match an action in the frame map. The CLI rejects undeclared edits.

## Fidelity sequence

1. Build an unedited starter deck.
2. Render source and starter with the same DPI.
3. Run `fidelity` and inspect every differing page.
4. Apply edits only after unexplained starter differences are resolved.
5. Render and audit the edited output.

Pixel comparison is a signal, not a substitute for inspection. Font substitution and renderer differences can produce small legitimate deltas.
