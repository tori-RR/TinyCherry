//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestNativeAgentWindowsEnvironmentPreservesSystemPathsWithoutSecrets(t *testing.T) {
	t.Setenv("PSModuleAnalysisCachePath", filepath.Join(t.TempDir(), "module-cache"))
	for _, key := range []string{"OPENAI_API_KEY", "EVOSTACK_BACKEND_TOKEN", "PSModulePath"} {
		t.Setenv(key, "must-not-reach-agent-shell")
	}
	environment := map[string]string{}
	for _, entry := range agentShellEnvironment() {
		key, value, _ := strings.Cut(entry, "=")
		environment[strings.ToUpper(key)] = value
	}
	for _, key := range []string{"SystemRoot", "USERPROFILE", "ProgramFiles", "ProgramFiles(x86)", "ProgramW6432", "CommonProgramFiles", "CommonProgramFiles(x86)", "CommonProgramW6432", "APPDATA", "LOCALAPPDATA", "ProgramData", "ALLUSERSPROFILE", "PUBLIC", "SystemDrive", "HOMEDRIVE", "HOMEPATH", "PSModuleAnalysisCachePath"} {
		if value, exists := os.LookupEnv(key); exists && environment[strings.ToUpper(key)] != value {
			t.Errorf("agent environment dropped Windows runtime directory %s", key)
		}
	}
	for _, key := range []string{"OPENAI_API_KEY", "EVOSTACK_BACKEND_TOKEN", "PSMODULEPATH"} {
		if _, exists := environment[key]; exists {
			t.Errorf("agent environment inherited %s", key)
		}
	}
}

func nativeAgentWindowsStartMarker(workspace string) (string, string) {
	path := filepath.Join(workspace, "powershell.started")
	return path, nativeAgentWindowsMark(path, "started")
}

func nativeAgentWindowsMark(path, stage string) string {
	return `[System.IO.File]::WriteAllText('` + strings.ReplaceAll(path, "'", "''") + `', '` + stage + `'); `
}

func nativeAgentWindowsOutputScript(workspace string) (string, string) {
	marker, prefix := nativeAgentWindowsStartMarker(workspace)
	return marker, prefix + `[Console]::WriteLine('console-ready'); ` + nativeAgentWindowsMark(marker, "console") +
		`$null = Write-Output 'cmdlet-ready'; ` + nativeAgentWindowsMark(marker, "cmdlet") +
		`'Hello Cherry'; ` + nativeAgentWindowsMark(marker, "formatted") + `exit 0`
}

func TestNativeAgentWindowsShellCapturesOutputWithoutConsole(t *testing.T) {
	// The tool's ten-second deadline remains the execution limit. An outer
	// deadline at the same instant discarded its captured output on failure.
	ctx := context.Background()
	cmd := nativeAgentShell(ctx, "Write-Output 'Hello Cherry'")
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("agent PowerShell would open a console window")
	}
	terminator := nativeAgentWindowsCommand(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/?")
	if terminator.SysProcAttr == nil || !terminator.SysProcAttr.HideWindow || terminator.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("agent Stop would open a taskkill console window")
	}
	workspace := t.TempDir()
	marker, script := nativeAgentWindowsOutputScript(workspace)
	result, err := runAgentShell(ctx, workspace, ".", object{"command": script, "timeout_seconds": float64(10)})
	started, _ := os.ReadFile(marker)
	if err != nil || result["exitCode"] != 0 || result["timedOut"] != false || !strings.Contains(text(result["output"]), "Hello Cherry") || string(started) != "formatted" {
		t.Fatalf("PowerShell did not finish within its ten-second limit: stage=%q result=%v error=%v", started, result, err)
	}
}

func TestNativeAgentWindowsStopTerminatesShellAndChild(t *testing.T) {
	workspace := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A real child process is used so this catches cancellation that kills only
	// PowerShell but leaves an approved command running after the UI says Stop.
	marker, prefix := nativeAgentWindowsStartMarker(workspace)
	script := prefix + `$child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden; Set-Content -LiteralPath 'child.pid' -Value $child.Id; Start-Sleep -Seconds 30`
	done := make(chan error, 1)
	go func() {
		_, err := runAgentShell(ctx, workspace, ".", object{"command": script, "timeout_seconds": float64(60)})
		done <- err
	}()
	var childID uint64
	deadline := time.Now().Add(10 * time.Second)
	for time.Now().Before(deadline) {
		if data, err := os.ReadFile(filepath.Join(workspace, "child.pid")); err == nil {
			childID, _ = strconv.ParseUint(strings.TrimSpace(string(data)), 10, 32)
			if childID != 0 {
				break
			}
		}
		select {
		case err := <-done:
			t.Fatal("PowerShell exited before spawning its child", err)
		default:
		}
		time.Sleep(10 * time.Millisecond)
	}
	if childID == 0 {
		cancel()
		started, _ := os.ReadFile(marker)
		pid, _ := os.ReadFile(filepath.Join(workspace, "child.pid"))
		select {
		case err := <-done:
			t.Fatalf("PowerShell child did not start within ten seconds: engineStarted=%t childPID=%q error=%v", string(started) == "started", pid, err)
		case <-time.After(5 * time.Second):
			t.Fatalf("PowerShell startup and cancellation did not finish: engineStarted=%t childPID=%q", string(started) == "started", pid)
		}
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_TERMINATE, false, uint32(childID))
	if err != nil {
		t.Fatal("cannot observe PowerShell child", err)
	}
	defer windows.CloseHandle(handle)
	defer windows.TerminateProcess(handle, 1)
	cancel()
	select {
	case err := <-done:
		if !errors.Is(err, context.Canceled) {
			t.Fatal("cancelled shell did not report cancellation", err)
		}
	case <-time.After(5 * time.Second):
		t.Fatal("Stop did not end the shell promptly")
	}
	status, err := windows.WaitForSingleObject(handle, 3000)
	if err != nil || status != windows.WAIT_OBJECT_0 {
		t.Fatal("Stop left the shell child running", status, err)
	}
}
