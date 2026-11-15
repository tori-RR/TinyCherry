package main

import (
	"context"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"
)

const proxyTestTarget = "https://www.gstatic.com/generate_204"

func (s *server) testProxyConnection(input object) (any, error) {
	return s.testProxyTarget(input, proxyTestTarget), nil
}

// target is internal-only so tests use loopback; the IPC route has no target override.
func (s *server) testProxyTarget(input object, target string) object {
	result := object{"target": target, "route": "proxy", "success": false}
	mode, modeOK := input["mode"].(string)
	address, addressOK := input["url"].(string)
	bypass, bypassOK := input["bypassRules"].(string)
	if !modeOK || !addressOK || !bypassOK || (mode != "system" && mode != "custom" && mode != "none") {
		result["error"] = "invalid_config"
		return result
	}
	settings, err := parseNetworkSettings(mode, address, bypass)
	if err != nil {
		result["error"] = "invalid_config"
		return result
	}
	ctx, cancel := context.WithTimeout(s.context, 10*time.Second)
	defer cancel()
	request, err := http.NewRequestWithContext(ctx, http.MethodGet, target, nil)
	if err != nil {
		result["error"] = "invalid_config"
		return result
	}
	proxy, err := settings.proxy(request)
	if err != nil {
		result["error"] = proxyTestError(err)
		return result
	}
	switch {
	case mode == "custom" && strings.TrimSpace(address) == "":
		result["route"] = "fallback"
	case mode != "none" && bypassProxy(request.URL, settings.bypass):
		result["route"] = "bypassed"
	case proxy == nil:
		result["route"] = "direct"
	}
	client := settings.client()
	defer client.CloseIdleConnections()
	// Reuse the route just resolved, without a second PAC/system lookup.
	client.Transport.(*http.Transport).Proxy = http.ProxyURL(proxy)
	response, err := client.Do(request)
	if err != nil {
		result["error"] = proxyTestError(err)
		return result
	}
	defer response.Body.Close()
	if response.StatusCode == http.StatusProxyAuthRequired {
		result["error"] = "authentication_required"
		return result
	}
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		result["error"] = "http_error"
		return result
	}
	result["success"] = true
	return result
}

func proxyTestError(err error) string {
	var networkError net.Error
	if errors.Is(err, context.DeadlineExceeded) || (errors.As(err, &networkError) && networkError.Timeout()) {
		return "timeout"
	}
	message := strings.ToLower(err.Error())
	if strings.Contains(message, "407") || strings.Contains(message, "proxy authentication") {
		return "authentication_required"
	}
	var operation *net.OpError
	var dns *net.DNSError
	if errors.As(err, &operation) || errors.As(err, &dns) {
		return "unreachable"
	}
	return "connection_failed"
}
