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

func TestNativeAgentWindowsShellCapturesOutputWithoutConsole(t *testing.T) {
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	cmd := nativeAgentShell(ctx, "Write-Output 'Hello Cherry'")
	if cmd.SysProcAttr == nil || !cmd.SysProcAttr.HideWindow || cmd.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("agent PowerShell would open a console window")
	}
	terminator := nativeAgentWindowsCommand(ctx, filepath.Join(os.Getenv("SystemRoot"), "System32", "taskkill.exe"), "/?")
	if terminator.SysProcAttr == nil || !terminator.SysProcAttr.HideWindow || terminator.SysProcAttr.CreationFlags&windows.CREATE_NO_WINDOW == 0 {
		t.Fatal("agent Stop would open a taskkill console window")
	}
	result, err := runAgentShell(ctx, t.TempDir(), ".", object{"command": "Write-Output 'Hello Cherry'", "timeout_seconds": float64(10)})
	if err != nil || result["exitCode"] != 0 || !strings.Contains(text(result["output"]), "Hello Cherry") {
		t.Fatal("PowerShell output was not captured", result, err)
	}
}

func TestNativeAgentWindowsStopTerminatesShellAndChild(t *testing.T) {
	workspace := t.TempDir()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	// A real child process is used so this catches cancellation that kills only
	// PowerShell but leaves an approved command running after the UI says Stop.
	script := `$child = Start-Process -FilePath "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe" -ArgumentList @('-NoLogo','-NoProfile','-NonInteractive','-Command','Start-Sleep -Seconds 30') -PassThru -WindowStyle Hidden; Set-Content -LiteralPath 'child.pid' -Value $child.Id; Start-Sleep -Seconds 30`
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
		<-done
		t.Fatal("PowerShell child did not start")
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
