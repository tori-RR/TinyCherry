//go:build windows

package main

import (
	"errors"
	"net/http"
	"net/url"
	"unsafe"

	"golang.org/x/sys/windows"
)

var winHTTP = windows.NewLazySystemDLL("winhttp.dll")
var getIEProxy = winHTTP.NewProc("WinHttpGetIEProxyConfigForCurrentUser")
var openWinHTTP = winHTTP.NewProc("WinHttpOpen")
var closeWinHTTP = winHTTP.NewProc("WinHttpCloseHandle")
var setWinHTTPTimeouts = winHTTP.NewProc("WinHttpSetTimeouts")
var getProxyForURL = winHTTP.NewProc("WinHttpGetProxyForUrl")
var freeProxyMemory = windows.NewLazySystemDLL("kernel32.dll").NewProc("GlobalFree")

type windowsProxyConfig struct {
	autoDetect                   int32
	autoConfigURL, proxy, bypass *uint16
}
type windowsAutoProxyOptions struct {
	flags, autoDetectFlags uint32
	autoConfigURL          *uint16
	reserved               uintptr
	reservedFlags          uint32
	autoLogon              int32
}
type windowsProxyInfo struct {
	accessType    uint32
	proxy, bypass *uint16
}

// Bound native PAC resolution even if a cancelled WinHTTP lookup drains late.
var proxyLookups = make(chan struct{}, 8)

func proxyString(value *uint16) string {
	return windows.UTF16PtrToString(value)
}
func releaseProxyString(value *uint16) {
	if value != nil {
		_, _, _ = freeProxyMemory.Call(uintptr(unsafe.Pointer(value)))
	}
}

// Read the interactive Windows user's system settings, including PAC/WPAD.
// https://learn.microsoft.com/windows/win32/winhttp/setting-wininet-proxy-configurations-in-winhttp
func systemProxy(request *http.Request) (*url.URL, error) {
	var config windowsProxyConfig
	ok, _, err := getIEProxy.Call(uintptr(unsafe.Pointer(&config)))
	defer releaseProxyString(config.autoConfigURL)
	defer releaseProxyString(config.proxy)
	defer releaseProxyString(config.bypass)
	if ok == 0 {
		if err == windows.ERROR_FILE_NOT_FOUND {
			return nil, nil
		}
		return nil, errors.New("Windows system proxy settings are unavailable")
	}
	servers, bypass := proxyString(config.proxy), proxyString(config.bypass)
	pac := proxyString(config.autoConfigURL)
	if pac == "" && config.autoDetect == 0 {
		return systemProxyAddress(request.URL, servers, bypass)
	}
	type result struct {
		proxy *url.URL
		err   error
	}
	select {
	case proxyLookups <- struct{}{}:
	case <-request.Context().Done():
		return nil, request.Context().Err()
	}
	results := make(chan result, 1)
	go func() {
		defer func() { <-proxyLookups }()
		address, err := resolveWindowsAutoProxy(request.URL, pac, config.autoDetect != 0)
		if err != nil && pac == "" { // WPAD is optional; retain the user's static/direct settings.
			address, err = systemProxyAddress(request.URL, servers, bypass)
		}
		results <- result{address, err}
	}()
	select {
	case resolved := <-results:
		return resolved.proxy, resolved.err
	case <-request.Context().Done():
		return nil, request.Context().Err()
	}
}

func resolveWindowsAutoProxy(target *url.URL, pac string, detect bool) (*url.URL, error) {
	agent, _ := windows.UTF16PtrFromString("TinyCherry EvoStack")
	session, _, _ := openWinHTTP.Call(uintptr(unsafe.Pointer(agent)), 1, 0, 0, 0)
	if session == 0 {
		return nil, errors.New("Windows proxy resolver could not start")
	}
	defer closeWinHTTP.Call(session)
	if ok, _, _ := setWinHTTPTimeouts.Call(session, 5000, 5000, 5000, 5000); ok == 0 {
		return nil, errors.New("Windows proxy resolver timeout could not be configured")
	}
	options := windowsAutoProxyOptions{}
	if detect {
		options.flags |= 1
		options.autoDetectFlags = 3
	}
	if pac != "" {
		options.flags |= 2
		var err error
		options.autoConfigURL, err = windows.UTF16PtrFromString(pac)
		if err != nil {
			return nil, errors.New("invalid Windows proxy configuration")
		}
	}
	address, err := windows.UTF16PtrFromString(target.String())
	if err != nil {
		return nil, errors.New("invalid proxy target URL")
	}
	var info windowsProxyInfo
	ok, _, _ := getProxyForURL.Call(session, uintptr(unsafe.Pointer(address)), uintptr(unsafe.Pointer(&options)), uintptr(unsafe.Pointer(&info)))
	defer releaseProxyString(info.proxy)
	defer releaseProxyString(info.bypass)
	if ok == 0 {
		return nil, errors.New("Windows automatic proxy resolution failed")
	}
	if info.accessType == 1 {
		return nil, nil
	}
	return systemProxyAddress(target, proxyString(info.proxy), proxyString(info.bypass))
}
