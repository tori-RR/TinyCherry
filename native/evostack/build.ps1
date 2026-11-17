param([ValidatePattern('^[0-9a-f]{40}$')][string]$ExpectedRevision)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'prepare-env.ps1')
$DesktopRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Invoke-DesktopStep([scriptblock]$Action) {
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "Desktop build failed: $LASTEXITCODE" }
}
Push-Location $DesktopRepo
try {
  if ($ExpectedRevision) { & (Join-Path $PSScriptRoot 'verify-source.ps1') -ExpectedRevision $ExpectedRevision }
  & (Join-Path $PSScriptRoot 'check-webview2.ps1')
  $DesktopIdentity = & node scripts/desktop/candidate.mjs identity | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Could not identify build inputs' }
  $env:EVOSTACK_APP_VERSION = $DesktopIdentity.version
  $env:EVOSTACK_BUILD_REVISION = $DesktopIdentity.revision
  $DesktopCandidateName = [Guid]::NewGuid().ToString('N')
  $DesktopCandidate = Join-Path $PSScriptRoot ('dist\candidates\' + $DesktopCandidateName)
  New-Item -ItemType Directory -Path $DesktopCandidate -Force | Out-Null
  $DesktopHelper = & node scripts/desktop/helper.mjs
  if ($LASTEXITCODE -ne 0) { throw 'Pinned computer helper is missing' }
  Invoke-DesktopStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/generate-contract.ts }
  Invoke-DesktopStep { pnpm exec tsc --noEmit -p tsconfig.web.json --composite false }
  Invoke-DesktopStep { pnpm exec tsc --noEmit -p tsconfig.tauri.json --composite false }
  Invoke-DesktopStep { pnpm exec vite build --config native/evostack/vite.config.mts }
  Push-Location (Join-Path $PSScriptRoot 'backend')
  try {
    $DesktopFlags = "-s -w -X main.appVersion=$($DesktopIdentity.version) -X main.buildRevision=$($DesktopIdentity.revision)"
    Invoke-DesktopStep { go build -trimpath -ldflags $DesktopFlags -o (Join-Path $DesktopCandidate 'tinycherry-evostack-backend.exe') . }
  } finally { Pop-Location }
  Invoke-DesktopStep { cargo build --release --locked --manifest-path native/evostack/src-tauri/Cargo.toml }
  Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\tinycherry-evostack.exe') -Destination (Join-Path $DesktopCandidate 'TinyCherry-EvoStack.exe')
  Copy-Item -LiteralPath LICENSE -Destination (Join-Path $DesktopCandidate 'LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $DesktopCandidate 'README.md')
  Copy-Item -LiteralPath (Join-Path $DesktopHelper 'runtime\open-computer-use.exe') -Destination (Join-Path $DesktopCandidate 'open-computer-use.exe')
  Copy-Item -LiteralPath (Join-Path $DesktopHelper 'LICENSE') -Destination (Join-Path $DesktopCandidate 'computer-use-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $DesktopHelper 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $DesktopCandidate 'computer-use-THIRD-PARTY-NOTICES.md')
  Invoke-DesktopStep { node scripts/desktop/candidate.mjs hashes $DesktopCandidate }
  Invoke-DesktopStep { node scripts/desktop/candidate.mjs write $DesktopCandidate $DesktopIdentity.sourceHash }
  # Promotion changes a pointer only. A failed build never replaces an earlier candidate.
  if ($ExpectedRevision) { & (Join-Path $PSScriptRoot 'verify-source.ps1') -ExpectedRevision $ExpectedRevision }
  Invoke-DesktopStep { node scripts/desktop/candidate.mjs promote (Join-Path $PSScriptRoot 'dist') $DesktopCandidateName }
  Write-Output "Built candidate: $DesktopCandidate"
} finally { Pop-Location }
