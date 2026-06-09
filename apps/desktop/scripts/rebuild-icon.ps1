Add-Type -AssemblyName System.Drawing

$iconsDir = Join-Path $PSScriptRoot "..\resources\icons"
$sourcePath = Join-Path $iconsDir "icon-source.png"
$outPng = Join-Path $iconsDir "icon.png"
$outIco = Join-Path $iconsDir "icon.ico"
$outInstallerIco = Join-Path $iconsDir "installer-icon.ico"

$src = New-Object System.Drawing.Bitmap($sourcePath)
$w = $src.Width
$h = $src.Height
Write-Host "Source: ${w}x${h}"

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

# Build ICO using BMP-based entries (maximum compatibility with NSIS & .NET)
function Build-Ico([System.Drawing.Bitmap[]]$images, [int[]]$sizes, [string]$outPath) {
    $fs = [System.IO.File]::Create($outPath)
    $bw = New-Object System.IO.BinaryWriter($fs)

    $count = $images.Count
    # ICO header
    $bw.Write([uint16]0)        # reserved
    $bw.Write([uint16]1)        # type = ICO
    $bw.Write([uint16]$count)   # image count

    # Pre-build image data (BITMAPINFOHEADER + BGRA pixels + AND mask)
    $imgDataList = New-Object System.Collections.ArrayList

    foreach ($img in $images) {
        $s = $img.Width
        $ms = New-Object System.IO.MemoryStream
        $ibw = New-Object System.IO.BinaryWriter($ms)

        # BITMAPINFOHEADER (40 bytes)
        $ibw.Write([uint32]40)       # biSize
        $ibw.Write([int32]$s)        # biWidth
        $ibw.Write([int32]($s * 2))  # biHeight (doubled for ICO: XOR + AND)
        $ibw.Write([uint16]1)        # biPlanes
        $ibw.Write([uint16]32)       # biBitCount
        $ibw.Write([uint32]0)        # biCompression = BI_RGB
        $ibw.Write([uint32]0)        # biSizeImage (can be 0 for BI_RGB)
        $ibw.Write([int32]0)         # biXPelsPerMeter
        $ibw.Write([int32]0)         # biYPelsPerMeter
        $ibw.Write([uint32]0)        # biClrUsed
        $ibw.Write([uint32]0)        # biClrImportant

        # XOR data: BGRA, bottom-to-top row order
        $rect = New-Object System.Drawing.Rectangle(0, 0, $s, $s)
        $data = $img.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadOnly,
                              [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
        $stride = $data.Stride
        $bytes = New-Object byte[] ($stride * $s)
        [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)
        $img.UnlockBits($data)

        # Write rows bottom-to-top
        for ($row = $s - 1; $row -ge 0; $row--) {
            $offset = $row * $stride
            $ibw.Write($bytes, $offset, $s * 4)
        }

        # AND mask: 1 bit per pixel, bottom-to-top, rows padded to 4 bytes
        $andRowBytes = [Math]::Ceiling($s / 8.0)
        $andRowPadded = [Math]::Ceiling($andRowBytes / 4.0) * 4
        $andRow = New-Object byte[] $andRowPadded

        for ($row = $s - 1; $row -ge 0; $row--) {
            # Clear
            for ($i = 0; $i -lt $andRowPadded; $i++) { $andRow[$i] = 0 }
            for ($col = 0; $col -lt $s; $col++) {
                $offset = $row * $stride + $col * 4
                $alpha = $bytes[$offset + 3]
                if ($alpha -lt 128) {
                    # Transparent: set AND bit to 1
                    $byteIdx = [Math]::Floor($col / 8)
                    $bitIdx = 7 - ($col % 8)
                    $andRow[$byteIdx] = $andRow[$byteIdx] -bor (1 -shl $bitIdx)
                }
            }
            $ibw.Write($andRow)
        }

        $ibw.Flush()
        [void]$imgDataList.Add($ms.ToArray())
        $ibw.Close()
        $ms.Close()
    }

    # Directory entries
    $headerSize = 6
    $dirSize = 16 * $count
    $dataOffset = $headerSize + $dirSize

    for ($i = 0; $i -lt $count; $i++) {
        $s = $sizes[$i]
        $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
        $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))
        $bw.Write([byte]0)       # color palette
        $bw.Write([byte]0)       # reserved
        $bw.Write([uint16]1)     # color planes
        $bw.Write([uint16]32)    # bits per pixel
        $imgBytes = $imgDataList[$i]
        $bw.Write([uint32]$imgBytes.Length)
        $bw.Write([uint32]$dataOffset)
        $dataOffset += $imgBytes.Length
    }

    # Image data
    for ($i = 0; $i -lt $count; $i++) {
        $bw.Write([byte[]]$imgDataList[$i])
    }

    $bw.Close()
    $fs.Close()
}

function Resize-Clean([System.Drawing.Bitmap]$source, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $g = [System.Drawing.Graphics]::FromImage($bmp)
    $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $g.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $g.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $g.CompositingMode = [System.Drawing.Drawing2D.CompositingMode]::SourceCopy
    $g.Clear([System.Drawing.Color]::Transparent)
    $g.DrawImage($source, 0, 0, $size, $size)
    $g.Dispose()
    return $bmp
}

# --- Step 1: Remove white border on the FULL-SIZE source ---
Write-Host "Step 1: Removing white border from full-size source..."
$clean = New-Object System.Drawing.Bitmap($w, $h, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
$gfx = [System.Drawing.Graphics]::FromImage($clean)
$gfx.DrawImage($src, 0, 0, $w, $h)
$gfx.Dispose()
Remove-WhiteBorder $clean

# --- Step 2: Generate all sizes ---
Write-Host "Step 2: Generating resized icons..."
$appSizes = @(256, 128, 64, 48, 32, 16)
$appBitmaps = @()
foreach ($s in $appSizes) {
    $bmp = Resize-Clean $clean $s
    Write-Host "  ${s}x${s} done"
    $appBitmaps += ,$bmp
}

# Save 256px as icon.png
$appBitmaps[0].Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Wrote $outPng"

# Save app icon.ico
Build-Ico $appBitmaps $appSizes $outIco
Write-Host "Wrote $outIco"

# Save installer-icon.ico (48, 32, 16)
$installerSizes = @(48, 32, 16)
$installerBitmaps = @()
foreach ($s in $installerSizes) {
    $installerBitmaps += ,(Resize-Clean $clean $s)
}
Build-Ico $installerBitmaps $installerSizes $outInstallerIco
Write-Host "Wrote $outInstallerIco"

foreach ($b in $installerBitmaps) { $b.Dispose() }
foreach ($b in $appBitmaps) { $b.Dispose() }
$clean.Dispose()
$src.Dispose()
Write-Host "Done!"
