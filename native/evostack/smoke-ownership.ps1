function ConvertTo-EvoSmokePath([string]$Value) {
  $EvoPath = $Value.Replace('/', '\')
  if ($EvoPath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $EvoPath = '\\' + $EvoPath.Substring(8) }
  elseif ($EvoPath.StartsWith('\\?\', [StringComparison]::Ordinal)) { $EvoPath = $EvoPath.Substring(4) }
  return [IO.Path]::GetFullPath($EvoPath).TrimEnd('\')
}

function Get-EvoSmokeBrowser {
  param([object[]]$Processes, [object[]]$Listeners, [int]$HostProcessId, [string]$Profile, [int]$Port)
  if ($Listeners.Count -eq 0) { return $null }
  $EvoOwners = @($Listeners | Select-Object -ExpandProperty OwningProcess -Unique)
  if ($EvoOwners.Count -ne 1 -or @($Listeners | Where-Object { $_.LocalPort -ne $Port -or $_.LocalAddress -notin @('127.0.0.1', '::1') }).Count -ne 0) {
    throw 'The smoke CDP listener is not uniquely owned on loopback'
  }
  if (@($Listeners | Where-Object { $_.LocalAddress -eq '127.0.0.1' }).Count -eq 0) { return $null }
  $EvoIndex = @{}
  foreach ($EvoProcess in $Processes) { $EvoIndex[[int]$EvoProcess.ProcessId] = $EvoProcess }
  $EvoBrowser = $EvoIndex[[int]$EvoOwners[0]]
  if (-not $EvoBrowser -or $EvoBrowser.Name -notin @('msedgewebview2.exe', 'msedge.exe')) { throw 'The smoke CDP listener is not a WebView2 process' }
  $EvoVisited = @{}
  $EvoAncestor = $EvoBrowser
  while ([int]$EvoAncestor.ProcessId -ne $HostProcessId) {
    $EvoId = [int]$EvoAncestor.ProcessId
    if ($EvoVisited.ContainsKey($EvoId) -or $EvoVisited.Count -ge 32) { throw 'The smoke CDP process ancestry is invalid' }
    $EvoVisited[$EvoId] = $true
    $EvoParent = $EvoIndex[[int]$EvoAncestor.ParentProcessId]
    if (-not $EvoParent -or [datetime]$EvoAncestor.CreationDate -lt [datetime]$EvoParent.CreationDate) { throw 'The smoke CDP listener does not belong to the packaged host' }
    $EvoAncestor = $EvoParent
  }
  $EvoCommand = [string]$EvoBrowser.CommandLine
  if ($EvoCommand -notmatch '(?:^|\s)--embedded-browser-webview=1(?:\s|$)' -or $EvoCommand -match '(?:^|\s)--type=') { throw 'The smoke CDP listener is not the WebView2 browser' }
  $EvoFolders = [regex]::Matches($EvoCommand, '(?:^|\s)(?:"--user-data-dir=([^"]+)"|--user-data-dir=(?:"([^"]+)"|([^\s"]+)))(?=\s|$)')
  if ($EvoFolders.Count -ne 1) { throw 'The smoke CDP browser has no unique profile argument' }
  $EvoFolder = @($EvoFolders[0].Groups | Select-Object -Skip 1 | Where-Object { $_.Success })[0].Value
  $EvoActual = ConvertTo-EvoSmokePath $EvoFolder
  $EvoExpected = ConvertTo-EvoSmokePath (Join-Path $Profile 'webview')
  if (-not $EvoActual.Equals($EvoExpected, [StringComparison]::OrdinalIgnoreCase) -and -not $EvoActual.StartsWith($EvoExpected + '\', [StringComparison]::OrdinalIgnoreCase)) {
    throw 'The smoke CDP browser belongs to another profile'
  }
  return $EvoBrowser
}
