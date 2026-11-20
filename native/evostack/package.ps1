param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$ExpectedManifestHash)
$ErrorActionPreference = 'Stop'
$DesktopSource = (Resolve-Path -LiteralPath $Directory).Path
Push-Location (Resolve-Path (Join-Path $PSScriptRoot '../..'))
try {
  node scripts/desktop/candidate.mjs validate $DesktopSource
  if ($LASTEXITCODE -ne 0) { throw 'Candidate validation failed; packaging did not run' }
  # Use the Windows BCL directly, without optional PowerShell archive modules.
  [void][System.Reflection.Assembly]::Load('System.IO.Compression, Version=4.0.0.0, Culture=neutral, PublicKeyToken=b77a5c561934e089')
  $DesktopSha = [System.Security.Cryptography.SHA256]::Create()
  function Get-DesktopBufferHash([byte[]]$Buffer) {
    return [BitConverter]::ToString($DesktopSha.ComputeHash($Buffer)).Replace('-', '').ToLowerInvariant()
  }
  $DesktopManifestBytes = [System.IO.File]::ReadAllBytes((Join-Path $DesktopSource 'candidate.json'))
  if ((Get-DesktopBufferHash $DesktopManifestBytes) -ne $ExpectedManifestHash) { throw 'Verified manifest changed before packaging' }
  $DesktopManifest = [System.Text.Encoding]::UTF8.GetString($DesktopManifestBytes) | ConvertFrom-Json
  $DesktopZip = Join-Path $PSScriptRoot ('dist/TinyCherry-win-x64-' + [Guid]::NewGuid().ToString('N') + '.zip')
  $DesktopOutput = [System.IO.File]::Open($DesktopZip, [System.IO.FileMode]::CreateNew)
  $DesktopArchive = $null
  $DesktopFinished = $false
  try {
    $DesktopArchive = [System.IO.Compression.ZipArchive]::new($DesktopOutput, [System.IO.Compression.ZipArchiveMode]::Create, $true)
    # Hash and archive the same buffers; a modified product file cannot slip in
    # between a preflight hash and a second filesystem read by an archiver.
    foreach ($DesktopFile in $DesktopManifest.files) {
      $DesktopBytes = [System.IO.File]::ReadAllBytes((Join-Path $DesktopSource $DesktopFile.name))
      if ($DesktopBytes.Length -ne $DesktopFile.bytes -or (Get-DesktopBufferHash $DesktopBytes) -ne $DesktopFile.sha256) { throw "Product file changed: $($DesktopFile.name)" }
      $DesktopEntry = $DesktopArchive.CreateEntry($DesktopFile.name)
      $DesktopStream = $DesktopEntry.Open()
      try { $DesktopStream.Write($DesktopBytes, 0, $DesktopBytes.Length) } finally { $DesktopStream.Dispose() }
    }
    $DesktopStream = $DesktopArchive.CreateEntry('candidate.json').Open()
    try { $DesktopStream.Write($DesktopManifestBytes, 0, $DesktopManifestBytes.Length) } finally { $DesktopStream.Dispose() }
    $DesktopFinished = $true
  } finally {
    if ($DesktopArchive) { $DesktopArchive.Dispose() }
    $DesktopOutput.Dispose()
    $DesktopSha.Dispose()
    if (-not $DesktopFinished -and [System.IO.File]::Exists($DesktopZip)) { [System.IO.File]::Delete($DesktopZip) }
  }
  Write-Output "Packaged verified bytes: $DesktopZip"
} finally { Pop-Location }
