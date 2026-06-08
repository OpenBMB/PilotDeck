Add-Type -AssemblyName System.Drawing

$iconsDir = Join-Path $PSScriptRoot "..\resources\icons"
$sourcePath = Join-Path $iconsDir "icon-source.png"
$outPng = Join-Path $iconsDir "icon.png"
$outIco = Join-Path $iconsDir "icon.ico"

$src = New-Object System.Drawing.Bitmap($sourcePath)
$w = $src.Width
$h = $src.Height

# Corner radius: ~18% of size (matches the SVG rx=92 on 512 viewBox)
$radius = [int]($w * 0.18)

Write-Host "Source: ${w}x${h}, radius=$radius"

# --- Helper: create a rounded-rect GraphicsPath ---
function New-RoundedRectPath([int]$width, [int]$height, [int]$r) {
    $path = New-Object System.Drawing.Drawing2D.GraphicsPath
    $d = $r * 2
    $path.AddArc(0, 0, $d, $d, 180, 90)
    $path.AddArc($width - $d, 0, $d, $d, 270, 90)
    $path.AddArc($width - $d, $height - $d, $d, $d, 0, 90)
    $path.AddArc(0, $height - $d, $d, $d, 90, 90)
    $path.CloseFigure()
    return $path
}

# --- Apply transparency mask to a bitmap ---
function Apply-RoundedMask([System.Drawing.Bitmap]$bmp) {
    $size = $bmp.Width
    $r = [int]($size * 0.18)
    $path = New-RoundedRectPath $size $size $r
    $region = New-Object System.Drawing.Region($path)

    $rect = New-Object System.Drawing.Rectangle(0, 0, $size, $size)
    $data = $bmp.LockBits($rect, [System.Drawing.Imaging.ImageLockMode]::ReadWrite,
                          [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $stride = $data.Stride
    $bytes = New-Object byte[] ($stride * $size)
    [System.Runtime.InteropServices.Marshal]::Copy($data.Scan0, $bytes, 0, $bytes.Length)

    $gfx = [System.Drawing.Graphics]::FromImage($bmp)

    for ($y = 0; $y -lt $size; $y++) {
        for ($x = 0; $x -lt $size; $x++) {
            if (-not $region.IsVisible($x, $y, $gfx)) {
                $idx = $y * $stride + $x * 4
                $bytes[$idx]   = 0  # B
                $bytes[$idx+1] = 0  # G
                $bytes[$idx+2] = 0  # R
                $bytes[$idx+3] = 0  # A
            }
        }
    }

    [System.Runtime.InteropServices.Marshal]::Copy($bytes, 0, $data.Scan0, $bytes.Length)
    $bmp.UnlockBits($data)
    $gfx.Dispose()
    $region.Dispose()
    $path.Dispose()
}

# --- Resize + mask ---
function Make-TransparentIcon([System.Drawing.Bitmap]$source, [int]$size) {
    $bmp = New-Object System.Drawing.Bitmap($size, $size, [System.Drawing.Imaging.PixelFormat]::Format32bppArgb)
    $bmp.SetResolution(96, 96)
    $gfx = [System.Drawing.Graphics]::FromImage($bmp)
    $gfx.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
    $gfx.SmoothingMode = [System.Drawing.Drawing2D.SmoothingMode]::HighQuality
    $gfx.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
    $gfx.CompositingQuality = [System.Drawing.Drawing2D.CompositingQuality]::HighQuality
    $gfx.Clear([System.Drawing.Color]::Transparent)
    $gfx.DrawImage($source, 0, 0, $size, $size)
    $gfx.Dispose()

    Apply-RoundedMask $bmp
    return $bmp
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

    # ICO header
    $bw.Write([uint16]0)              # reserved
    $bw.Write([uint16]1)              # type = ICO
    $bw.Write([uint16]$images.Count)  # image count

    # Calculate data offsets
    $headerSize = 6
    $dirSize = 16 * $images.Count
    $dataOffset = $headerSize + $dirSize

    # Directory entries
    for ($i = 0; $i -lt $images.Count; $i++) {
        $s = $sizes[$i]
        $pngBytes = $pngStreams[$i].ToArray()
        $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # width
        $bw.Write([byte]$(if ($s -ge 256) { 0 } else { $s }))  # height
        $bw.Write([byte]0)             # color palette
        $bw.Write([byte]0)             # reserved
        $bw.Write([uint16]1)           # color planes
        $bw.Write([uint16]32)          # bits per pixel
        $bw.Write([uint32]$pngBytes.Length)  # data size
        $bw.Write([uint32]$dataOffset)       # data offset
        $dataOffset += $pngBytes.Length
    }

    # Image data
    for ($i = 0; $i -lt $images.Count; $i++) {
        $bw.Write($pngStreams[$i].ToArray())
        $pngStreams[$i].Dispose()
    }

    $bw.Close()
    $fs.Close()
}

# --- Main ---
$sizes = @(256, 128, 64, 48, 32, 16)
$bitmaps = @()

foreach ($s in $sizes) {
    Write-Host "  Generating ${s}x${s}..."
    $bmp = Make-TransparentIcon $src $s
    $bitmaps += ,$bmp
}

# Save 256px as icon.png
$bitmaps[0].Save($outPng, [System.Drawing.Imaging.ImageFormat]::Png)
Write-Host "Wrote $outPng"

# Save ICO
Build-Ico $bitmaps $sizes $outIco
Write-Host "Wrote $outIco"

# Cleanup
foreach ($b in $bitmaps) { $b.Dispose() }
$src.Dispose()

Write-Host "Done!"
