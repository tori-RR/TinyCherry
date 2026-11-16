param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$ExpectedVersion, [Parameter(Mandatory)][string]$ExpectedRevision)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smoke-ownership.ps1')
$EvoDirectory = (Resolve-Path -LiteralPath $Directory).Path
$EvoIdentities = @()
foreach ($EvoName in @('TinyCherry-EvoStack.exe','tinycherry-evostack-backend.exe','open-computer-use.exe')) {
  $EvoExecutable = Join-Path $EvoDirectory $EvoName
  $EvoBytes = [IO.File]::ReadAllBytes($EvoExecutable)
  $EvoOffset = [BitConverter]::ToInt32($EvoBytes, 0x3c)
  if ([BitConverter]::ToUInt16($EvoBytes, $EvoOffset + 4) -ne 0x8664) { throw "Expected x64: $EvoName" }
  if ($EvoName -eq 'open-computer-use.exe') { continue }
  if ($EvoName -eq 'TinyCherry-EvoStack.exe') {
    $EvoProductVersion = (Get-Item -LiteralPath $EvoExecutable).VersionInfo.ProductVersion
    if ($EvoProductVersion -notmatch ('^' + [Regex]::Escape($ExpectedVersion) + '(?:\.0)?$')) { throw 'Host executable product version mismatch' }
  }
  $EvoIdentity = & $EvoExecutable --evostack-build-info | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $EvoIdentity.version -ne $ExpectedVersion -or $EvoIdentity.revision -ne $ExpectedRevision -or $EvoIdentity.protocol -ne 1) { throw "Package identity mismatch: $EvoName" }
  $EvoIdentities += $EvoIdentity
}
$EvoPreviousProfile = $env:TINYCHERRY_EVOSTACK_DATA_DIR
$EvoPreviousDebug = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$EvoPreviousWebViewProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$EvoPreviousSmokeToken = $env:TINYCHERRY_EVOSTACK_SMOKE_TOKEN
$EvoSmoke = Join-Path $PSScriptRoot ('.cache\package-smoke-' + [Guid]::NewGuid().ToString('N'))
$EvoToken = [Guid]::NewGuid().ToString('N')
$EvoPortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$EvoPortProbe.Start()
$EvoPort = $EvoPortProbe.LocalEndpoint.Port
$EvoPortProbe.Stop()
$EvoHost = $null
try {
  $env:TINYCHERRY_EVOSTACK_DATA_DIR = $EvoSmoke
  $env:TINYCHERRY_EVOSTACK_SMOKE_TOKEN = $EvoToken
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $EvoSmoke 'webview'
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$EvoPort --remote-debugging-address=127.0.0.1 --disable-background-timer-throttling --disable-renderer-backgrounding --disable-backgrounding-occluded-windows --disable-features=CalculateNativeWinOcclusion"
  $EvoHost = Start-Process -FilePath (Join-Path $EvoDirectory 'TinyCherry-EvoStack.exe') -WorkingDirectory $EvoDirectory -WindowStyle Hidden -PassThru
  $EvoDeadline = (Get-Date).AddSeconds(20)
  do {
    Start-Sleep -Milliseconds 200
    $EvoHost.Refresh()
    if ($EvoHost.HasExited) { throw 'Packaged host exited at startup' }
  } until ($EvoHost.MainWindowHandle -ne 0 -or (Get-Date) -gt $EvoDeadline)
  if ($EvoHost.MainWindowHandle -eq 0) { throw 'No packaged window observed' }
  if ($EvoHost.HasExited -or -not (Test-Path -LiteralPath (Join-Path $EvoSmoke 'evostack.sqlite3'))) { throw 'Backend did not initialize' }
  $EvoChildren = @(Get-CimInstance Win32_Process -Filter "Name='tinycherry-evostack-backend.exe'" | Where-Object { $_.ParentProcessId -eq $EvoHost.Id })
  if ($EvoChildren.Count -ne 1) { throw 'Expected one Go sidecar' }
  $EvoDeadline = (Get-Date).AddSeconds(40)
  $EvoReady = $null
  do {
    if ($EvoHost.HasExited) { throw 'Packaged host exited before React was ready' }
    try { $EvoReady = Get-Content -LiteralPath (Join-Path $EvoSmoke 'renderer-ready.json') -Raw -ErrorAction Stop | ConvertFrom-Json } catch { }
    if ($EvoReady) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $EvoDeadline)
  if (-not $EvoReady -or $EvoReady.token -ne $EvoToken -or $EvoReady.pid -ne $EvoHost.Id -or $EvoReady.phase -ne 'onboarding' -or $EvoReady.build.revision -ne $ExpectedRevision) { throw 'The packaged React renderer did not acknowledge the expected fresh profile' }
  $EvoDeadline = (Get-Date).AddSeconds(15)
  $EvoBrowser = $null
  do {
    if ($EvoHost.HasExited) { throw 'Packaged host exited before its CDP listener was ready' }
    $EvoListeners = @(Get-NetTCPConnection -LocalPort $EvoPort -State Listen -ErrorAction SilentlyContinue)
    if ($EvoListeners.Count -ne 0) {
      $EvoProcesses = @(Get-CimInstance Win32_Process)
      $EvoBrowser = Get-EvoSmokeBrowser -Processes $EvoProcesses -Listeners $EvoListeners -HostProcessId $EvoHost.Id -Profile $EvoSmoke -Port $EvoPort
    }
    if ($EvoBrowser) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $EvoDeadline)
  if (-not $EvoBrowser) { throw 'The owned smoke CDP listener did not become ready' }
  & node (Join-Path $PSScriptRoot 'verify-renderer.mjs') $EvoPort $EvoSmoke $ExpectedRevision
  if ($LASTEXITCODE -ne 0) { throw 'Packaged React interaction failed' }
  if (-not $EvoHost.CloseMainWindow() -or -not $EvoHost.WaitForExit(15000)) { throw 'Host did not close gracefully' }
  $EvoDeadline = (Get-Date).AddSeconds(5)
  do {
    $EvoRemaining = @(Get-CimInstance Win32_Process -Filter "Name='tinycherry-evostack-backend.exe'" | Where-Object { $_.ParentProcessId -eq $EvoHost.Id })
    if ($EvoRemaining.Count -eq 0) { break }
    Start-Sleep -Milliseconds 100
  } while ((Get-Date) -lt $EvoDeadline)
  if ($EvoRemaining.Count -ne 0) { throw 'Sidecar survived host shutdown' }
  [ordered]@{passed=$true;identities=$EvoIdentities;profile=$EvoSmoke;rendererReady=$true;uiInteraction='Set Up Later persisted and workspace rendered'} | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath ($EvoSmoke + '.json') -Encoding utf8
  Write-Output 'Package identity, x64 startup, React interaction and graceful shutdown passed'
} finally {
  if ($EvoHost -and -not $EvoHost.HasExited) { $EvoHost.Kill(); $EvoHost.WaitForExit() }
  $env:TINYCHERRY_EVOSTACK_DATA_DIR = $EvoPreviousProfile
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $EvoPreviousDebug
  $env:WEBVIEW2_USER_DATA_FOLDER = $EvoPreviousWebViewProfile
  $env:TINYCHERRY_EVOSTACK_SMOKE_TOKEN = $EvoPreviousSmokeToken
}
