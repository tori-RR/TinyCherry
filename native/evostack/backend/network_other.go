//go:build !windows

package main

import (
	"net/http"
	"net/url"
)

func systemProxy(request *http.Request) (*url.URL, error) { return http.ProxyFromEnvironment(request) }
