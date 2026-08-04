# DOCX Capability and Controlled Fallback Protocol

Read this file before deciding that the standard DOCX commands cannot perform a requested operation.

## 1. Discover, do not guess

Run:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" capabilities
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command create
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command edit
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" schema --command review
```

The live CLI output is authoritative. Examples in documentation are not a complete capability declaration.

When an operation is declared `supported`, use it. When it is `partial`, `unsupported`, or `blocked`, preserve that status and choose the next level deliberately.

## 2. Decision ladder

Use the lowest sufficient level:

1. **Standard command** — deterministic `create`, `edit`, `review`, or another bundled operation, writing an internal candidate.
2. **Auxiliary asset** — generate a chart, diagram, or other local image, then use a standard image block.
3. **Targeted OOXML patch** — modify an existing DOCX through `fallback-patch` with a narrow package-part allowlist.
4. **Full custom creation** — create a new DOCX through `fallback-create`; never use this to mutate a valuable existing package.
5. **Report unsupported or blocked** — required for signatures, document/write protection, rights management, unsafe packages, or fidelity that cannot be verified.

Do not jump from level 1 to an untracked Python builder. The inability to express one feature does not authorize reconstruction of an existing document.
Standard creation normalizes local raster assets, and standard editing supports
anchored inline image insertion before or after a paragraph. Use fallback only
when a material requirement needs unsupported floating/wrapping behavior.

Every successful fallback still produces only an internal candidate. It does
not authorize direct project-root output. Run acceptance, per-page visual QA,
preflight, and `deliver` exactly as for a standard command.
Fallbacks do not bypass the frozen document policy: an unrequested header,
footer, or page-number field in a new document fails preflight. Final delivery
also remains inside the frozen workspace unless the exact external path was
authorized during `prepare`.
For `fallback-patch`, the input path is resolved through the session version
chain before the controlled script runs. Use `--use-exact-input` only when the
current user explicitly requests an older/original editing base.

## 3. Targeted OOXML patch

The script contract is:

```bash
python patch.py --package-dir /temporary/unpacked/package
```

The script edits only that copy. The wrapper computes pre/post hashes, rejects changes outside the allowlist, repacks the package, validates relationships and XML, and writes a manifest.
The wrapper runs the script from its own directory with a safe environment
allowlist. When `PILOTDECK_WORK_DIR` is set, the script must be stored beneath
that directory. These controls reduce accidental workspace writes and secret
inheritance; operating-system sandboxing still depends on the host tool
permission model. A fallback script must use only its declared input argument
and local task assets, and must not access the network.

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fallback-patch \
  --input "$INPUT_DOCX" \
  --script "$WORKSPACE/tmp/patch.py" \
  --out "$CANDIDATE_DOCX" \
  --manifest "$WORKSPACE/qa/fallback-manifest.json" \
  --allow-part "word/document.xml" \
  --reason "The standard edit schema cannot update this field structure."
```

Add more `--allow-part` values only when required. Patterns use shell-style matching. Common narrow targets:

- `word/document.xml`
- `word/header*.xml`
- `word/footer*.xml`
- `word/settings.xml`
- `word/styles.xml`
- `word/numbering.xml`
- `word/_rels/*.rels`
- `[Content_Types].xml`

Macro, ActiveX, signature, and embedded-object parts are always forbidden. A script that changes nothing returns `partial`; a script that exceeds scope returns `blocked`.
At least one `--allow-part` is mandatory. Existing output paths are blocked unless the user explicitly authorizes `--overwrite`.

## 4. Full custom creation

The script contract is:

```bash
python create.py --out /temporary/candidate.docx
```

Run it only for a new document when the standard creator cannot express a material requirement:

```bash
bash "$DOCX_SKILL_ROOT/scripts/docx.sh" fallback-create \
  --script "$WORKSPACE/tmp/create.py" \
  --out "$CANDIDATE_DOCX" \
  --manifest "$WORKSPACE/qa/fallback-manifest.json" \
  --reason "The requested native diagram structure is outside the standard create schema."
```

The wrapper requires a new output path and a valid `.docx`, records script and output hashes, and writes a manifest. It never overwrites an existing document. The manifest does not prove visual quality; run inspect, compare where relevant, and preflight afterward.

## 5. Fallback manifest

Keep the manifest with internal QA artifacts. It records:

- protocol and fallback mode;
- reason and paths;
- script SHA-256;
- allowed and actually changed OOXML parts;
- script exit status and bounded stdout/stderr;
- output SHA-256 and validation result.

If a fallback fails, do not bypass the wrapper and rerun its script directly. Correct the script or its allowlist, or report the limitation.

## 6. Operations that stay blocked

Do not attempt controlled fallback for:

- editing a digitally signed document while claiming the signature remains valid;
- bypassing document/write protection or claiming its credentials were verified;
- macros, VBA, `.docm`, `.dotm`, or active content;
- rights-managed, encrypted, or password-protected content without an authorized compatible workflow;
- irreversible redaction without inspecting all visible text, images, links, embedded objects, and package parts;
- accepting/rejecting complex move or property revisions as though they were simple insertions/deletions;
- legal-grade comparison when Microsoft Word Compare or an approved equivalent is required.

Return `blocked` or `unsupported`, explain the missing fidelity, and preserve the source.
