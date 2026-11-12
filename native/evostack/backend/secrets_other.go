//go:build !windows

package main

import "errors"

func sealSecret([]byte) ([]byte, error) {
	return nil, errors.New("credential storage is implemented for Windows only in this trial")
}
func unsealSecret([]byte) ([]byte, error) {
	return nil, errors.New("credential storage is implemented for Windows only in this trial")
}
