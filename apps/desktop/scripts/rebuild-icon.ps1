Add-Type -AssemblyName System.Drawing

$iconsDir = Join-Path $PSScriptRoot "..\resources\icons"
$sourcePath = Join-Path $iconsDir "icon-source.png"
$outPng = Join-Path $iconsDir "icon.png"
$outIco = Join-Path $iconsDir "icon.ico"

$src = New-Object System.Drawing.Bitmap($sourcePath)
$w = $src.Width
$h = $src.Height
Write-Host "Source: ${w}x${h}"

# --- Flood-fill border white pixels with transparency on the ORIGINAL size image ---
function Remove-WhiteBorder([System.Drawing.Bitmap]$bmp) {
    $width = $bmp.Width
    $height = $bmp.Height
    $rect = New-Object System.Drawing.Rectangle(0, 0, $width, $height)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $totalBytes = $stride * $height
    $bytes = New-Object byte[] $totalBytes
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $totalBytes)

    $threshold = 180

    $visited = New-Object bool[] ($width * $height)
    $queue = New-Object System.Collections.Generic.Queue[int]

    for ($x = 0; $x -lt $width; $x++) {
        $queue.Enqueue($x)
        $queue.Enqueue(($height - 1) * $width + $x)
    }
    for ($y = 1; $y -lt ($height - 1); $y++) {
        $queue.Enqueue($y * $width)
        $queue.Enqueue($y * $width + $width - 1)
    }

    $cleared = 0
    while ($queue.Count -gt 0) {
        $pos = $queue.Dequeue()
        if ($pos -lt 0 -or $pos -ge ($width * $height)) { continue }
        if ($visited[$pos]) { continue }
        $visited[$pos] = $true

        $x = $pos % $width
        $y = [Math]::Floor($pos / $width)
        $idx = $y * $stride + $x * 4

        $b = $bytes[$idx]
        $g = $bytes[$idx + 1]
        $r = $bytes[$idx + 2]
        $a = $bytes[$idx + 3]

        if ($a -lt 128 -or $r -le $threshold -or $g -le $threshold -or $b -le $threshold) {
            continue
        }

        $bytes[$idx]     = 0
        $bytes[$idx + 1] = 0
        $bytes[$idx + 2] = 0
        $bytes[$idx + 3] = 0
        $cleared++

        if ($x -gt 0)            { $queue.Enqueue($pos - 1) }
        if ($x -lt $width - 1)   { $queue.Enqueue($pos + 1) }
        if ($y -gt 0)            { $queue.Enqueue($pos - $width) }
        if ($y -lt $height - 1)  { $queue.Enqueue($pos + $width) }
    }

    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $totalBytes)
    $bmp.UnlockBits($data)
    Write-Host "  Cleared $cleared border pixels on ${width}x${height}"
}

# --- Build ICO (PNG-embedded format) ---
function Build-Ico([System.Drawing.Bitmap[]]$images, [int[]]$sizes, [string]$outPath) {
    $pngStreams = @()
    foreach ($img in $images) {
        $ms = New-Object System.IO.MemoryStream
        $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
        $pngStreams += ,$ms
    }

    $fs = [System.IO.File]::Create($outPath)
    $bw = New-Object System.IO.BinaryWriter($fs)

    $bw.Write([uint16]0)
    $bw.Write([uint16]1)
    $bw.Write([uint16]$images.Count)

    $headerSize = 6
    $dirSize = 16 * $images.Count
    $dataOffset = $headerSize + $dirSize

    for ($i = 0; $i -lt $images.Count; $i++) {
        $s = $sizes[$i]
        $pngBytes = $pngStreams[$i].ToArray()
        $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
        $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
        $bw.Write([byte]0)
        $bw.Write([byte]0)
        $bw.Write([uint16]1)
        $bw.Write([uint16]32)
        $bw.Write([uint32]$pngBytes.Length)
        $bw.Write([uint32]$dataOffset)
        $dataOffset += $pngBytes.Length
    }

    for ($i = 0; $i -lt $images.Count; $i++) {
        $bw.Write($pngStreams[$i].ToArray())
        $pngStreams[$i].Dispose()
    }

    $bw.Close()
    $fs.Close()
}

# --- Step 1: Remove white border on the FULL-SIZE source first ---
Write-Host "Step 1: Removing white border from full-size source..."
$clean = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($clean)
$gfx.DrawImage($src, 0, 0, $w, $h)
$gfx.Dispose()
Remove-WhiteBorder $clean

# --- Step 2: Resize from the cleaned source ---
Write-Host "Step 2: Generating resized icons..."
$sizes = @(256, 128, 64, 48, 32, 16)
$bitmaps = @()

foreach ($s in $sizes) {
    $bmp = New-Object System.Drawing.Bitmap($s, $s, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($clean, 0, 0, $s, $s)
    $g.Dispose()
    Write-Host "  ${s}x${s} done"
    $bitmaps += ,$bmp
}

# --- Step 3: Save ---
$bitmaps[0].Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Wrote $outPng"

Build-Ico $bitmaps $sizes $outIco
Write-Host "Wrote $outIco"

foreach ($b in $bitmaps) { $b.Dispose() }
$clean.Dispose()
$src.Dispose()
Write-Host "Done!"
