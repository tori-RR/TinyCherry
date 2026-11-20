param([Parameter(Mandatory)][string]$Directory, [Parameter(Mandatory)][string]$ExpectedVersion, [Parameter(Mandatory)][string]$ExpectedRevision)
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'smoke-ownership.ps1')
. (Join-Path $PSScriptRoot 'smoke-diagnostics.ps1')
$EvoDirectory = (Resolve-Path -LiteralPath $Directory).Path
$EvoIdentities = @()
$EvoHostName = 'TinyCherry.exe'
foreach ($EvoName in @($EvoHostName,'tinycherry-evostack-backend.exe','open-computer-use.exe')) {
  $EvoExecutable = Join-Path $EvoDirectory $EvoName
  $EvoBytes = [IO.File]::ReadAllBytes($EvoExecutable)
  $EvoOffset = [BitConverter]::ToInt32($EvoBytes, 0x3c)
  if ([BitConverter]::ToUInt16($EvoBytes, $EvoOffset + 4) -ne 0x8664) { throw "Expected x64: $EvoName" }
  if ($EvoName -eq 'open-computer-use.exe') { continue }
  if ($EvoName -eq $EvoHostName) {
    $EvoProduct = (Get-Item -LiteralPath $EvoExecutable).VersionInfo
    if ($EvoProduct.ProductName -cne 'TinyCherry') { throw 'Host executable product name mismatch' }
    if ($EvoProduct.ProductVersion -notmatch ('^' + [Regex]::Escape($ExpectedVersion) + '(?:\.0)?$')) { throw 'Host executable product version mismatch' }
  }
  $EvoIdentity = & $EvoExecutable --evostack-build-info | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0 -or $EvoIdentity.version -ne $ExpectedVersion -or $EvoIdentity.revision -ne $ExpectedRevision -or $EvoIdentity.protocol -ne 1) { throw "Package identity mismatch: $EvoName" }
  $EvoIdentities += $EvoIdentity
}
$EvoPreviousProfile = $env:TINYCHERRY_EVOSTACK_DATA_DIR
$EvoPreviousDebug = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$EvoPreviousWebViewProfile = $env:WEBVIEW2_USER_DATA_FOLDER
$EvoPreviousSmokeToken = $env:TINYCHERRY_EVOSTACK_SMOKE_TOKEN
$EvoPreviousSmokePort = $env:TINYCHERRY_EVOSTACK_SMOKE_PORT
$EvoSmoke = Join-Path $PSScriptRoot ('.cache\package-smoke-' + [Guid]::NewGuid().ToString('N'))
$EvoToken = [Guid]::NewGuid().ToString('N')
$EvoPortProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 0)
$EvoPortProbe.Start()
$EvoPort = $EvoPortProbe.LocalEndpoint.Port
$EvoPortProbe.Stop()
$EvoHost = $null
$EvoDiagnostics = Join-Path $EvoSmoke 'diagnostics'
New-Item -ItemType Directory -Path $EvoDiagnostics -Force | Out-Null
try {
  $env:TINYCHERRY_EVOSTACK_DATA_DIR = $EvoSmoke
  $env:TINYCHERRY_EVOSTACK_SMOKE_TOKEN = $EvoToken
  $env:TINYCHERRY_EVOSTACK_SMOKE_PORT = [string]$EvoPort
  $env:WEBVIEW2_USER_DATA_FOLDER = Join-Path $EvoSmoke 'webview'
  # The host configures the validated port through Wry's WebView2 environment options.
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = '--disable-background-timer-throttling'
  try { Save-EvoSmokeDiagnostics -Profile $EvoSmoke -Stage 'before-start' } catch { Write-Warning "Could not record smoke diagnostics: $($_.Exception.Message)" }
  # Verify a visible main window using a normal launch, without a STARTUPINFO request to hide the GUI.
  $EvoHost = Start-Process -FilePath (Join-Path $EvoDirectory $EvoHostName) -WorkingDirectory $EvoDirectory -WindowStyle Normal -RedirectStandardOutput (Join-Path $EvoDiagnostics 'host.stdout.log') -RedirectStandardError (Join-Path $EvoDiagnostics 'host.stderr.log') -PassThru
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
  $EvoHost.Refresh()
  if ($EvoHost.MainWindowTitle -cne 'TinyCherry') { throw 'Packaged window title mismatch' }
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
  if (-not $EvoBrowser) {
    $EvoProfileMarker = [IO.Path]::GetFileName($EvoSmoke)
    $EvoBrowserDiagnostics = @(Get-CimInstance Win32_Process -Filter "Name='msedgewebview2.exe' OR Name='msedge.exe'" | Where-Object { $_.CommandLine -and $_.CommandLine.Contains($EvoProfileMarker) } | Select-Object -First 8 | ForEach-Object {
      $EvoRuntimeVersion = $null
      try { $EvoRuntimeVersion = (Get-Item -LiteralPath $_.ExecutablePath).VersionInfo.FileVersion } catch { }
      [ordered]@{pid=$_.ProcessId;parent=$_.ParentProcessId;runtime=$EvoRuntimeVersion;hasRequestedPort=($_.CommandLine -match ('(?:^|\s)--remote-debugging-port=' + $EvoPort + '(?:\s|$)'));debuggingDisabled=($_.CommandLine -match '--disable-features=\S*RemoteDebugging')}
    })
    Write-Output ('Synthetic WebView2 startup diagnostics: ' + (ConvertTo-Json -InputObject $EvoBrowserDiagnostics -Compress))
    throw 'The owned smoke CDP listener did not become ready'
  }
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
} catch {
  $EvoSmokeFailure = $_
  try { Save-EvoSmokeDiagnostics -Profile $EvoSmoke -Stage 'failure' -Failure $EvoSmokeFailure.Exception.Message -HostProcess $EvoHost } catch { Write-Warning "Could not record smoke diagnostics: $($_.Exception.Message)" }
  try {
    if ($EvoHost -and -not $EvoHost.HasExited) {
      $EvoFailureListeners = @(Get-NetTCPConnection -LocalPort $EvoPort -State Listen -ErrorAction SilentlyContinue)
      $EvoFailureProcesses = @(Get-CimInstance Win32_Process)
      $EvoFailureBrowser = Get-EvoSmokeBrowser -Processes $EvoFailureProcesses -Listeners $EvoFailureListeners -HostProcessId $EvoHost.Id -Profile $EvoSmoke -Port $EvoPort
      if ($EvoFailureBrowser) {
        # Diagnosis is allowed before renderer-ready only after the same strict ownership checks.
        & node (Join-Path $PSScriptRoot 'diagnose-renderer.mjs') $EvoPort $EvoSmoke
        if ($LASTEXITCODE -ne 0) { Write-Warning 'Owned page diagnostics were incomplete; see diagnostics/page.json' }
      } else { Write-Warning 'No owned smoke CDP listener was available for page diagnostics' }
    }
  } catch { Write-Warning "Could not collect owned page diagnostics: $($_.Exception.Message)" }
  throw $EvoSmokeFailure
} finally {
  if ($EvoHost -and -not $EvoHost.HasExited) { $EvoHost.Kill(); $EvoHost.WaitForExit() }
  $env:TINYCHERRY_EVOSTACK_DATA_DIR = $EvoPreviousProfile
  $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $EvoPreviousDebug
  $env:WEBVIEW2_USER_DATA_FOLDER = $EvoPreviousWebViewProfile
  $env:TINYCHERRY_EVOSTACK_SMOKE_TOKEN = $EvoPreviousSmokeToken
  $env:TINYCHERRY_EVOSTACK_SMOKE_PORT = $EvoPreviousSmokePort
}
