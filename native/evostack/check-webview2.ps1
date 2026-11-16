$ErrorActionPreference = 'Stop'
# Microsoft documents these Evergreen Runtime registrations for 64-bit Windows.
$EvoRuntimeKeys = @(
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}',
  'HKCU:\Software\Microsoft\EdgeUpdate\Clients\{F3017226-FE2A-4295-8BDF-00C3A9A7E4C5}'
)
foreach ($EvoRuntimeKey in $EvoRuntimeKeys) {
  $EvoInstalledVersion = Get-ItemPropertyValue -LiteralPath $EvoRuntimeKey -Name pv -ErrorAction SilentlyContinue
  $EvoRuntimeVersion = $null
  if ([version]::TryParse($EvoInstalledVersion, [ref]$EvoRuntimeVersion) -and $EvoRuntimeVersion -gt [version]'0.0.0.0') {
    Write-Output "WebView2 Runtime detected: $EvoRuntimeVersion"
    return
  }
}
throw 'Microsoft Edge WebView2 Evergreen Runtime is required for the real package smoke test; no runtime was detected and none was installed'
