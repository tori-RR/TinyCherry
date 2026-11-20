param([ValidateSet('go','vet','race','rust','contracts')][string]$Task, [string]$Directory, [ValidateRange(1,10)][int]$Count = 1)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'prepare-env.ps1')
$DesktopRepo = (Resolve-Path (Join-Path $PSScriptRoot '..\..')).Path
function Invoke-TestStep([scriptblock]$Action) { & $Action; if ($LASTEXITCODE -ne 0) { throw "Desktop $Task failed: $LASTEXITCODE" } }
Push-Location $DesktopRepo
try {
  $DesktopIdentity = & node scripts/desktop/candidate.mjs identity | ConvertFrom-Json
  $env:EVOSTACK_APP_VERSION = $DesktopIdentity.version
  $env:EVOSTACK_BUILD_REVISION = $DesktopIdentity.revision
  if ($Task -in @('go','vet','contracts')) { Invoke-TestStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/generate-contract.ts } }
  switch ($Task) {
    'go' { Push-Location native/evostack/backend; try { Invoke-TestStep { go test -timeout 120s ./... } } finally { Pop-Location } }
    'vet' {
      Push-Location native/evostack/backend
      try {
        $DesktopUnformatted = & gofmt -l .
        if ($LASTEXITCODE -ne 0 -or $DesktopUnformatted) { throw "Go formatting failed: $DesktopUnformatted" }
        Invoke-TestStep { go vet ./... }
      } finally { Pop-Location }
    }
    'race' { & (Join-Path $PSScriptRoot 'test-race.ps1') -Count $Count }
    'rust' {
      # The GPUI host build script embeds frontend assets in release test binaries.
      if (-not (Test-Path -LiteralPath native/evostack/dist/frontend/windows/evostack/index.html)) { Invoke-TestStep { pnpm exec vite build --config native/evostack/vite.config.mts } }
      Invoke-TestStep { cargo fmt --manifest-path native/evostack/src-gpui/Cargo.toml --check }
      Invoke-TestStep { cargo test --release --locked --manifest-path native/evostack/src-gpui/Cargo.toml }
      $DesktopHelper = & node scripts/desktop/helper.mjs
      if ($LASTEXITCODE -ne 0) { throw 'Helper unavailable' }
      $env:EVOSTACK_TEST_COMPUTER_RUNTIME = Join-Path $DesktopHelper 'runtime/open-computer-use.exe'
      try {
        Invoke-TestStep { cargo test --release --locked --manifest-path native/evostack/src-gpui/Cargo.toml computer_use::tests::native_helper_private_session_preflight_confirms_cleanup -- --ignored --exact }
        Invoke-TestStep { cargo test --release --locked --manifest-path native/evostack/src-gpui/Cargo.toml computer_use::tests::kill_on_close_job_terminates_the_owned_helper_descendant_tree -- --ignored --exact }
      } finally { Remove-Item -LiteralPath Env:\EVOSTACK_TEST_COMPUTER_RUNTIME -ErrorAction SilentlyContinue }
      Invoke-TestStep { cargo clippy --release --locked --manifest-path native/evostack/src-gpui/Cargo.toml -- -D warnings }
    }
    'contracts' {
      if (-not $Directory) {
        $Directory = Join-Path $PSScriptRoot '.cache/contract-candidate'
        New-Item -ItemType Directory -Path $Directory -Force | Out-Null
        Push-Location native/evostack/backend
        try {
          $DesktopFlags = "-s -w -X main.appVersion=$($DesktopIdentity.version) -X main.buildRevision=$($DesktopIdentity.revision)"
          Invoke-TestStep { go build -trimpath -ldflags $DesktopFlags -o (Join-Path $Directory 'tinycherry-evostack-backend.exe') . }
        } finally { Pop-Location }
      }
      $env:EVOSTACK_BACKEND_EXECUTABLE = Join-Path $Directory 'tinycherry-evostack-backend.exe'
      try {
        Invoke-TestStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/check-contract.ts }
        Invoke-TestStep { pnpm exec tsx --tsconfig tsconfig.web.json native/evostack/check-computer-contract.ts }
        Invoke-TestStep { pnpm exec vitest run --project native-contract }
      } finally { Remove-Item -LiteralPath Env:\EVOSTACK_BACKEND_EXECUTABLE -ErrorAction SilentlyContinue }
    }
  }
} finally { Pop-Location }
