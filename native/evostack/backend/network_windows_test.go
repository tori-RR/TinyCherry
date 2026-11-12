//go:build windows

package main

import (
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestWindowsAutoProxyResolvesOwnedLoopbackPAC(t *testing.T) {
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer proxy.Close()
	pac := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/x-ns-proxy-autoconfig")
		fmt.Fprintf(w, `function FindProxyForURL(url, host) { return "PROXY %s"; }`, strings.TrimPrefix(proxy.URL, "http://"))
	}))
	defer pac.Close()
	// No request is sent to this reserved hostname: PAC returns our loopback proxy
	// unconditionally and performs no DNS lookups. WinHTTP bypasses literal loopback.
	target, _ := url.Parse("http://tinycherry-pac-target.invalid/owned-proxy-probe")
	actual, err := resolveWindowsAutoProxy(target, pac.URL+"/owned.pac", false)
	if err != nil {
		t.Fatal(err)
	}
	if actual == nil || actual.String() != proxy.URL {
		t.Fatalf("Windows PAC resolver returned %v; want %s", actual, proxy.URL)
	}
}
