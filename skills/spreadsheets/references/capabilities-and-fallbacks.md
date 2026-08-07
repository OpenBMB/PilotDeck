# Spreadsheet capabilities and controlled fallback

Read this file when the standard builder and helpers cannot express an important requested feature.

## Inspect capabilities when needed

Run:

```bash
bash "$SHEET" capabilities
bash "$SHEET" schema --command native-chart
bash "$SHEET" schema --command image
```

Use the concise capability report first and query a schema only for the feature you need. Treat `unsupported` and `blocked` as evidence to reconsider the implementation or report a limitation, not as permission to silently change the request.

## Decision ladder

Use the lowest sufficient level:

1. Standard builder plus bundled helpers.
2. A standard native chart or normalized local raster image.
3. A companion workbook that leaves a package-sensitive source untouched.
4. `fallback-patch` with a narrow XLSX package-part allowlist.
5. Report `unsupported` or `blocked`.

Do not switch to `openpyxl`, `xlsxwriter`, a raw ZIP rewrite, or an untracked script. The inability to express one chart or drawing does not authorize reconstructing an existing workbook.

## Existing workbook safety

Generic ExcelJS round trips are unsafe when inspection reports charts, drawings, pivots, slicers, external links, connections, query tables, embeddings, ActiveX, macros, or signatures. Prefer read-only analysis or a companion workbook. `--allow-risky-roundtrip` requires current, explicit user acceptance of the listed losses.

Never mutate signed, macro-enabled, ActiveX, encrypted, or embedded-content workbooks through fallback. Preserve the source and report the limitation.

## Controlled package patch

The fallback script contract is:

```bash
node patch.mjs --package-dir /temporary/unpacked/xlsx
```

Run it only through the wrapper:

```bash
bash "$SHEET" fallback-patch \
  --input "$WORKSPACE/tmp/candidate.xlsx" \
  --script "$WORKSPACE/tmp/patch.mjs" \
  --out "$WORKSPACE/tmp/patched-candidate.xlsx" \
  --manifest "$WORKSPACE/tmp/fallback-manifest.json" \
  --reason "The standard native-chart helper cannot create the requested object." \
  --allow-part "xl/charts/chart*.xml" \
  --allow-part "xl/drawings/drawing*.xml" \
  --allow-part "xl/drawings/_rels/*.rels"
```

The wrapper:

- unpacks a temporary copy and rejects unsafe archive paths;
- runs a local JavaScript module with a bounded environment, timeout, stdout, and stderr;
- hashes every package part before and after the script;
- rejects changes outside the explicit allowlist;
- rejects macro, ActiveX, signature, and embedded-object parts;
- repacks and validates worksheet/drawing/chart relationships;
- records the script hash, changed parts, output hash, and validation in a manifest.

A no-op returns `partial`. An allowlist escape returns `blocked`. Correct the script or scope; never rerun the script outside the wrapper.

The wrapper reduces accidental writes and inherited secrets but is not an operating-system network sandbox. The script must use only its package directory and task-local assets.

Every successful fallback still produces an internal candidate. Recalculate when applicable, run `review`, add task-specific evaluation when needed, and deliver the reviewed candidate normally.

## Capability boundaries

- Standard native charts: line, column, and bar.
- Standard raster images: local PNG, JPEG, WebP, and TIFF normalized to PNG.
- Scatter, area, combo, pie, and doughnut charts: fallback until declared supported by `capabilities`.
- Pivot tables, Power Query, external connections, and data models: preserve the source; prefer a companion workbook.
- `.xlsm`, VBA, ActiveX, signatures, encryption, and unverified protection: blocked.

Do not use an image to satisfy a native-chart requirement. Do not call a fallback feature “supported”; report that a controlled fallback was used.
