package main

import (
	"errors"
	"net"
	"net/http"
	"net/netip"
	"net/url"
	"regexp"
	"strconv"
	"strings"
)

type networkSettings struct {
	mode          string
	url           *url.URL
	bypass        []string
	resolveSystem func(*http.Request) (*url.URL, error)
}

// This snapshot does no OS resolution or HTTP while a caller owns store/state access.
func resolveNetworkSettings(repository *store) (networkSettings, error) {
	mode, err := repository.preference("app.proxy.mode")
	if err != nil {
		return networkSettings{}, err
	}
	address, err := repository.preference("app.proxy.url")
	if err != nil {
		return networkSettings{}, err
	}
	bypass, err := repository.preference("app.proxy.bypass_rules")
	if err != nil {
		return networkSettings{}, err
	}
	return parseNetworkSettings(text(mode), text(address), text(bypass))
}

func parseNetworkSettings(mode, address, bypass string) (networkSettings, error) {
	settings := networkSettings{mode: mode, bypass: strings.FieldsFunc(bypass, func(r rune) bool { return r == ',' || r == ';' })}
	switch mode {
	case "", "system":
		settings.mode = "system"
	case "none":
	case "custom":
		if strings.TrimSpace(address) == "" {
			settings.mode = "none" // Original custom-without-URL policy is direct.
			break
		}
		parsed, err := parseProxyURL(address)
		if err != nil {
			return networkSettings{}, err
		}
		settings.url = parsed
	default:
		return networkSettings{}, errors.New("invalid application proxy mode")
	}
	return settings, nil
}

func parseProxyURL(address string) (*url.URL, error) {
	parsed, err := url.Parse(strings.TrimSpace(address))
	if err != nil || parsed.Hostname() == "" || parsed.RawQuery != "" || parsed.Fragment != "" || (parsed.Path != "" && parsed.Path != "/") {
		return nil, errors.New("invalid application proxy URL")
	}
	parsed.Scheme = strings.ToLower(parsed.Scheme)
	if port := parsed.Port(); port != "" {
		value, err := strconv.Atoi(port)
		if err != nil || value < 1 || value > 65535 {
			return nil, errors.New("invalid application proxy port")
		}
	}
	switch parsed.Scheme {
	case "http", "https", "socks5", "socks5h":
	case "socks":
		parsed.Scheme = "socks5"
	default:
		return nil, errors.New("unsupported application proxy protocol")
	}
	if parsed.Scheme == "socks5" || parsed.Scheme == "socks5h" {
		if parsed.Port() == "" {
			return nil, errors.New("SOCKS proxy URL requires a port")
		}
	}
	return parsed, nil
}

func (settings networkSettings) proxy(request *http.Request) (*url.URL, error) {
	if settings.mode == "none" || bypassProxy(request.URL, settings.bypass) {
		return nil, nil
	}
	if settings.mode == "custom" {
		return settings.url, nil
	}
	if settings.resolveSystem != nil {
		return settings.resolveSystem(request)
	}
	return systemProxy(request)
}

func implicitProxyBypass(host string) bool {
	host = strings.ToLower(strings.TrimSuffix(host, "."))
	if host == "localhost" || strings.HasSuffix(host, ".localhost") || host == "loopback" || host == "localhost6" || host == "localhost6.localdomain6" {
		return true
	}
	ip, err := netip.ParseAddr(host)
	return err == nil && (ip.Unmap().IsLoopback() || ip.Unmap().IsLinkLocalUnicast() || ip.Unmap().IsUnspecified())
}

// Match the UI's Chromium-style rule syntax without resolving target hostnames.
func bypassProxy(target *url.URL, rules []string) bool {
	host := strings.ToLower(strings.TrimSuffix(target.Hostname(), "."))
	for index := len(rules) - 1; index >= 0; index-- {
		rule := strings.TrimSpace(rules[index])
		if strings.EqualFold(rule, "<-loopback>") {
			if implicitProxyBypass(host) {
				return false
			}
			continue
		}
		if matchProxyBypass(target, rule) {
			return true
		}
	}
	return implicitProxyBypass(host)
}

func matchProxyBypass(target *url.URL, rule string) bool {
	host := strings.ToLower(strings.TrimSuffix(target.Hostname(), "."))
	if rule == "*" {
		return true
	}
	if rule == "<local>" {
		if address, err := netip.ParseAddr(host); err == nil {
			return address.Unmap().IsLoopback()
		}
		return !strings.Contains(host, ".")
	}
	if before, after, ok := strings.Cut(rule, "://"); ok {
		if !strings.EqualFold(before, target.Scheme) {
			return false
		}
		rule = after
	}
	cleaned := strings.ReplaceAll(strings.ReplaceAll(rule, "[", ""), "]", "")
	if prefix, err := netip.ParsePrefix(cleaned); err == nil {
		ip, err := netip.ParseAddr(host)
		return err == nil && prefix.Contains(ip)
	}
	if _, err := netip.ParseAddr(rule); err != nil {
		if name, port, err := net.SplitHostPort(rule); err == nil {
			actualPort := target.Port()
			if actualPort == "" {
				if target.Scheme == "https" {
					actualPort = "443"
				} else {
					actualPort = "80"
				}
			}
			if port != actualPort {
				return false
			}
			rule = name
		} else if strings.Count(rule, ":") == 1 {
			name, port, ok := strings.Cut(rule, ":")
			if ok {
				actualPort := target.Port()
				if actualPort == "" {
					if target.Scheme == "https" {
						actualPort = "443"
					} else {
						actualPort = "80"
					}
				}
				if port != actualPort {
					return false
				}
				rule = name
			}
		}
	}
	rule = strings.ToLower(strings.TrimSuffix(strings.Trim(rule, "[]"), "."))
	if ip, err := netip.ParseAddr(rule); err == nil {
		actual, err := netip.ParseAddr(host)
		return err == nil && ip.Unmap() == actual.Unmap()
	}
	if strings.HasPrefix(rule, "*.") || strings.HasPrefix(rule, ".") {
		suffix := strings.TrimPrefix(strings.TrimPrefix(rule, "*"), ".")
		return host == suffix || strings.HasSuffix(host, "."+suffix)
	}
	if strings.Contains(rule, "*") {
		pattern := "^" + strings.ReplaceAll(regexp.QuoteMeta(rule), "\\*", ".*") + "$"
		matched, _ := regexp.MatchString(pattern, host)
		return matched
	}
	return rule != "" && rule == host
}

func systemProxyAddress(target *url.URL, servers, bypass string) (*url.URL, error) {
	for _, rule := range strings.FieldsFunc(bypass, func(r rune) bool { return r == ',' || r == ';' }) {
		if matchProxyBypass(target, strings.TrimSpace(rule)) {
			return nil, nil
		}
	}
	fallback := ""
	for _, entry := range strings.FieldsFunc(servers, func(r rune) bool { return r == ';' }) {
		entry = strings.TrimSpace(entry)
		if scheme, address, ok := strings.Cut(entry, "="); ok {
			if strings.EqualFold(scheme, target.Scheme) {
				fallback = address
				break
			}
			if strings.EqualFold(scheme, "socks") && fallback == "" {
				fallback = "socks5://" + address
			}
		} else if fallback == "" {
			fallback = entry
		}
	}
	if fallback == "" || strings.EqualFold(fallback, "DIRECT") {
		return nil, nil
	}
	if strings.HasPrefix(strings.ToUpper(fallback), "PROXY ") {
		fallback = strings.TrimSpace(fallback[6:])
	}
	if !strings.Contains(fallback, "://") {
		fallback = "http://" + fallback
	}
	return parseProxyURL(fallback)
}
