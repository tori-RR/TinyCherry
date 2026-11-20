function Initialize-EvoSmokeWindowDiagnostics {
  if ('EvoSmokeWindowDiagnostics' -as [type]) { return }
  Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;

public sealed class EvoSmokeWindowSnapshot {
  public string Handle { get; set; }
  public string Parent { get; set; }
  public string Owner { get; set; }
  public string ClassName { get; set; }
  public string Text { get; set; }
  public bool Visible { get; set; }
  public bool Enabled { get; set; }
  public int Left { get; set; }
  public int Top { get; set; }
  public int Width { get; set; }
  public int Height { get; set; }
}

public static class EvoSmokeWindowDiagnostics {
  private delegate bool EnumWindowCallback(IntPtr window, IntPtr state);
  [StructLayout(LayoutKind.Sequential)]
  private struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] private static extern bool EnumWindows(EnumWindowCallback callback, IntPtr state);
  [DllImport("user32.dll")] private static extern bool EnumChildWindows(IntPtr parent, EnumWindowCallback callback, IntPtr state);
  [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(IntPtr window, out uint processId);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetClassName(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(IntPtr window, StringBuilder text, int count);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr count, StringBuilder text, uint flags, uint timeout, out UIntPtr result);
  [DllImport("user32.dll")] private static extern bool IsWindowVisible(IntPtr window);
  [DllImport("user32.dll")] private static extern bool IsWindowEnabled(IntPtr window);
  [DllImport("user32.dll")] private static extern bool GetWindowRect(IntPtr window, out Rect rect);
  [DllImport("user32.dll")] private static extern IntPtr GetParent(IntPtr window);
  [DllImport("user32.dll")] private static extern IntPtr GetWindow(IntPtr window, uint command);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  private static string Handle(IntPtr value) { return "0x" + value.ToInt64().ToString("X"); }

  public static EvoSmokeWindowSnapshot[] Capture(int processId) {
    var windows = new List<EvoSmokeWindowSnapshot>();
    var visited = new HashSet<IntPtr>();
    Action<IntPtr, bool> capture = (window, dialogChild) => {
      uint ownerId;
      GetWindowThreadProcessId(window, out ownerId);
      // Never read a foreign process's window caption or controls.
      if (ownerId != (uint)processId || windows.Count >= 64 || !visited.Add(window)) return;
      var className = new StringBuilder(256);
      var text = new StringBuilder(2048);
      GetClassName(window, className, className.Capacity);
      GetWindowText(window, text, text.Capacity);
      if (dialogChild) {
        // WM_GETTEXT is bounded: an unresponsive startup dialog cannot hang diagnostics.
        UIntPtr ignored;
        SendMessageTimeout(window, 0x000D, new UIntPtr((uint)text.Capacity), text, 0x0003, 75, out ignored);
      }
      Rect rect;
      GetWindowRect(window, out rect);
      windows.Add(new EvoSmokeWindowSnapshot {
        Handle = Handle(window), Parent = Handle(GetParent(window)), Owner = Handle(GetWindow(window, 4)),
        ClassName = className.ToString(), Text = text.ToString(),
        Visible = IsWindowVisible(window), Enabled = IsWindowEnabled(window),
        Left = rect.Left, Top = rect.Top, Width = rect.Right - rect.Left, Height = rect.Bottom - rect.Top
      });
    };
    EnumWindows((window, state) => {
      uint ownerId;
      GetWindowThreadProcessId(window, out ownerId);
      if (ownerId != (uint)processId) return true;
      capture(window, false);
      var className = new StringBuilder(256);
      GetClassName(window, className, className.Capacity);
      bool dialog = className.ToString() == "#32770";
      EnumChildWindows(window, (child, childState) => { capture(child, dialog); return windows.Count < 64; }, IntPtr.Zero);
      return windows.Count < 64;
    }, IntPtr.Zero);
    return windows.ToArray();
  }
}
'@
}

function Save-EvoSmokeDiagnostics {
  param([Parameter(Mandatory)][string]$Profile, [Parameter(Mandatory)][string]$Stage, [string]$Failure, [Diagnostics.Process]$HostProcess)
  $EvoDiagnosticsDirectory = Join-Path $Profile 'diagnostics'
  New-Item -ItemType Directory -Path $EvoDiagnosticsDirectory -Force | Out-Null
  $EvoCollectorErrors = @()
  $EvoMonitorCount = $null
  $EvoWindows = @()
  try {
    Initialize-EvoSmokeWindowDiagnostics
    $EvoMonitorCount = [EvoSmokeWindowDiagnostics]::GetSystemMetrics(80)
    if ($HostProcess) { $EvoWindows = @([EvoSmokeWindowDiagnostics]::Capture($HostProcess.Id)) }
  } catch { $EvoCollectorErrors += "Window metadata: $($_.Exception.Message)" }
  $EvoHostState = $null
  $EvoChildren = @()
  if ($HostProcess) {
    try {
      $HostProcess.Refresh()
      $EvoHostState = [ordered]@{pid=$HostProcess.Id;exited=$HostProcess.HasExited;exitCode=$null;sessionId=$null;mainWindow=$null;mainWindowTitle=$null}
      if ($HostProcess.HasExited) { $EvoHostState.exitCode = $HostProcess.ExitCode }
      else {
        $EvoHostState.sessionId = $HostProcess.SessionId
        $EvoHostState.mainWindow = '0x' + $HostProcess.MainWindowHandle.ToInt64().ToString('X')
        $EvoHostState.mainWindowTitle = $HostProcess.MainWindowTitle
        $EvoChildren = @(Get-CimInstance Win32_Process -Filter "ParentProcessId=$($HostProcess.Id)" | Select-Object ProcessId,ParentProcessId,Name,SessionId)
      }
    } catch { $EvoCollectorErrors += "Host metadata: $($_.Exception.Message)" }
  }
  # Copy only this synthetic profile's filtered host/backend log, never its database or browser data.
  $EvoLifecycle = @()
  foreach ($EvoLogName in @('backend-stderr.log.1','backend-stderr.log')) {
    $EvoLogPath = Join-Path $Profile $EvoLogName
    if (Test-Path -LiteralPath $EvoLogPath) {
      try {
        $EvoLogLines = @(Get-Content -LiteralPath $EvoLogPath -Tail 200 | ForEach-Object { $_.Substring(0, [Math]::Min($_.Length, 4096)) })
        $EvoLogLines | Set-Content -LiteralPath (Join-Path $EvoDiagnosticsDirectory $EvoLogName) -Encoding utf8
        $EvoLifecycle += @($EvoLogLines | Where-Object { $_ -match '^\d+ host: (starting sidecar|sidecar spawn failed|sidecar identity verified|initializing GPUI|GPUI initialized|creating GPUI window|GPUI window created|creating WebView2|WebView2 created|WebView2 initialization failed|window activation scheduled|frontend document served|frontend asset response status [1-5]\d\d|renderer dispatch started|renderer dispatch lost its window|renderer navigation started|renderer subscribed|React renderer ready \(GPUI \+ Wry\)|shutdown requested)$' })
      } catch { $EvoCollectorErrors += "Filtered log: $($_.Exception.Message)" }
    }
  }
  $EvoSnapshot = [ordered]@{
    stage=$Stage;failure=$Failure;recordedAt=[DateTime]::UtcNow.ToString('o')
    runner=[ordered]@{pid=$PID;sessionId=[Diagnostics.Process]::GetCurrentProcess().SessionId;userInteractive=[Environment]::UserInteractive;monitorCount=$EvoMonitorCount}
    host=$EvoHostState;windows=$EvoWindows;directChildren=$EvoChildren;hostLifecycle=@($EvoLifecycle | Select-Object -Last 30)
    profile=[ordered]@{databaseExists=(Test-Path -LiteralPath (Join-Path $Profile 'evostack.sqlite3'));rendererReadyExists=(Test-Path -LiteralPath (Join-Path $Profile 'renderer-ready.json'))}
    collectorErrors=$EvoCollectorErrors
  }
  $EvoSnapshot | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $EvoDiagnosticsDirectory ($Stage + '.json')) -Encoding utf8
  Write-Output ('Packaged smoke diagnostics: ' + (ConvertTo-Json -InputObject $EvoSnapshot -Depth 6 -Compress))
}
