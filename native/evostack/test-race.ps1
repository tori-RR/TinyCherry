$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'prepare-env.ps1')
$EvoCompiler = Get-Command gcc -ErrorAction SilentlyContinue
if (-not $EvoCompiler) { throw 'Go -race requires a Windows MinGW-w64 C compiler; gcc was not found. No tests ran.' }
$EvoSynchronization = & $EvoCompiler.Source --print-file-name libsynchronization.a
if (-not (Test-Path -LiteralPath $EvoSynchronization)) { throw 'gcc lacks the MinGW-w64 synchronization library required by Go -race' }
$env:CGO_ENABLED = '1'
$env:CC = $EvoCompiler.Source
Push-Location (Resolve-Path (Join-Path $PSScriptRoot '..\..'))
try {
  pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/generate-contract.ts
  if ($LASTEXITCODE -ne 0) { throw 'Could not generate embedded backend resources for race tests' }
} finally { Pop-Location }
Push-Location (Join-Path $PSScriptRoot 'backend')
try {
  go test -race -count=10 -timeout 300s ./...
  if ($LASTEXITCODE -ne 0) { throw 'Go race checks failed' }
} finally {
  $env:CGO_ENABLED = '0'
  Pop-Location
}
