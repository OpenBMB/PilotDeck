# Keep every platform on the same icon pipeline; do not add a Windows-only plate.
& node (Join-Path $PSScriptRoot 'rebuild-icon.mjs')
exit $LASTEXITCODE
