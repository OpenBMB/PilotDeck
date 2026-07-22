# Typography and fonts

## Precedence

Choose typography in this order:

1. Explicit user or brand direction.
2. Theme fonts inherited from a supplied PPTX.
3. A target-platform profile requested by the user.
4. A PilotDeck cross-platform profile inferred from the content language.

Never replace a supplied template font merely because a PilotDeck default exists.

## Profiles

Resolve layout tokens before creating a net-new deck:

```js
const tokens = await resolveDesignTokens({
  lang: 'zh-CN',
  profile: 'cross-platform-zh',
  density: 'presentation',
});
const pptx = await createDeck({ lang: 'zh-CN', tokens });
```

Available profiles:

- `cross-platform-en`: Arial for broad macOS and Windows compatibility.
- `office-en`: Aptos for a known modern Microsoft Office audience.
- `cross-platform-zh`: Arial as the logical Latin face with conservative Chinese fallback space.
- `windows-zh`: Microsoft YaHei for a Windows-only target.
- `macos-zh`: PingFang SC for a macOS-only target.
- `libreoffice-zh`: Noto Sans CJK SC only when that font is installed in the rendering environment.

PowerPoint does not accept a CSS-style font stack. A profile is a Harness resolution policy, not a comma-separated font name written into the PPTX.

There is no Chinese font that can be assumed to be installed on every macOS and Windows system. Cross-platform defaults target readable, stable substitution rather than pixel-identical output. Require a shared licensed or embeddable font when identical typography is mandatory.

## Default sizes for a 16:9 deck

| Element | Presentation | Dense report |
|---|---:|---:|
| Cover title | 32–44 pt | 28–34 pt |
| Section title | 28–34 pt | 24–30 pt |
| Slide title | 24–30 pt | 22–26 pt |
| Body | 16–20 pt | 14–17 pt |
| Chart labels | 11–14 pt | 10–12 pt |
| Table body | 12–15 pt | 10–12 pt |
| Footnote or source | 9–11 pt | 9–10 pt |

Use the `presentation` density for projection and the `report` density for desktop reading. Do not shrink ordinary body copy below the dense-report range merely to silence a fit warning.

## Chinese and mixed-language layout safety

- Use a line-height factor of roughly 1.2–1.35 for Chinese body copy.
- Reserve 10–15% vertical capacity for cross-platform font substitution.
- Keep slide titles to one line when possible and no more than two lines.
- Give Chinese tables more row height than equivalent English tables.
- Use one Chinese family and one Latin family at most unless a brand system requires more.
- Keep chart numerals and percentages consistent; Arial is a safe Latin choice.
- Set the presentation language to `zh-CN` for simplified-Chinese content.

## Compatibility interpretation

Treat Microsoft PowerPoint as the target viewer. LibreOffice rendering is an automated baseline. If the PPTX contains intact Chinese OOXML text but LibreOffice substitutes or omits glyphs, report a renderer compatibility warning and smoke-test the same artifact in target PowerPoint. Do not rewrite a valid deck solely to make the LibreOffice baseline look identical.
