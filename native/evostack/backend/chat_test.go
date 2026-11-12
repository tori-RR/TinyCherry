package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func testServer(t *testing.T) (*server, string) {
	t.Helper()
	directory := t.TempDir()
	db, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	s := newServer(db, &wireWriter{output: io.Discard}, ctx, cancel)
	t.Cleanup(func() {
		cancel()
		s.closeNetworkTransports()
		s.mu.Lock()
		running := []*generation{}
		for _, g := range s.active {
			g.cancel()
			running = append(running, g)
		}
		s.mu.Unlock()
		for _, g := range running {
			<-g.done
		}
		db.db.Close()
	})
	return s, directory
}
func seedChat(t *testing.T, s *server, base string) object {
	t.Helper()
	provider := object{"id": "test", "name": "Test", "defaultChatEndpoint": "openai-chat-completions", "endpointConfigs": object{"openai-chat-completions": object{"baseUrl": base}}, "isEnabled": true, "authOptional": true, "apiKeys": []any{}, "settings": object{}, "authType": "api-key", "reportsActualCost": false}
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	if err := s.store.put("models", newModel(object{"providerId": "test", "modelId": "local"})); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setPreference("chat.default_model_id", "test::local"); err != nil {
		t.Fatal(err)
	}
	var topic object
	err := s.transaction(func(s *server) error { var err error; topic, err = s.newTopic(object{}); return err })
	if err != nil {
		t.Fatal(err)
	}
	return topic
}
func launch(t *testing.T, s *server, topic object) *generation {
	t.Helper()
	s.mu.Lock()
	_, err, after := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "你好"}}})
	g := s.active[text(topic["id"])]
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	after()
	return g
}
func waitDone(t *testing.T, g *generation) {
	t.Helper()
	select {
	case <-g.done:
	case <-time.After(10 * time.Second):
		t.Fatal("generation did not finish")
	}
}

func TestChatStreamPersistsAndSurvivesReopen(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" {
			t.Errorf("path %s", r.URL.Path)
		}
		var request object
		_ = json.NewDecoder(r.Body).Decode(&request)
		if request["stream"] != true || request["model"] != "local" {
			t.Error("wrong provider request")
		}
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"原界面\"}}]}\n\ndata: {\"choices\":[{\"delta\":{\"content\":\"已接回\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	s, directory := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	g := launch(t, s, topic)
	waitDone(t, g)
	row, err := s.store.get("messages", text(g.row["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if row["status"] != "success" || partsText(obj(row["data"])["parts"]) != "原界面已接回" {
		t.Fatalf("wrong final message: %#v", row)
	}
	_ = s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	saved, err := reopened.get("messages", text(row["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if saved["searchableText"] != "原界面已接回" {
		t.Fatal("history lost")
	}
}
func TestAbortClosesHTTPAndPersistsPartial(t *testing.T) {
	first := make(chan struct{})
	closed := make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"保留半句\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(first)
		<-r.Context().Done()
		close(closed)
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	g := launch(t, s, topic)
	select {
	case <-first:
	case <-time.After(5 * time.Second):
		t.Fatal("local provider did not receive a request")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		s.mu.Lock()
		hasText := g.answer != ""
		s.mu.Unlock()
		if hasText {
			break
		}
		if time.Now().After(deadline) {
			t.Fatal("no text arrived")
		}
		time.Sleep(5 * time.Millisecond)
	}
	if err := s.abort(text(topic["id"])); err != nil {
		t.Fatal(err)
	}
	waitDone(t, g)
	select {
	case <-closed:
	case <-time.After(time.Second):
		t.Fatal("HTTP body not cancelled")
	}
	row, _ := s.store.get("messages", text(g.row["id"]))
	if row["status"] != "paused" || row["searchableText"] != "保留半句" {
		t.Fatalf("partial reply lost: %#v", row)
	}
}
func TestInterruptedSSEIsErrorAndNeverRetried(t *testing.T) {
	var calls atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	g := launch(t, s, seedChat(t, s, endpoint.URL))
	waitDone(t, g)
	row, _ := s.store.get("messages", text(g.row["id"]))
	if row["status"] != "error" || calls.Load() != 1 {
		t.Fatalf("status %v, calls %d", row["status"], calls.Load())
	}
}
func TestProviderRedirectDoesNotForwardCredentials(t *testing.T) {
	forwarded := false
	target := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { forwarded = true }))
	defer target.Close()
	redirect := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, target.URL, http.StatusTemporaryRedirect)
	}))
	defer redirect.Close()
	s, _ := testServer(t)
	g := launch(t, s, seedChat(t, s, redirect.URL))
	waitDone(t, g)
	if forwarded {
		t.Fatal("provider redirect followed")
	}
	row, _ := s.store.get("messages", text(g.row["id"]))
	if row["status"] != "error" {
		t.Fatal("redirect reported success")
	}
}
func TestUnsupportedToolsFailBeforeNetworkOrWrites(t *testing.T) {
	calls := 0
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { calls++ }))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	before, _ := s.store.list("messages")
	s.mu.Lock()
	_, err, _ := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "file", "url": "file://private"}}})
	s.mu.Unlock()
	after, _ := s.store.list("messages")
	if err == nil || calls != 0 || len(after) != len(before) {
		t.Fatal("unsupported attachment had side effects")
	}
}
func TestDatabaseRollbackAndSecretProtection(t *testing.T) {
	s, directory := testServer(t)
	err := s.transaction(func(s *server) error {
		if err := s.store.setPreference("app.language", "en-us"); err != nil {
			return err
		}
		return s.store.setPreference("unknown.key", true)
	})
	if err == nil {
		t.Fatal("bad preference accepted")
	}
	value, _ := s.store.preference("app.language")
	if value == "en-us" {
		t.Fatal("failed transaction partially committed")
	}
	secret := "evostack-synthetic-key-never-a-real-credential"
	if err := s.store.setSecret("test", secret); err != nil {
		t.Fatal(err)
	}
	plain, err := s.store.secret("test")
	if err != nil || plain != secret {
		t.Fatal("secret round trip failed")
	}
	for _, name := range []string{"evostack.sqlite3", "evostack.sqlite3-wal"} {
		contents, err := os.ReadFile(filepath.Join(directory, name))
		if err == nil && bytes.Contains(contents, []byte(secret)) {
			t.Fatal("plaintext credential found in SQLite")
		}
	}
}
func TestGenerationCrashReconciliation(t *testing.T) {
	s, directory := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1/v1")
	rows, err := s.topicRows(text(topic["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if err := s.store.put("messages", object{"id": "orphan", "topicId": topic["id"], "parentId": rootID(rows), "role": "assistant", "status": "pending", "data": object{"parts": []any{object{"type": "text", "text": "saved partial"}}}}); err != nil {
		t.Fatal(err)
	}
	_ = s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	row, err := reopened.get("messages", "orphan")
	if err != nil || row["status"] != "error" {
		t.Fatal("orphan still pending")
	}
	if partsText(obj(row["data"])["parts"]) != "saved partial" {
		t.Fatal("orphan content lost")
	}
}

func TestSSECompletionBoundary(t *testing.T) {
	content := "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n"
	stop := "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n"
	done := "data: [DONE]\n\n"
	for _, tc := range []struct {
		name      string
		body      string
		status    string
		answer    string
		reason    string
		truncated bool
	}{
		{name: "stop and done", body: content + stop + done, status: "success", answer: "partial"},
		{name: "stop without done", body: content + stop, status: "error", answer: "partial"},
		{name: "stop then transport interruption", body: content + stop, status: "error", answer: "partial", truncated: true},
		{name: "done without finish reason", body: content + done, status: "success", answer: "partial"},
		{name: "length reason and done", body: content + strings.ReplaceAll(stop, "stop", "length") + done, status: "success", answer: "partial", reason: "length"},
		{name: "json error after stop", body: content + stop + "data: {\"error\":{\"message\":\"synthetic upstream failure\"}}\n\n" + done, status: "error", answer: "partial"},
		{name: "SSE error after stop", body: content + stop + "event: error\ndata: {}\n\n" + done, status: "error", answer: "partial"},
		{name: "empty body", body: "", status: "error"},
		{name: "truncated done event", body: content + stop + "data: [DONE]", status: "error", answer: "partial"},
		{name: "CRLF multiline event", body: ": keepalive\r\nevent: message\r\ndata: {\"choices\":\r\ndata: [{\"delta\":{\"content\":\"partial\"},\"finish_reason\":\"stop\"}]}\r\n\r\ndata: [DONE]\r\n\r\n", status: "success", answer: "partial"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				if tc.truncated {
					w.Header().Set("Content-Length", fmt.Sprint(len(tc.body)+100))
				}
				fmt.Fprint(w, tc.body)
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			var output bytes.Buffer
			s.writer.output = &output
			g := launch(t, s, seedChat(t, s, endpoint.URL))
			waitDone(t, g)
			row, err := s.store.get("messages", text(g.row["id"]))
			if err != nil {
				t.Fatal(err)
			}
			if row["status"] != tc.status || row["searchableText"] != tc.answer {
				t.Fatalf("status %v, partial answer %q", row["status"], row["searchableText"])
			}
			if calls.Load() != 1 {
				t.Fatalf("provider request was retried: %d calls", calls.Load())
			}
			if tc.status == "error" && (!strings.Contains(output.String(), "ai.stream.error") || strings.Contains(output.String(), "ai.stream.done")) {
				t.Fatal("incomplete stream was announced as completed")
			}
			if tc.status == "success" && (!strings.Contains(output.String(), "ai.stream.done") || strings.Contains(output.String(), "ai.stream.error")) {
				t.Fatal("completed stream was not announced as successful")
			}
			if tc.reason != "" && !strings.Contains(output.String(), `"finishReason":"`+tc.reason+`"`) {
				t.Fatal("provider finish reason was lost")
			}
		})
	}
}

func TestConcurrentTopicsShareModelWithoutDuplicateSubmission(t *testing.T) {
	var calls atomic.Int32
	received := make(chan struct{}, 2)
	release := make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		number := calls.Add(1)
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"content\":\"reply:%d\"}}]}\n\n", number)
		w.(http.Flusher).Flush()
		received <- struct{}{}
		select {
		case <-release:
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	defer s.cancel()
	first := seedChat(t, s, endpoint.URL)
	var second object
	if err := s.transaction(func(s *server) error { var err error; second, err = s.newTopic(object{}); return err }); err != nil {
		t.Fatal(err)
	}
	g1 := launch(t, s, first)
	g2 := launch(t, s, second)
	s.mu.Lock()
	before, _ := s.store.list("messages")
	_, duplicateErr, after := s.openGeneration(object{"topicId": first["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "duplicate"}}})
	afterRows, _ := s.store.list("messages")
	s.mu.Unlock()
	if duplicateErr == nil || !strings.Contains(duplicateErr.Error(), "TOPIC_BUSY") || after != nil || len(before) != len(afterRows) {
		t.Fatal("duplicate topic submission was not rejected before persistence")
	}
	for range 2 {
		select {
		case <-received:
		case <-time.After(5 * time.Second):
			t.Fatal("independent topics did not run concurrently")
		}
	}
	close(release)
	waitDone(t, g1)
	waitDone(t, g2)
	if calls.Load() != 2 || g1.attempt == g2.attempt || g1.executionID != g2.executionID {
		t.Fatal("concurrent generation identity or request count was incorrect")
	}
	row1, _ := s.store.get("messages", text(g1.row["id"]))
	row2, _ := s.store.get("messages", text(g2.row["id"]))
	if row1["status"] != "success" || row2["status"] != "success" || row1["topicId"] != first["id"] || row2["topicId"] != second["id"] || row1["searchableText"] == row2["searchableText"] {
		t.Fatal("concurrent replies were lost or mixed between topics")
	}
}
func TestProviderURLValidation(t *testing.T) {
	for _, base := range []string{"file:///private", "https://user:pass@example.com", "https://example.com/#secret", "https://example.com?key=secret", "javascript:alert(1)"} {
		if _, err := endpoint(base, "models"); err == nil {
			t.Fatalf("accepted %s", base)
		}
	}
	result, err := endpoint("http://127.0.0.1:8123/v1", "chat/completions")
	if err != nil || !strings.HasSuffix(result, "/v1/chat/completions") {
		t.Fatal(result, err)
	}
}

func TestDisabledProviderCanBeProbedBeforeEnabling(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		fmt.Fprint(w, `{"choices":[{"message":{"role":"assistant","content":"OK"}}]}`)
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	provider, _ := s.store.get("providers", "test")
	provider["isEnabled"] = false
	if err := s.store.put("providers", provider); err != nil {
		t.Fatal(err)
	}
	if _, err := s.modelOperation("ai.provider.model.check", object{"uniqueModelId": "test::local"}); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	_, err, _ := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "must remain disabled"}}})
	s.mu.Unlock()
	if err == nil {
		t.Fatal("disabled provider accepted a chat")
	}
}

func TestProfileLockIsExclusiveAndReleased(t *testing.T) {
	directory := t.TempDir()
	unlock, err := lockProfile(directory)
	if err != nil {
		t.Fatal(err)
	}
	if second, err := lockProfile(directory); err == nil {
		second()
		unlock()
		t.Fatal("same profile acquired twice")
	}
	unlock()
	again, err := lockProfile(directory)
	if err != nil {
		t.Fatal(err)
	}
	again()
}

func TestCrossTopicParentRollsBack(t *testing.T) {
	s, _ := testServer(t)
	first := seedChat(t, s, "http://127.0.0.1:1/v1")
	var second object
	if err := s.transaction(func(s *server) error { var err error; second, err = s.newTopic(object{}); return err }); err != nil {
		t.Fatal(err)
	}
	otherRows, _ := s.topicRows(text(second["id"]))
	before, _ := s.store.list("messages")
	s.mu.Lock()
	_, err, _ := s.openGeneration(object{"topicId": first["id"], "trigger": "submit-message", "parentAnchorId": rootID(otherRows), "userMessageParts": []any{object{"type": "text", "text": "must not cross topics"}}})
	s.mu.Unlock()
	after, _ := s.store.list("messages")
	if err == nil || len(before) != len(after) {
		t.Fatal("cross-topic write accepted")
	}
}

func TestOversizedReplyReturnsCorrelatedError(t *testing.T) {
	var output bytes.Buffer
	w := &wireWriter{output: &output}
	if err := w.send(object{"jsonrpc": "2.0", "id": 123, "result": strings.Repeat("x", maxFrame)}); err != nil {
		t.Fatal(err)
	}
	var reply object
	if err := json.Unmarshal(output.Bytes(), &reply); err != nil {
		t.Fatal(err)
	}
	if reply["id"] != float64(123) || obj(reply["error"])["code"] != float64(-32000) {
		t.Fatal("oversized response was not a correlated error")
	}
}

func TestPersistenceFailureNeverEmitsDone(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	var output bytes.Buffer
	s.writer.output = &output
	s.mu.Lock()
	_, err, after := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "test persistence"}}})
	g := s.active[text(topic["id"])]
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	_ = s.store.db.Close()
	after()
	waitDone(t, g)
	if !strings.Contains(output.String(), "ai.stream.error") || strings.Contains(output.String(), "ai.stream.done") {
		t.Fatal("failed persistence was reported as success")
	}
}
