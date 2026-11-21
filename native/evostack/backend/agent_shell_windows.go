//go:build windows

package main

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

func nativeAgentWindowsCommand(ctx context.Context, path string, arguments ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, path, arguments...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true, CreationFlags: windows.CREATE_NO_WINDOW}
	return cmd
}

func nativeAgentShell(ctx context.Context, command string) *exec.Cmd {
	system := filepath.Join(os.Getenv("SystemRoot"), "System32")
	cmd := nativeAgentWindowsCommand(ctx, filepath.Join(system, "WindowsPowerShell", "v1.0", "powershell.exe"), "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", command)
	cmd.Cancel = func() error {
		killContext, cancel := context.WithTimeout(context.Background(), 3*time.Second)
		defer cancel()
		// /T stops descendants as well as the shell so Stop does not leave a
		// still-running command behind after the renderer has detached.
		kill := nativeAgentWindowsCommand(killContext, filepath.Join(system, "taskkill.exe"), "/T", "/F", "/PID", fmt.Sprint(cmd.Process.Pid))
		if err := kill.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
	return cmd
}

func openNativeAgentRead(root *os.Root, path string) (*os.File, error) {
	return root.Open(path)
}
