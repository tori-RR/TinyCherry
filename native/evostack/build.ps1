param([switch]$SkipChecks)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'prepare-env.ps1')
$EvoRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
$EvoDestination = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot 'dist\portable'))
$EvoPortable = Join-Path $PSScriptRoot ('dist\package-' + [Guid]::NewGuid().ToString('N'))

function Invoke-EvoStep([scriptblock]$Action) {
  & $Action
  if ($LASTEXITCODE -ne 0) { throw "EvoStack build step failed with exit code $LASTEXITCODE" }
}

Push-Location $EvoRepo
try {
  $EvoGo = & go env GOVERSION
  if ($EvoGo -notmatch '^go(\d+\.\d+)' -or [version]$Matches[1] -lt [version]'1.27') { throw 'Go 1.27 or later required' }
  $EvoRust = & rustc --version
  if ($EvoRust -notmatch '^rustc (\d+\.\d+)' -or [version]$Matches[1] -lt [version]'1.98') { throw 'Rust 1.98 or later required' }
  $EvoComputerPackage = & node -e @'
const { createRequire } = require('node:module');
const { readFileSync } = require('node:fs');
const { dirname, resolve } = require('node:path');
const sdkEntry = require.resolve('@cherrystudio/computer-use');
const sdk = JSON.parse(readFileSync(resolve(dirname(sdkEntry), '../package.json'), 'utf8'));
const packageFile = createRequire(sdkEntry).resolve('@cherrystudio/computer-use-win32-x64/package.json');
const runtime = JSON.parse(readFileSync(packageFile, 'utf8'));
if (sdk.version !== '0.1.9' || runtime.version !== sdk.version || runtime.name !== '@cherrystudio/computer-use-win32-x64' || !runtime.os.includes('win32') || !runtime.cpu.includes('x64')) throw new Error('Expected the pinned Windows x64 computer-use 0.1.9 package matching the SDK');
process.stdout.write(JSON.stringify({ directory: dirname(packageFile), version: runtime.version }));
'@
  if ($LASTEXITCODE -ne 0) { throw 'Computer-use runtime dependency is missing or incompatible' }
  $EvoComputerPackage = $EvoComputerPackage | ConvertFrom-Json
  $EvoComputerDirectory = $EvoComputerPackage.directory
  foreach ($EvoComputerFile in @('runtime\open-computer-use.exe','LICENSE','THIRD_PARTY_NOTICES.md')) {
    if (-not (Test-Path -LiteralPath (Join-Path $EvoComputerDirectory $EvoComputerFile) -PathType Leaf)) { throw "Computer-use package is incomplete: $EvoComputerFile" }
  }
  $env:EVOSTACK_APP_VERSION = (Get-Content -LiteralPath package.json -Raw | ConvertFrom-Json).version
  $EvoRevision = & git rev-parse HEAD
  if ($LASTEXITCODE -ne 0) { throw 'Could not identify package revision' }
  if (& git status --porcelain --untracked-files=no) { $EvoRevision += '-dirty' }
  $env:EVOSTACK_BUILD_REVISION = $EvoRevision
  New-Item -ItemType Directory -Path $EvoPortable -Force | Out-Null
  Invoke-EvoStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/generate-contract.ts }
  # generate_context! embeds frontendDist during tests and Clippy as well as release builds.
  Invoke-EvoStep { pnpm exec vite build --config native/evostack/vite.config.mts }
  if (-not $SkipChecks) {
    Invoke-EvoStep { pnpm exec tsc --noEmit -p tsconfig.web.json --composite false }
    Invoke-EvoStep { cargo fmt --manifest-path native/evostack/src-tauri/Cargo.toml --check }
    Invoke-EvoStep { cargo test --release --locked --manifest-path native/evostack/src-tauri/Cargo.toml }
    $env:EVOSTACK_TEST_COMPUTER_RUNTIME = Join-Path $EvoComputerDirectory 'runtime\open-computer-use.exe'
    try {
      Invoke-EvoStep { cargo test --release --locked --manifest-path native/evostack/src-tauri/Cargo.toml computer_use::tests::native_helper_private_session_preflight_confirms_cleanup -- --ignored --exact }
      Invoke-EvoStep { cargo test --release --locked --manifest-path native/evostack/src-tauri/Cargo.toml computer_use::tests::kill_on_close_job_terminates_the_owned_helper_descendant_tree -- --ignored --exact }
    } finally {
      Remove-Item -LiteralPath Env:\EVOSTACK_TEST_COMPUTER_RUNTIME -ErrorAction SilentlyContinue
    }
    Invoke-EvoStep { cargo clippy --release --locked --manifest-path native/evostack/src-tauri/Cargo.toml -- -D warnings }
  }
  Push-Location (Join-Path $PSScriptRoot 'backend')
  try {
    if (-not $SkipChecks) { Invoke-EvoStep { go test -v -timeout 120s ./... } }
    $EvoFlags = "-s -w -X main.appVersion=$($env:EVOSTACK_APP_VERSION) -X main.buildRevision=$EvoRevision"
    Invoke-EvoStep { go build -trimpath -ldflags $EvoFlags -o (Join-Path $EvoPortable 'tinycherry-evostack-backend.exe') . }
  } finally { Pop-Location }
  Invoke-EvoStep { cargo build --release --locked --manifest-path native/evostack/src-tauri/Cargo.toml }
  Copy-Item -LiteralPath (Join-Path $env:CARGO_TARGET_DIR 'release\tinycherry-evostack.exe') -Destination (Join-Path $EvoPortable 'TinyCherry-EvoStack.exe')
  Copy-Item -LiteralPath (Join-Path $EvoRepo 'LICENSE') -Destination (Join-Path $EvoPortable 'LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'README.md') -Destination (Join-Path $EvoPortable 'README.md')
  Copy-Item -LiteralPath (Join-Path $EvoComputerDirectory 'runtime\open-computer-use.exe') -Destination (Join-Path $EvoPortable 'open-computer-use.exe')
  Copy-Item -LiteralPath (Join-Path $EvoComputerDirectory 'LICENSE') -Destination (Join-Path $EvoPortable 'computer-use-LICENSE.txt')
  Copy-Item -LiteralPath (Join-Path $EvoComputerDirectory 'THIRD_PARTY_NOTICES.md') -Destination (Join-Path $EvoPortable 'computer-use-THIRD-PARTY-NOTICES.md')
  & (Join-Path $PSScriptRoot 'verify-package.ps1') -Directory $EvoPortable -ExpectedVersion $env:EVOSTACK_APP_VERSION -ExpectedRevision $EvoRevision
  if (-not $SkipChecks) {
    $env:EVOSTACK_BACKEND_EXECUTABLE = Join-Path $EvoPortable 'tinycherry-evostack-backend.exe'
    Invoke-EvoStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/check-contract.ts }
    Invoke-EvoStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/check-computer-contract.ts }
    Invoke-EvoStep { pnpm exec vitest run --project renderer src/renderer/data/__tests__/DataApiService.nativeMutation.test.ts }
  }
  $EvoHashes = @('TinyCherry-EvoStack.exe','tinycherry-evostack-backend.exe','open-computer-use.exe') | ForEach-Object {
    $EvoFile = Get-Item -LiteralPath (Join-Path $EvoPortable $_)
    [ordered]@{ name = $_; bytes = $EvoFile.Length; sha256 = (Get-FileHash -LiteralPath $EvoFile.FullName -Algorithm SHA256).Hash }
  }
  $EvoHashes | ConvertTo-Json | Set-Content -LiteralPath (Join-Path $EvoPortable 'SHA256.json') -Encoding utf8
  $EvoFiles = @('TinyCherry-EvoStack.exe','tinycherry-evostack-backend.exe','open-computer-use.exe','README.md','LICENSE.txt','computer-use-LICENSE.txt','computer-use-THIRD-PARTY-NOTICES.md','SHA256.json')
  if (Compare-Object @((Get-ChildItem -LiteralPath $EvoPortable -Force).Name | Sort-Object) @($EvoFiles | Sort-Object)) { throw 'Unexpected package files' }
  Compress-Archive -LiteralPath @($EvoFiles | ForEach-Object { Join-Path $EvoPortable $_ }) -DestinationPath ($EvoPortable + '.zip')
  $EvoBackup = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot ('.cache\portable-backups\' + [Guid]::NewGuid().ToString('N'))))
  foreach ($EvoPath in @($EvoPortable,$EvoDestination,$EvoBackup)) {
    if (-not [IO.Path]::GetFullPath($EvoPath).StartsWith($PSScriptRoot + '\',[StringComparison]::OrdinalIgnoreCase)) { throw 'Package path escaped EvoStack directory' }
  }
  $EvoZip = Join-Path $PSScriptRoot 'dist\TinyCherry-EvoStack-win-x64-portable.zip'
  New-Item -ItemType Directory -Path (Split-Path -Parent $EvoBackup) -Force | Out-Null
  $EvoHadZip = Test-Path -LiteralPath $EvoZip
  if ($EvoHadZip) { Copy-Item -LiteralPath $EvoZip -Destination ($EvoBackup + '.zip') }
  $EvoHadPortable = Test-Path -LiteralPath $EvoDestination
  if ($EvoHadPortable) {
    Move-Item -LiteralPath $EvoDestination -Destination $EvoBackup
  }
  $EvoPromoted = $false
  try {
    Move-Item -LiteralPath $EvoPortable -Destination $EvoDestination
    $EvoPromoted = $true
    Move-Item -LiteralPath ($EvoPortable + '.zip') -Destination $EvoZip -Force
  } catch {
    if ($EvoPromoted) { Move-Item -LiteralPath $EvoDestination -Destination $EvoPortable }
    if ($EvoHadPortable) { Move-Item -LiteralPath $EvoBackup -Destination $EvoDestination }
    if ($EvoHadZip) { Copy-Item -LiteralPath ($EvoBackup + '.zip') -Destination $EvoZip -Force }
    throw
  }
  Write-Output "Portable: $EvoDestination"
} finally {
  Remove-Item -LiteralPath Env:\EVOSTACK_BACKEND_EXECUTABLE -ErrorAction SilentlyContinue
  Pop-Location
}
