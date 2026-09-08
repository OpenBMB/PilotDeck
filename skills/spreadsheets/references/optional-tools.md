# Optional spreadsheet tools

The CLI commands below provide mechanical facts, transformations, images, and safe delivery. They do not replace task-specific construction or the model's judgment. Review commands are independent options, not a required sequence.

Resolve the entry point as shown in `SKILL.md` before using them.

## Validate

Check package structure and report formula caches, error values, compatibility features, and delimited-file consistency:

```bash
bash "$SHEET" validate --input "$CANDIDATE" --out "$WORKSPACE/review/validation.json"
```

The default report summarizes findings and includes bounded samples. Add `--details` only when formula-level records would help. Findings describe the workbook; only malformed or unsafe file operations are command failures.

## Recalculate formula caches

Use once on a final XLSX candidate when formulas or their dependencies changed and cached values matter:

```bash
bash "$SHEET" recalculate --input "$CANDIDATE" --out "$RECALCULATED" --report "$WORKSPACE/review/recalculation.json"
```

The command requires a new `--out` path, runs LibreOffice only on a temporary copy, keeps the original formula and package structure, and merges calculated caches by worksheet and cell address. If any formula is known to be incompatible or any result cannot be merged safely, it returns `unsupported` without emitting a candidate so dependent caches cannot be polluted. Do not retry `unsupported` or `blocked` results with a risky round-trip option.

If recalculation is used with `validate` or `render`, run those later checks against the recalculated candidate.

## Render

Render through LibreOffice and produce full-size page images:

```bash
bash "$SHEET" render --input "$CANDIDATE" --out-dir "$WORKSPACE/review/rendered"
```

Use `--pdf "$WORKSPACE/review/rendered.pdf"` to keep an explicit PDF path. Open the relevant images before making visual claims.

## Compare

Report package, worksheet, formula, and cell-fact differences after a template or package-sensitive edit:

```bash
bash "$SHEET" compare --before "$INPUT" --after "$CANDIDATE" --out "$WORKSPACE/review/comparison.json"
```

The report does not decide whether a difference was requested or acceptable.

## Convert legacy XLS

Convert a legacy `.xls` source to an internal `.xlsx` candidate before editing:

```bash
bash "$SHEET" convert-legacy --input "$INPUT_XLS" --out "$WORKSPACE/tmp/converted.xlsx"
```

Conversion can change unsupported legacy behavior. Preserve the source and review the result.
