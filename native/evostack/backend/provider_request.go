package main

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"net"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type providerRequestConfig struct {
	address string
	headers http.Header
	network networkSettings
}

func (s *server) providerKey(provider object, override string) (string, error) {
	if override != "" {
		return override, nil
	}
	for _, item := range array(provider["apiKeys"]) {
		entry := obj(item)
		if entry["isEnabled"] == true {
			return s.store.secret(text(provider["id"]) + ":" + text(entry["id"]))
		}
	}
	return "", nil
}

// Called while the caller owns its short store/state access; network work happens later.
func (s *server) resolveProviderRequest(provider object, base, key, resource string) (providerRequestConfig, error) {
	address, err := providerEndpoint(provider, base, resource)
	if err != nil {
		return providerRequestConfig{}, err
	}
	network, err := resolveNetworkSettings(s.store)
	if err != nil {
		return providerRequestConfig{}, err
	}
	headers := http.Header{"Content-Type": {"application/json"}}
	if key != "" {
		headers.Set("Authorization", "Bearer "+key)
	}
	seen := map[string]bool{}
	for name, raw := range obj(obj(provider["settings"])["extraHeaders"]) {
		if raw == nil { // Legacy merge-patch tombstones are absence, not the text "null".
			continue
		}
		value, ok := raw.(string)
		canonical := http.CanonicalHeaderKey(name)
		if !ok || !validHeaderName(name) || strings.ContainsAny(value, "\r\n\x00") || seen[canonical] {
			return providerRequestConfig{}, errors.New("invalid provider custom headers")
		}
		seen[canonical] = true
		switch canonical {
		case "Host", "Content-Length", "Transfer-Encoding", "Connection", "Proxy-Authorization":
			return providerRequestConfig{}, errors.New("provider custom headers cannot override HTTP transport headers")
		}
		// Match the original case-insensitive, explicit-custom-value precedence.
		headers.Set(canonical, value)
	}
	if key == "" && headers.Get("Authorization") == "" && provider["authOptional"] != true {
		return providerRequestConfig{}, errors.New("provider API key is missing")
	}
	return providerRequestConfig{address: address, headers: headers, network: network}, nil
}

func validHeaderName(name string) bool {
	if name == "" {
		return false
	}
	for _, char := range name {
		if !(char >= 'a' && char <= 'z') && !(char >= 'A' && char <= 'Z') && !(char >= '0' && char <= '9') && !strings.ContainsRune("!#$%&'*+-.^_`|~", char) {
			return false
		}
	}
	return true
}

func (config providerRequestConfig) request(ctx context.Context, method string, body io.Reader, stream bool) (*http.Request, error) {
	request, err := http.NewRequestWithContext(ctx, method, config.address, body)
	if err != nil {
		return nil, errors.New("invalid provider request")
	}
	request.Header = config.headers.Clone()
	// A reused connection must never make net/http replay a billable POST.
	request.GetBody = nil
	if stream && request.Header.Get("Accept") == "" {
		request.Header.Set("Accept", "text/event-stream")
	}
	return request, nil
}

var providerVersionPath = regexp.MustCompile(`(?i)/v[0-9]+(?:alpha|beta)?(?:/|$)`)

func providerEndpoint(provider object, base, resource string) (string, error) {
	parsed, err := url.Parse(strings.TrimSpace(base))
	if err != nil || parsed.Host == "" || parsed.User != nil || parsed.Fragment != "" || parsed.RawQuery != "" || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return "", errors.New("invalid provider URL: use an HTTP(S) base URL without credentials, query or fragment")
	}
	path := strings.TrimRight(parsed.EscapedPath(), "/")
	if strings.HasSuffix(path, "/chat/completions") {
		path = strings.TrimSuffix(path, "/chat/completions")
	} else if strings.HasSuffix(path, "/models") {
		path = strings.TrimSuffix(path, "/models")
	}
	if !strings.HasSuffix(strings.TrimSpace(base), "#") && !providerUsesRootPath(provider, parsed.Hostname()) && !providerVersionPath.MatchString(path) {
		path += "/v1"
	}
	parsed.RawPath = path + "/" + resource
	parsed.Path, err = url.PathUnescape(parsed.RawPath)
	if err != nil {
		return "", errors.New("invalid provider URL path")
	}
	return parsed.String(), nil
}

func providerUsesRootPath(provider object, host string) bool {
	for _, id := range []string{text(provider["id"]), text(provider["presetProviderId"])} {
		switch id {
		case "copilot", "cherryai", "perplexity", "newapi", "new-api", "azure-openai":
			return true
		}
	}
	config := obj(obj(provider["endpointConfigs"])["openai-chat-completions"])
	// The legacy base-only helper also retains the known Perplexity root contract.
	return config["adapterFamily"] == "perplexity" || strings.EqualFold(host, "api.perplexity.ai")
}

func endpoint(base, resource string) (string, error) {
	return providerEndpoint(nil, base, resource)
}

func probeTimeout(input any) time.Duration {
	value, ok := input.(float64)
	if !ok {
		if integer, valid := input.(int); valid {
			value, ok = float64(integer), true
		}
	}
	if !ok || math.IsNaN(value) || math.IsInf(value, 0) || value <= 0 || value > 30000 {
		return 30 * time.Second
	}
	if value < 1 {
		value = 1
	}
	return time.Duration(value * float64(time.Millisecond))
}

func validateProbeBody(reader io.Reader) error {
	const limit = 1024 * 1024
	data, err := io.ReadAll(io.LimitReader(reader, limit+1))
	if err != nil || len(data) > limit {
		return errors.New("model check response could not be read within its limit")
	}
	var body struct {
		Error   json.RawMessage `json:"error"`
		Choices []struct {
			Message *struct {
				Role      string          `json:"role"`
				Content   json.RawMessage `json:"content"`
				ToolCalls json.RawMessage `json:"tool_calls"`
			} `json:"message"`
		} `json:"choices"`
	}
	if json.Unmarshal(data, &body) != nil || len(body.Choices) == 0 || (len(body.Error) > 0 && string(body.Error) != "null") {
		return errors.New("model check returned an invalid completion response")
	}
	message := body.Choices[0].Message
	if message == nil || message.Role != "assistant" || (len(message.Content) == 0 && len(message.ToolCalls) == 0) {
		return errors.New("model check returned an invalid completion message")
	}
	if len(message.Content) > 0 && string(message.Content) != "null" {
		var content any
		if json.Unmarshal(message.Content, &content) != nil {
			return errors.New("invalid model check content")
		}
		switch content.(type) {
		case string, []any:
		default:
			return errors.New("invalid model check content")
		}
	}
	if len(message.ToolCalls) > 0 && string(message.ToolCalls) != "null" {
		var calls []object
		if json.Unmarshal(message.ToolCalls, &calls) != nil {
			return errors.New("invalid model check tool calls")
		}
	}
	return nil
}

// A transport is owned by one request/generation and never uses global client configuration.
func (settings networkSettings) client() *http.Client {
	return &http.Client{
		Transport:     newNetworkTransport(settings),
		CheckRedirect: noProviderRedirect,
	}
}

func newNetworkTransport(settings networkSettings) *http.Transport {
	return &http.Transport{Proxy: settings.proxy, DialContext: (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext, ResponseHeaderTimeout: 30 * time.Second, TLSHandshakeTimeout: 10 * time.Second, ForceAttemptHTTP2: true, MaxIdleConns: 32, MaxIdleConnsPerHost: 4, MaxConnsPerHost: 8, IdleConnTimeout: 30 * time.Second}
}
