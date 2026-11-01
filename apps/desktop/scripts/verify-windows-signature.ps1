param(
  [Parameter(Mandatory=$true)][string]$Path,
  [Parameter(Mandatory=$true)][string]$Thumbprint,
  [Parameter(Mandatory=$true)][string]$Publisher
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$signature = Get-AuthenticodeSignature -LiteralPath $Path
if ($signature.Status -ne 'Valid') { throw "Invalid Authenticode signature: $($signature.Status)" }
if ($signature.SignerCertificate.Thumbprint -ne $Thumbprint) { throw 'Unexpected signing certificate.' }
$commonName = $signature.SignerCertificate.GetNameInfo([System.Security.Cryptography.X509Certificates.X509NameType]::SimpleName, $false)
if ($commonName -cne $Publisher) { throw 'Unexpected publisher common name.' }
if (-not $signature.TimeStamperCertificate) { throw 'Trusted timestamp is missing.' }
[PSCustomObject]@{
  file = [System.IO.Path]::GetFullPath($Path)
  status = 'Valid'
  publisher = $commonName
  thumbprint = $signature.SignerCertificate.Thumbprint
  timestamp = $signature.TimeStamperCertificate.Subject
} | ConvertTo-Json -Compress
