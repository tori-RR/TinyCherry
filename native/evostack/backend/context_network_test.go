package main

import (
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func providerAuditCapture(t *testing.T) (*httptest.Server, <-chan object) {
	t.Helper()
	requests := make(chan object, 4)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var request object
		if err := json.NewDecoder(r.Body).Decode(&request); err != nil {
			t.Error(err)
			return
		}
		requests <- request
		writeChatText(w, "OK")
	}))
	t.Cleanup(endpoint.Close)
	return endpoint, requests
}

func providerAuditMessage(t *testing.T, s *server, topic object, role string, parts []any) object {
	t.Helper()
	var message object
	if err := s.transaction(func(s *server) error {
		var err error
		message, err = s.createMessage(topic, object{"role": role, "status": "success", "data": object{"parts": parts}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	return message
}

func providerAuditRun(t *testing.T, s *server, topic object, message string) *generation {
	t.Helper()
	return providerAuditExecute(t, s, object{"topicId": topic["id"], "trigger": "submit-message", "parentAnchorId": topic["activeNodeId"], "userMessageParts": []any{object{"type": "text", "text": message}}})
}

func providerAuditExecute(t *testing.T, s *server, input object) *generation {
	t.Helper()
	s.mu.Lock()
	_, err, after := s.openGeneration(input)
	g := s.active[text(input["topicId"])]
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	after()
	waitDone(t, g)
	row, err := s.store.get("messages", text(g.row["id"]))
	if err != nil || row["status"] != "success" {
		t.Fatalf("generation did not complete: %v %#v", err, row)
	}
	return g
}

func TestClearContextIsBranchScopedAndRegenerationUsesCurrentAnchor(t *testing.T) {
	endpoint, requests := providerAuditCapture(t)
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	old := providerAuditMessage(t, s, topic, "user", []any{object{"type": "text", "text": "PRIVATE_OLD_CONTEXT"}})
	providerAuditMessage(t, s, topic, "user", []any{object{"type": "data-clear", "data": object{}}})
	current := providerAuditMessage(t, s, topic, "user", []any{object{"type": "text", "text": "AFTER_CLEAR"}})
	providerAuditExecute(t, s, object{"topicId": topic["id"], "trigger": "regenerate-message", "parentAnchorId": current["id"]})
	messages := array((<-requests)["messages"])
	if len(messages) != 1 || obj(messages[0])["content"] != "AFTER_CLEAR" {
		t.Fatalf("regeneration crossed clear boundary: %#v", messages)
	}
	var branch object
	if err := s.transaction(func(s *server) error {
		var err error
		branch, err = s.createMessage(topic, object{"role": "user", "parentId": old["id"], "data": object{"parts": []any{object{"type": "text", "text": "BRANCH_WITHOUT_CLEAR"}}}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	providerAuditExecute(t, s, object{"topicId": topic["id"], "trigger": "regenerate-message", "parentAnchorId": branch["id"]})
	messages = array((<-requests)["messages"])
	encoded, _ := json.Marshal(messages)
	if len(messages) != 2 || !strings.Contains(string(encoded), "PRIVATE_OLD_CONTEXT") || strings.Contains(string(encoded), "AFTER_CLEAR") {
		t.Fatalf("marker from another branch cut or leaked into this branch: %s", encoded)
	}
}

func TestAuditClearContextBoundaryPreservesIsolation(t *testing.T) {
	endpoint, requests := providerAuditCapture(t)
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	old := providerAuditMessage(t, s, topic, "user", []any{object{"type": "text", "text": "PRIVATE_OLD_CONTEXT"}})
	providerAuditMessage(t, s, topic, "assistant", []any{object{"type": "text", "text": "OLD_REPLY"}})
	providerAuditMessage(t, s, topic, "user", []any{object{"type": "data-clear", "data": object{}}})
	providerAuditMessage(t, s, topic, "user", []any{object{"type": "text", "text": "AFTER_FIRST_MARKER"}})
	providerAuditMessage(t, s, topic, "user", []any{object{"type": "data-clear", "data": object{}}})
	providerAuditRun(t, s, topic, "NEW_CONTEXT_ONLY")
	request := <-requests
	encoded, _ := json.Marshal(request["messages"])
	if strings.Contains(string(encoded), "PRIVATE_OLD_CONTEXT") || strings.Contains(string(encoded), "AFTER_FIRST_MARKER") || len(array(request["messages"])) != 1 {
		t.Fatalf("context boundary violated: %s", encoded)
	}
	if retained, err := s.store.get("messages", text(old["id"])); err != nil || partsText(obj(retained["data"])["parts"]) != "PRIVATE_OLD_CONTEXT" {
		t.Fatal("clear changed the stored history")
	}
}

func TestAuditHistoryWindowRespected(t *testing.T) {
	for _, scenario := range []struct {
		name     string
		override object
		want     int
	}{
		{"global", nil, 1}, {"assistant", object{"maxMessages": 1}, 1}, {"absent-inherits", object{}, 1}, {"null-unlimited", object{"maxMessages": nil}, 3}, {"disabled-policy-still-windows", object{"enabled": false, "maxMessages": 1}, 1},
	} {
		t.Run(scenario.name, func(t *testing.T) {
			endpoint, requests := providerAuditCapture(t)
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			if err := s.store.setPreference("chat.context_settings.max_messages", 1); err != nil {
				t.Fatal(err)
			}
			if scenario.override != nil {
				assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "windowed", "settings": object{"contextSettings": scenario.override}}))
				topic["assistantId"] = assistant["id"]
				if err := s.store.put("topics", topic); err != nil {
					t.Fatal(err)
				}
			}
			providerAuditMessage(t, s, topic, "user", []any{object{"type": "text", "text": "OLD_REQUEST"}})
			providerAuditMessage(t, s, topic, "assistant", []any{object{"type": "text", "text": "OLD_RESPONSE"}})
			providerAuditRun(t, s, topic, "CURRENT_REQUEST")
			messages := array((<-requests)["messages"])
			if len(messages) != scenario.want || obj(messages[len(messages)-1])["content"] != "CURRENT_REQUEST" {
				t.Fatalf("wrong history window: %#v", messages)
			}
		})
	}
}

func TestContextWindowPreservesPromptPairsAndBranchBoundaries(t *testing.T) {
	s, _ := testServer(t)
	row := func(role, value string) object {
		return object{"role": role, "data": object{"parts": []any{object{"type": "text", "text": value}}}}
	}
	history := []object{row("user", "one"), row("assistant", "answer-one"), row("user", "two"), row("assistant", "answer-two"), row("user", "current")}
	for _, size := range []any{2, 2.7} {
		got, err := s.contextHistory(history, object{"contextSettings": object{"maxMessages": size}})
		if err != nil || len(got) != 3 || got[0]["role"] != "user" {
			t.Fatalf("orphaned prompt pair: %#v %v", got, err)
		}
	}
	for _, size := range []any{nil, 0, -1, "1", float64(math.MaxInt), math.MaxFloat64, math.NaN(), math.Inf(1)} {
		got, err := s.contextHistory(history, object{"contextSettings": object{"maxMessages": size}})
		if err != nil || len(got) != len(history) {
			t.Fatalf("invalid/unlimited window guessed a finite limit: %#v", got)
		}
	}
}

func TestAuditProviderExtraHeadersApplied(t *testing.T) {
	type capture struct{ path, gateway, authorization string }
	requests := make(chan capture, 8)
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests <- capture{r.URL.Path, r.Header.Get("X-Audit-Gateway"), r.Header.Get("Authorization")}
		if r.Method == http.MethodGet {
			fmt.Fprint(w, `{"data":[]}`)
			return
		}
		var body object
		_ = json.NewDecoder(r.Body).Decode(&body)
		if body["stream"] == true {
			writeChatText(w, "OK")
			return
		}
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`)
	}))
	defer endpoint.Close()
	s, directory := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	dataOK(t, s, "PATCH", "/providers/test", object{"providerSettings": object{"extraHeaders": object{"X-Audit-Gateway": "synthetic-required-header", "authorization": "Bearer synthetic-custom-auth"}}})
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	provider, _ := reopened.get("providers", "test")
	if obj(obj(provider["settings"])["extraHeaders"])["X-Audit-Gateway"] != "synthetic-required-header" {
		t.Fatal("custom headers were not persisted")
	}
	providerAuditRun(t, s, topic, "hello")
	for _, route := range []string{"ai.provider.model.list", "ai.provider.model.check"} {
		if _, err := s.modelOperation(route, object{"providerId": "test", "uniqueModelId": "test::local"}); err != nil {
			t.Fatal(err)
		}
	}
	for count := 0; count < 3; count++ {
		request := <-requests
		if request.gateway != "synthetic-required-header" || request.authorization != "Bearer synthetic-custom-auth" {
			t.Fatalf("request configuration was lost: %#v", request)
		}
	}
	dataOK(t, s, "PATCH", "/providers/test", object{"providerSettings": object{"extraHeaders": object{"X-Audit-Gateway": nil}}})
	if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local"}); err != nil {
		t.Fatal(err)
	}
	if request := <-requests; request.gateway != "" || request.authorization != "Bearer synthetic-custom-auth" {
		t.Fatal("partial header deletion lost an unrelated saved header")
	}
	current, err := s.store.get("providers", "test")
	if err != nil {
		t.Fatal(err)
	}
	for name, value := range obj(obj(current["settings"])["extraHeaders"]) {
		if name == "X-Audit-Gateway" || value == nil {
			t.Fatal("deleted header left a database tombstone")
		}
	}
	dataOK(t, s, "PATCH", "/providers/test", object{"providerSettings": object{"extraHeaders": object{"authorization": nil}}})
	if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local"}); err != nil {
		t.Fatal(err)
	}
	if request := <-requests; request.gateway != "" || request.authorization != "" {
		t.Fatal("deleted custom header was still sent")
	}
}

func TestAuditModelProbeRejectsInvalidSuccessBody(t *testing.T) {
	for _, body := range []string{`{"error":{"message":"synthetic gateway failure"}}`, "", "<html>login</html>", `{"choices":[]}`, `{"choices":[{"message":{"role":"assistant","content":123}}]}`} {
		t.Run(fmt.Sprint(len(body)), func(t *testing.T) {
			var calls atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls.Add(1); fmt.Fprint(w, body) }))
			defer endpoint.Close()
			s, _ := testServer(t)
			seedChat(t, s, endpoint.URL)
			if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local"}); err == nil {
				t.Fatal("probe accepted an invalid 200 body")
			}
			if calls.Load() != 1 {
				t.Fatal("probe was automatically retried")
			}
		})
	}
}

func TestProviderProbeHonorsDeadlineWithoutHoldingStateLock(t *testing.T) {
	started, finished := make(chan struct{}), make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_, _ = io.Copy(io.Discard, r.Body)
		close(started)
		<-r.Context().Done()
		close(finished)
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	seedChat(t, s, endpoint.URL)
	done := make(chan error, 1)
	go func() {
		_, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local", "timeout": 100})
		done <- err
	}()
	select {
	case <-started:
	case err := <-done:
		t.Fatalf("probe did not start: %v", err)
	case <-time.After(time.Second):
		t.Fatal("probe did not start")
	}
	s.mu.Lock()
	_, err := s.store.preferences()
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	select {
	case err := <-done:
		if err == nil {
			t.Fatal("probe ignored timeout")
		}
	case <-time.After(time.Second):
		t.Fatal("probe did not honor its deadline")
	}
	select {
	case <-finished:
	case <-time.After(time.Second):
		t.Fatal("probe did not cancel its HTTP request")
	}
}

func TestAuditNonVersionedPresetEndpoint(t *testing.T) {
	for _, scenario := range []struct {
		provider   object
		base, want string
	}{
		{object{"id": "perplexity"}, "https://api.perplexity.ai/", "https://api.perplexity.ai/chat/completions"},
		{object{"presetProviderId": "newapi"}, "https://gateway.invalid/", "https://gateway.invalid/chat/completions"},
		{object{}, "https://gateway.invalid/", "https://gateway.invalid/v1/chat/completions"},
		{object{}, "https://gateway.invalid/custom/v2/", "https://gateway.invalid/custom/v2/chat/completions"},
		{object{}, "https://gateway.invalid/custom#", "https://gateway.invalid/custom/chat/completions"},
		{object{}, "https://gateway.invalid/proxy%2Ftenant/v1", "https://gateway.invalid/proxy%2Ftenant/v1/chat/completions"},
	} {
		actual, err := providerEndpoint(scenario.provider, scenario.base, "chat/completions")
		if err != nil || actual != scenario.want {
			t.Fatalf("wrong endpoint: %s %v", actual, err)
		}
	}
	actual, err := endpoint("https://api.perplexity.ai/", "chat/completions")
	if err != nil || actual != "https://api.perplexity.ai/chat/completions" {
		t.Fatalf("legacy root URL contract: %s %v", actual, err)
	}
}
