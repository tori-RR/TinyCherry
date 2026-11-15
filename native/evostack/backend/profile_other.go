//go:build !windows

package main

import "errors"

func lockProfile(string) (func(), error) {
	return nil, errors.New("this desktop trial targets Windows")
}
