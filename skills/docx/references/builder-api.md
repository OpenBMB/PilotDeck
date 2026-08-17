# DOCX builder API

Use a builder when creating a new document or making an ordinary edit that can safely pass through `python-docx`.

## Contract

The builder defines one function:

```python
from docxlib.builder import BuildContext


def build(context: BuildContext) -> None:
    # Choose the locale from the document's language.
    document = context.new_document(locale="zh-CN")
    # Build with python-docx and the helpers below.
    context.save(document)
```

For an existing document:

```python
def build(context: BuildContext) -> None:
    document = context.load_document()
    # Make localized changes and preserve the established styles.
    context.save(document)
```

`build` executes in an isolated subprocess. The wrapper supplies the input and temporary output, validates the DOCX, and atomically promotes it to the internal candidate path. Do not parse command-line arguments or choose another output path inside the builder.

## Available helpers

```python
from docxlib.builder import (
    BuildContext,
    add_field,
    add_image,
    add_table,
    add_toc,
    apply_neutral_styles,
    replace_text,
)
```

- `context.new_document(locale=...)` creates a document with restrained locale-aware styles; choose the locale from the content.
- `context.load_document()` loads the supplied input after mutation-safety checks.
- `context.save(document)` writes the candidate expected by the wrapper.
- `add_table(document, headers, rows, widths=None, repeat_header=True)` creates a simple real Word table.
- `add_image(document, path, width_inches=5.8, caption=None, alt_text=None)` inserts a centered local image.
- `add_field(paragraph, instruction, placeholder="")` inserts a Word field such as `PAGE`, `DATE`, or `TOC`. Cached values may remain stale until the user updates fields in Microsoft Word; do not invent cached page numbers.
- `add_toc(document, paragraph, levels=(1, 3), placeholder=...)` inserts a real, hyperlinked Word TOC field and requests a field refresh when the document opens. It does not choose placement or fabricate cached entries.
- `replace_text(document, match, replacement)` replaces matches across adjacent runs and returns the number changed.
- `apply_neutral_styles(document, locale=..., ...)` can initialize neutral styles on a document created outside the context helper.

The builder may use the complete `python-docx` API. Prefer semantic styles, real lists, normal paragraphs, sections, tables, and fields over visual imitations.

## Useful patterns

```python
document.add_heading("Recommendation", level=1)
document.add_paragraph("Proceed after the final review.")

for item in ["Confirm owner", "Confirm date"]:
    document.add_paragraph(item, style="List Bullet")
```

```python
document.add_heading("Contents", level=1)
add_toc(document, document.add_paragraph())
```

```python
table = add_table(
    document,
    ["Workstream", "Owner", "Status"],
    [["Security review", "Security", "Complete"]],
    widths=[3, 2, 1],
)
```

Use `docx.oxml` for a small missing helper when the package is newly created. For an existing package with charts, diagrams, embeddings, content controls, or nonstandard custom XML, use `fallback-patch` rather than reconstructing it through `python-docx`.

Keep builder code focused on the current document. If a helper becomes repeatedly useful across unrelated tasks, add it to the bundled builder module rather than growing each task script.
