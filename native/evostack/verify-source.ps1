param([Parameter(Mandatory)][ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision)
$ErrorActionPreference = 'Stop'
$DesktopRepo = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '../..')).Path
Push-Location $DesktopRepo
try {
 $DesktopIdentity = & node scripts/desktop/candidate.mjs identity | ConvertFrom-Json
 if ($LASTEXITCODE -ne 0 -or $DesktopIdentity.revision -cne $ExpectedRevision) { throw 'Expected clean tracked source and no untracked build inputs at ExpectedRevision' }
} finally { Pop-Location }
