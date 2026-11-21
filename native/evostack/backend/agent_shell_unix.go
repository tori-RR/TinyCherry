//go:build !windows

package main

import (
	"context"
	"errors"
	"os"
	"os/exec"
	"syscall"
)

func nativeAgentShell(ctx context.Context, command string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "/bin/sh", "-c", command)
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}
	cmd.Cancel = func() error {
		err := syscall.Kill(-cmd.Process.Pid, syscall.SIGKILL)
		if errors.Is(err, syscall.ESRCH) {
			return os.ErrProcessDone
		}
		return err
	}
	return cmd
}

func openNativeAgentRead(root *os.Root, path string) (*os.File, error) {
	// Recheck the opened descriptor before reading. O_NONBLOCK prevents a raced
	// regular-file-to-FIFO substitution from stranding a cancelled agent turn.
	return root.OpenFile(path, os.O_RDONLY|syscall.O_NONBLOCK, 0)
}
