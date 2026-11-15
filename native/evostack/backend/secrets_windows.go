package main

import (
	"errors"
	"syscall"
	"unsafe"
)

var crypt32 = syscall.NewLazyDLL("crypt32.dll")
var protectData = crypt32.NewProc("CryptProtectData")
var unprotectData = crypt32.NewProc("CryptUnprotectData")
var localFree = syscall.NewLazyDLL("kernel32.dll").NewProc("LocalFree")

type dataBlob struct {
	length uint32
	data   *byte
}

func cryptSecret(data []byte, decrypt bool) ([]byte, error) {
	if len(data) == 0 {
		return nil, errors.New("empty credential")
	}
	input := dataBlob{uint32(len(data)), &data[0]}
	output := dataBlob{}
	operation := protectData
	if decrypt {
		operation = unprotectData
	}
	ok, _, _ := operation.Call(uintptr(unsafe.Pointer(&input)), 0, 0, 0, 0, 1, uintptr(unsafe.Pointer(&output)))
	if ok == 0 {
		return nil, errors.New("Windows credential protection failed")
	}
	defer localFree.Call(uintptr(unsafe.Pointer(output.data)))
	return append([]byte(nil), unsafe.Slice(output.data, int(output.length))...), nil
}
func sealSecret(data []byte) ([]byte, error)   { return cryptSecret(data, false) }
func unsealSecret(data []byte) ([]byte, error) { return cryptSecret(data, true) }
