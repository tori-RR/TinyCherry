package main

import (
	"context"
	"fmt"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"sync/atomic"
	"testing"
)

func TestApplicationProxyModesRouteRealProbeRequests(t *testing.T) {
	t.Setenv("HTTP_PROXY", "http://127.0.0.1:1")
	for _, scenario := range []struct {
		name, mode, bypass string
		viaProxy           bool
	}{
		{"none-overrides-environment", "none", "<-loopback>", false},
		{"custom-implicit-loopback", "custom", "", false},
		{"custom-explicit-proxy-loopback", "custom", "<-loopback>", true},
		{"last-negative-wins", "custom", "127.0.0.1,<-loopback>", true},
		{"last-positive-wins", "custom", "<-loopback>,127.0.0.1", false},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			var directCalls, proxyCalls atomic.Int32
			completion := `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`
			target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { directCalls.Add(1); fmt.Fprint(w, completion) }))
			defer target.Close()
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				proxyCalls.Add(1)
				if !r.URL.IsAbs() || r.URL.Path != "/v1/chat/completions" {
					t.Errorf("wrong proxied request: %s", r.URL)
				}
				fmt.Fprint(w, completion)
			}))
			defer proxy.Close()
			s, _ := testServer(t)
			seedChat(t, s, target.URL)
			for key, value := range (object{"app.proxy.mode": scenario.mode, "app.proxy.url": proxy.URL, "app.proxy.bypass_rules": scenario.bypass}) {
				if err := s.store.setPreference(key, value); err != nil {
					t.Fatal(err)
				}
			}
			if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local"}); err != nil {
				t.Fatal(err)
			}
			if (proxyCalls.Load() == 1) != scenario.viaProxy || directCalls.Load()+proxyCalls.Load() != 1 {
				t.Fatalf("incorrect route: direct=%d proxy=%d", directCalls.Load(), proxyCalls.Load())
			}
		})
	}
}

func TestSystemProxyResolverIsUsedOutsideImplicitBypass(t *testing.T) {
	settings, err := parseNetworkSettings("system", "", "<-loopback>")
	if err != nil {
		t.Fatal(err)
	}
	proxy, _ := url.Parse("http://127.0.0.1:12345")
	var calls int
	settings.resolveSystem = func(request *http.Request) (*url.URL, error) { calls++; return proxy, nil }
	request, _ := http.NewRequestWithContext(context.Background(), http.MethodGet, "http://127.0.0.1:12346", nil)
	actual, err := settings.proxy(request)
	if err != nil || actual != proxy || calls != 1 {
		t.Fatal("system proxy mode was not delegated to the OS resolver")
	}
	settings.bypass = []string{"127.0.0.1"}
	actual, err = settings.proxy(request)
	if err != nil || actual != nil || calls != 1 {
		t.Fatal("explicit bypass still queried system proxy")
	}
}

func TestNextComputerModelRoundUsesUpdatedApplicationProxy(t *testing.T) {
	var directCalls, proxyCalls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		proxyCalls.Add(1)
		writeChatText(w, "Updated proxy was used")
	}))
	defer proxy.Close()
	s, _ := testServer(t)
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		directCalls.Add(1)
		s.mu.Lock()
		err := s.transaction(func(s *server) error {
			for key, value := range (object{"app.proxy.mode": "custom", "app.proxy.url": proxy.URL, "app.proxy.bypass_rules": "<-loopback>"}) {
				if err := s.store.setPreference(key, value); err != nil {
					return err
				}
			}
			return nil
		})
		s.mu.Unlock()
		if err != nil {
			t.Error(err)
			return
		}
		writeChatTool(w, "proxy-round-call", "mcp__computer__list_apps", "{}", true)
	}))
	defer target.Close()
	topic := seedChat(t, s, target.URL)
	enableChatComputer(t, s, &chatComputerHost{})
	g := launch(t, s, topic)
	waitDone(t, g)
	if directCalls.Load() != 1 || proxyCalls.Load() != 1 || g.answer != "Updated proxy was used" {
		t.Fatalf("later model round ignored saved proxy change: direct=%d proxy=%d answer=%q", directCalls.Load(), proxyCalls.Load(), g.answer)
	}
}

func TestProxyBypassMatchesExistingUISyntax(t *testing.T) {
	for _, scenario := range []struct {
		target, rules string
		bypass        bool
	}{
		{"https://api.example.com", "*.example.com", true},
		{"https://example.com", ".example.com", true},
		{"https://example.org", "*.example.com", false},
		{"https://example.com", "https://example.com:443", true},
		{"http://example.com", "https://example.com:443", false},
		{"http://192.168.1.9", "192.168.0.0/16", true},
		{"http://192.168.1.9", "192.168.*", true},
		{"http://[2001:db8::1]", "[2001:db8::]/32", true},
		{"http://[2001:db8::1]", "<local>", false},
		{"http://printer", "<local>", true},
		{"http://[::ffff:127.0.0.1]", "", true},
		{"http://localhost.", "localhost,<-loopback>", false},
		{"http://localhost.", "<-loopback>,localhost", true},
		{"http://foo.invalid", "*", true},
	} {
		t.Run(scenario.target+scenario.rules, func(t *testing.T) {
			target, _ := url.Parse(scenario.target)
			if actual := bypassProxy(target, strings.Split(scenario.rules, ",")); actual != scenario.bypass {
				t.Fatalf("bypass=%v want=%v", actual, scenario.bypass)
			}
		})
	}
	for _, address := range []string{"http://localhost:0", "http://localhost:65536", "file:///local", "socks4://localhost:1080", "http://localhost/path"} {
		if _, err := parseNetworkSettings("custom", address, ""); err == nil {
			t.Fatalf("invalid or unsupported proxy accepted: %s", address)
		}
	}
	if _, err := parseNetworkSettings("custom", "socks5://localhost:1080", ""); err != nil {
		t.Fatal(err)
	}
}

func TestNetworkTransportPoolReusesConnectionsAndSeparatesConfigurations(t *testing.T) {
	var connections atomic.Int32
	endpoint := httptest.NewUnstartedServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`)
	}))
	endpoint.Config.ConnState = func(_ net.Conn, state http.ConnState) {
		if state == http.StateNew {
			connections.Add(1)
		}
	}
	endpoint.Start()
	defer endpoint.Close()
	s, _ := testServer(t)
	seedChat(t, s, endpoint.URL)
	if err := s.store.setPreference("app.proxy.mode", "none"); err != nil {
		t.Fatal(err)
	}
	for index := 0; index < 2; index++ {
		if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local"}); err != nil {
			t.Fatal(err)
		}
	}
	if connections.Load() != 1 {
		t.Fatalf("same configuration did not reuse the connection: %d", connections.Load())
	}
	direct, _ := parseNetworkSettings("none", "", "")
	first, second := s.networkClient(direct), s.networkClient(direct)
	if first == second || first.Transport != second.Transport {
		t.Fatal("clients must be independent but share a configuration's transport")
	}
	first.Timeout = 1
	if second.Timeout != 0 {
		t.Fatal("one request changed another client's deadline")
	}
	proxy, _ := parseNetworkSettings("custom", "http://127.0.0.1:12345", "")
	if first.Transport == s.networkClient(proxy).Transport {
		t.Fatal("different proxy configurations shared a transport")
	}
	for index := 0; index < 12; index++ {
		value, _ := parseNetworkSettings("custom", fmt.Sprintf("http://127.0.0.1:%d", 20000+index), "")
		s.networkClient(value)
	}
	if len(s.networkTransports.entries) != 8 {
		t.Fatal("transport configuration cache is not bounded")
	}
	s.closeNetworkTransports()
	request, _ := http.NewRequest(http.MethodGet, endpoint.URL, nil)
	if _, err := s.networkClient(direct).Do(request); err == nil {
		t.Fatal("closed network pool reopened a transport")
	}
}

func TestProxyConnectionTestUsesEnteredConfigWithoutSavingIt(t *testing.T) {
	s, _ := testServer(t)
	before, _ := s.store.preference("app.proxy.mode")
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(http.StatusNoContent) }))
	defer endpoint.Close()
	var proxyCalls atomic.Int32
	proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { proxyCalls.Add(1); w.WriteHeader(http.StatusNoContent) }))
	defer proxy.Close()
	result := s.testProxyTarget(object{"mode": "custom", "url": proxy.URL, "bypassRules": "<-loopback>"}, endpoint.URL)
	if result["success"] != true || result["route"] != "proxy" || proxyCalls.Load() != 1 {
		t.Fatalf("bad temporary proxy result: %#v", result)
	}
	result = s.testProxyTarget(object{"mode": "custom", "url": proxy.URL, "bypassRules": "127.0.0.1"}, endpoint.URL)
	if result["success"] != true || result["route"] != "bypassed" || proxyCalls.Load() != 1 {
		t.Fatalf("bypass result: %#v", result)
	}
	result = s.testProxyTarget(object{"mode": "custom", "url": "", "bypassRules": ""}, endpoint.URL)
	if result["success"] != true || result["route"] != "fallback" {
		t.Fatalf("empty custom URL: %#v", result)
	}
	result = s.testProxyTarget(object{"mode": "custom", "url": "file:///local", "bypassRules": ""}, endpoint.URL)
	if result["success"] != false || result["error"] != "invalid_config" {
		t.Fatalf("invalid config: %#v", result)
	}
	after, _ := s.store.preference("app.proxy.mode")
	if before != after {
		t.Fatal("connection test changed the saved application proxy")
	}
	for _, status := range []int{407, 500} {
		failure := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { w.WriteHeader(status) }))
		result := s.testProxyTarget(object{"mode": "none", "url": "", "bypassRules": ""}, failure.URL)
		failure.Close()
		want := "http_error"
		if status == 407 {
			want = "authentication_required"
		}
		if result["success"] != false || result["error"] != want {
			t.Fatalf("HTTP classification: %#v", result)
		}
	}
}
