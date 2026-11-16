param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$Version, [Parameter(Mandatory)][string]$Revision)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'prepare-env.ps1')
$DesktopTarget = [IO.Path]::GetFullPath($Directory)
if (-not $DesktopTarget.StartsWith(($PSScriptRoot + '\.cache\'), [StringComparison]::OrdinalIgnoreCase)) { throw 'Dev backend must stay in the project cache' }
Push-Location (Join-Path $PSScriptRoot 'backend')
try {
  go build -trimpath -ldflags "-X main.appVersion=$Version -X main.buildRevision=$Revision" -o (Join-Path $DesktopTarget 'tinycherry-evostack-backend.exe') .
  if ($LASTEXITCODE -ne 0) { throw 'Dev backend compilation failed' }
} finally { Pop-Location }
