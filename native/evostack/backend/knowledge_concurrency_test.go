package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

func TestKnowledgePreparationDoesNotBlockAbortOrCRUD(t *testing.T) {
	modelStarted, fetchStarted, releaseFetch := make(chan struct{}), make(chan struct{}), make(chan struct{})
	var release sync.Once
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path == "/slow" {
			close(fetchStarted)
			<-releaseFetch
			w.Header().Set("Content-Type", "text/plain")
			fmt.Fprint(w, "slow knowledge fixture")
			return
		}
		w.Header().Set("Content-Type", "text/event-stream")
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		close(modelStarted)
		<-r.Context().Done()
	}))
	defer endpoint.Close()
	defer release.Do(func() { close(releaseFetch) })
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	base := knowledgeBase(t, s, nil)
	g := launch(t, s, topic)
	<-modelStarted
	imported := make(chan object, 1)
	go func() {
		value, _, _ := s.invoke("ipc-api:request", []any{"knowledge.add_items", object{"baseId": base["id"], "items": []any{object{"type": "url", "data": object{"source": "slow", "url": endpoint.URL + "/slow"}}}}})
		imported <- obj(value)
	}()
	<-fetchStarted
	stopped := make(chan error, 1)
	go func() { stopped <- s.abort(text(topic["id"])) }()
	select {
	case err := <-stopped:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		release.Do(func() { close(releaseFetch) })
		<-stopped
		t.Fatal("slow knowledge HTTP blocked chat cancellation")
	}
	waitDone(t, g)
	listed := make(chan error, 1)
	go func() {
		_, err, _ := s.invoke("preference:get-all", nil)
		listed <- err
	}()
	select {
	case err := <-listed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("slow knowledge HTTP blocked settings")
	}
	release.Do(func() { close(releaseFetch) })
	if result := <-imported; result["ok"] != true {
		t.Fatalf("import: %v", result)
	}
}

func TestKnowledgePreparationRejectsConcurrentBaseChange(t *testing.T) {
	started, releaseFetch := make(chan struct{}), make(chan struct{})
	var release sync.Once
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		close(started)
		<-releaseFetch
		w.Header().Set("Content-Type", "text/plain")
		fmt.Fprint(w, "prepared material must not commit under changed settings")
	}))
	defer endpoint.Close()
	defer release.Do(func() { close(releaseFetch) })
	s, _ := testServer(t)
	base := knowledgeBase(t, s, nil)
	done := make(chan object, 1)
	go func() {
		value, _, _ := s.invoke("ipc-api:request", []any{"knowledge.add_items", object{"baseId": base["id"], "items": []any{object{"type": "url", "data": object{"source": "slow", "url": endpoint.URL}}}}})
		done <- obj(value)
	}()
	<-started
	changed := make(chan error, 1)
	go func() {
		_, err := s.dataForTest("PATCH", "/knowledge-bases/"+text(base["id"]), object{"name": "Changed while preparing"})
		changed <- err
	}()
	select {
	case err := <-changed:
		if err != nil {
			t.Fatal(err)
		}
	case <-time.After(time.Second):
		t.Fatal("knowledge preparation held the business lock")
	}
	release.Do(func() { close(releaseFetch) })
	result := <-done
	if result["ok"] != false || !strings.Contains(text(obj(result["error"])["message"]), "changed while preparing") {
		t.Fatalf("stale preparation committed: %v", result)
	}
	items, err := s.knowledgeItems(text(base["id"]))
	if err != nil || len(items) != 0 {
		t.Fatalf("partial import: %v %v", items, err)
	}
	var count int
	if err := s.store.db.QueryRow("SELECT count(*) FROM knowledge_fts").Scan(&count); err != nil || count != 0 {
		t.Fatalf("partial index: %d %v", count, err)
	}
}

// Exercise the public envelope rather than directly bypassing its transaction.
func (s *server) dataForTest(method, path string, body object) (object, error) {
	value, err, _ := s.invoke("data-api:request", []any{object{"id": newID(), "method": method, "path": path, "body": body}})
	if err != nil {
		return nil, err
	}
	response := obj(value)
	if response["error"] != nil {
		return nil, fmt.Errorf("%v", response["error"])
	}
	return obj(response["data"]), nil
}

func TestKnowledgeRetrievalQueryKeepsChatIndependent(t *testing.T) {
	for _, content := range []string{strings.Repeat("document ", 110), strings.Repeat("事实资料 ", 300), strings.Repeat("migration AI Go 数据 ", 100)} {
		query := knowledgeRetrievalQuery(content)
		if len(strings.Fields(query)) > 100 || len([]rune(query)) > 1000 {
			t.Fatalf("unbounded retrieval query: %q", query)
		}
	}
	if query := knowledgeRetrievalQuery("the and of"); query != "" {
		t.Fatalf("stop words: %q", query)
	}
}

func TestKnowledgeMixedShortTermsRemainSearchable(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, object{"name": "Mixed-language fixture"})
	target := knowledgeNote(t, s, base, "Go backend", "Go 编程与数据库配置")
	knowledgeNote(t, s, base, "Other", "migration with unrelated JavaScript tooling")
	for _, query := range []string{"Go", "Go migration", "GO migration"} {
		hits := knowledgeHits(t, s, base, query)
		found := false
		for _, hit := range hits {
			found = found || hit["itemId"] == target["id"]
		}
		if !found {
			t.Fatalf("short term disappeared from %q: %v", query, hits)
		}
	}
}

func TestKnowledgeLongMessagesReachProviderIntact(t *testing.T) {
	for _, count := range []int{101, 110, 300} {
		t.Run(fmt.Sprint(count), func(t *testing.T) {
			captured := make(chan object, 1)
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var payload object
				if err := json.NewDecoder(r.Body).Decode(&payload); err != nil {
					t.Error(err)
					return
				}
				captured <- payload
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"ok\"},\"finish_reason\":\"stop\"}]}\n\ndata: [DONE]\n\n")
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			base := knowledgeBase(t, s, nil)
			knowledgeNote(t, s, base, "Facts", "useful document context")
			words := make([]string, count)
			for i := range words {
				words[i] = fmt.Sprintf("document%d", i)
			}
			question := strings.Join(words, " ")
			value, err, after := s.invoke("ipc-api:request", []any{"ai.stream.open", object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": question}, object{"type": "data-knowledge-scope", "data": object{"baseIds": []any{base["id"]}}}}}})
			if err != nil || obj(value)["ok"] != true || after == nil {
				t.Fatalf("open: %v %v", value, err)
			}
			s.mu.Lock()
			g := s.active[text(topic["id"])]
			s.mu.Unlock()
			after()
			waitDone(t, g)
			select {
			case payload := <-captured:
				messages := array(payload["messages"])
				if obj(messages[len(messages)-1])["content"] != question {
					t.Fatal("retrieval truncated the provider's user question")
				}
			case <-time.After(time.Second):
				t.Fatal("long knowledge-assisted question did not reach the provider")
			}
		})
	}
}

func TestDeletingKnowledgeGroupClearsBaseReference(t *testing.T) {
	s, _ := testServer(t)
	group := obj(dataOK(t, s, "POST", "/groups", object{"name": "Knowledge group", "entityType": "knowledge"}))
	base := knowledgeBase(t, s, object{"groupId": group["id"]})
	dataOK(t, s, "DELETE", "/groups/"+text(group["id"]), nil)
	row, err := s.store.get("knowledge-bases", text(base["id"]))
	if err != nil || row["groupId"] != nil {
		t.Fatalf("knowledge base retained deleted group: %v %v", row, err)
	}
}

func TestDeletingKnowledgeBaseRemovesPinsAndNotifiesMountedList(t *testing.T) {
	s, _ := testServer(t)
	base := knowledgeBase(t, s, nil)
	pin := obj(dataOK(t, s, "POST", "/pins", object{"entityType": "knowledge", "entityId": base["id"], "orderKey": "a0"}))
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	knowledgeOK(t, s, "knowledge.delete_base", object{"baseId": base["id"]})
	if _, err := s.store.get("pins", text(pin["id"])); err == nil {
		t.Fatal("knowledge pin survived target deletion")
	}
	if !bytes.Contains(output.Bytes(), []byte(`"endpoint":"/pins"`)) {
		t.Fatal("mounted pin list was not invalidated")
	}
}
