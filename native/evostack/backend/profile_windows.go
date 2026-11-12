package main

import (
	"errors"
	"os"
	"path/filepath"
	"syscall"
)

func lockProfile(directory string) (func(), error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("absolute data directory required")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	path, err := syscall.UTF16PtrFromString(filepath.Join(directory, "backend.lock"))
	if err != nil {
		return nil, err
	}
	handle, err := syscall.CreateFile(path, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL, 0)
	if err != nil {
		return nil, errors.New("EvoStack profile is already in use")
	}
	return func() { _ = syscall.CloseHandle(handle) }, nil
}
