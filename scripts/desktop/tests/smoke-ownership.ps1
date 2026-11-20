$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot '../../../native/evostack/smoke-ownership.ps1')
$EvoProfile = 'C:\synthetic\package smoke'
$EvoHostFixture = [pscustomobject]@{ProcessId=100;ParentProcessId=1;CreationDate=[datetime]'2026-01-01T00:00:00Z';Name='TinyCherry.exe';CommandLine=''}
function New-EvoBrowser([int]$Id = 200, [int]$Parent = 100, [string]$Folder = 'C:\synthetic\package smoke\webview\EBWebView') {
  return [pscustomobject]@{ProcessId=$Id;ParentProcessId=$Parent;CreationDate=[datetime]'2026-01-01T00:00:01Z';Name='msedgewebview2.exe';CommandLine=('"C:\runtime\msedgewebview2.exe" --embedded-browser-webview=1 --user-data-dir="' + $Folder + '" --remote-debugging-port=51337')}
}
$EvoListener = [pscustomobject]@{LocalAddress='127.0.0.1';LocalPort=51337;OwningProcess=200}
$EvoCases = [Collections.Generic.List[string]]::new()
function Assert-EvoOwner([string]$Name, [object[]]$Processes, [object[]]$Listeners, [bool]$Accepted) {
  $EvoRejected = $false
  try { $EvoResult = Get-EvoSmokeBrowser -Processes $Processes -Listeners $Listeners -HostProcessId 100 -Profile $EvoProfile -Port 51337 } catch { $EvoRejected = $true }
  if ($Accepted -and ($EvoRejected -or -not $EvoResult -or $EvoResult.ProcessId -ne 200)) { throw "Expected ownership: $Name" }
  if (-not $Accepted -and -not $EvoRejected) { throw "Expected rejection: $Name" }
  $EvoCases.Add($Name)
}
Assert-EvoOwner 'direct browser' @($EvoHostFixture, (New-EvoBrowser)) @($EvoListener) $true
Assert-EvoOwner 'port selects one of multiple browser processes' @($EvoHostFixture, (New-EvoBrowser), (New-EvoBrowser 201)) @($EvoListener) $true
$EvoLauncher = [pscustomobject]@{ProcessId=150;ParentProcessId=100;CreationDate=[datetime]'2026-01-01T00:00:00Z'}
Assert-EvoOwner 'owned descendant browser' @($EvoHostFixture, $EvoLauncher, (New-EvoBrowser 200 150)) @($EvoListener) $true
Assert-EvoOwner 'normalized profile path' @($EvoHostFixture, (New-EvoBrowser 200 100 '//?/C:/SYNTHETIC/package smoke/webview/EBWebView')) @($EvoListener) $true
Assert-EvoOwner 'foreign application' @($EvoHostFixture, (New-EvoBrowser 200 999)) @($EvoListener) $false
Assert-EvoOwner 'foreign profile' @($EvoHostFixture, (New-EvoBrowser 200 100 'C:\synthetic\other\webview')) @($EvoListener) $false
Assert-EvoOwner 'profile prefix collision' @($EvoHostFixture, (New-EvoBrowser 200 100 'C:\synthetic\package smoke\webview-other')) @($EvoListener) $false
$EvoReused = New-EvoBrowser
$EvoReused.CreationDate = [datetime]'2025-12-31T23:59:59Z'
Assert-EvoOwner 'reused parent PID' @($EvoHostFixture, $EvoReused) @($EvoListener) $false
$EvoRenderer = New-EvoBrowser
$EvoRenderer.CommandLine += ' --type=renderer'
Assert-EvoOwner 'renderer is not browser' @($EvoHostFixture, $EvoRenderer) @($EvoListener) $false
$EvoDuplicate = New-EvoBrowser
$EvoDuplicate.CommandLine += ' --user-data-dir=C:\other'
Assert-EvoOwner 'duplicate profile switches' @($EvoHostFixture, $EvoDuplicate) @($EvoListener) $false
$EvoPublic = [pscustomobject]@{LocalAddress='0.0.0.0';LocalPort=51337;OwningProcess=200}
Assert-EvoOwner 'public listener' @($EvoHostFixture, (New-EvoBrowser)) @($EvoPublic) $false
$EvoForeignListener = [pscustomobject]@{LocalAddress='::1';LocalPort=51337;OwningProcess=201}
Assert-EvoOwner 'split listener ownership' @($EvoHostFixture, (New-EvoBrowser), (New-EvoBrowser 201)) @($EvoListener, $EvoForeignListener) $false
if ($null -ne (Get-EvoSmokeBrowser -Processes @($EvoHostFixture) -Listeners @() -HostProcessId 100 -Profile $EvoProfile -Port 51337)) { throw 'An unready listener must remain pending' }
$EvoCases.Add('unready listener')
$EvoCases | ConvertTo-Json -Compress
