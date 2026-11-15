$ErrorActionPreference = 'Stop'
$EvoRoot = $PSScriptRoot
$EvoCache = Join-Path $EvoRoot '.cache'
foreach ($name in @('tmp', 'go', 'go-build', 'cargo', 'target', 'npm')) {
  New-Item -ItemType Directory -Path (Join-Path $EvoCache $name) -Force | Out-Null
}
$env:TEMP = Join-Path $EvoCache 'tmp'
$env:TMP = $env:TEMP
$env:GOPATH = Join-Path $EvoCache 'go'
$env:GOMODCACHE = Join-Path $env:GOPATH 'pkg\mod'
$env:GOCACHE = Join-Path $EvoCache 'go-build'
$env:GOTOOLCHAIN = 'local'
$env:CGO_ENABLED = '0'
$env:CARGO_HOME = Join-Path $EvoCache 'cargo'
$env:CARGO_TARGET_DIR = Join-Path $EvoCache 'target'
$env:npm_config_cache = Join-Path $EvoCache 'npm'
$env:RUSTUP_NO_UPDATE_CHECK = '1'
