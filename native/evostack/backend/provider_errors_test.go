package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestProviderDiagnosticsSurviveStorageProjectionAndReopen(t *testing.T) {
	const done = "data: [DONE]\n\n"
	const sentinel = "synthetic-private-provider-diagnostic"
	for _, tc := range []struct {
		name, body, category string
		httpStatus           int
	}{
		{name: "only completion marker", body: done, category: "parse"},
		{name: "empty choices", body: "data: {\"choices\":[]}\n\n" + done, category: "parse"},
		{name: "empty completed choice", body: "data: {\"choices\":[{\"delta\":{},\"finish_reason\":\"stop\"}]}\n\n" + done, category: "parse"},
		{name: "whitespace output", body: "data: {\"choices\":[{\"delta\":{\"content\":\"  \\n\"}}]}\n\n" + done, category: "parse"},
		{name: "malformed JSON", body: "data: {" + sentinel + "}\n\n" + done, category: "parse"},
		{name: "truncated transport", body: "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n", category: "parse"},
		{name: "HTTP context rejection", httpStatus: 400, body: "{\"error\":{\"message\":\"Input exceeds the context limit " + sentinel + "\"}}", category: "context_length"},
		{name: "HTTP bare context capacity", httpStatus: 400, body: "{\"error\":{\"message\":\"This model's maximum context length is 1048576 tokens " + sentinel + "\"}}", category: "context_length"},
		{name: "SSE formatted context capacity", body: "data: {\"error\":{\"message\":\"This model's maximum context length is 1,048,576 tokens " + sentinel + "\"}}\n\n" + done, category: "context_length"},
		{name: "stream context rejection", body: "data: {\"error\":{\"code\":\"context_length_exceeded\",\"message\":\"" + sentinel + "\"}}\n\n" + done, category: "context_length"},
		{name: "SSE event context rejection", body: "event: error\ndata: {\"message\":\"prompt is too long " + sentinel + "\"}\n\n", category: "context_length"},
		{name: "server status retains precedence", httpStatus: 503, body: "{\"error\":{\"message\":\"Input exceeds the context limit " + sentinel + "\"}}"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				calls.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				if tc.httpStatus != 0 {
					w.WriteHeader(tc.httpStatus)
				}
				fmt.Fprint(w, tc.body)
			}))
			defer endpoint.Close()
			s, directory := testServer(t)
			var output bytes.Buffer
			s.writer.output = &output
			g := launch(t, s, seedChat(t, s, endpoint.URL))
			waitDone(t, g)
			row, err := s.store.get("messages", text(g.row["id"]))
			if err != nil || row["status"] != "error" || calls.Load() != 1 {
				t.Fatalf("expected one failed, unreplayed request: status=%v calls=%d error=%v", row["status"], calls.Load(), err)
			}
			assertDiagnostic := func(parts []any) {
				t.Helper()
				count := 0
				for _, entry := range parts {
					part := obj(entry)
					if part["type"] != "data-error" {
						continue
					}
					count++
					issue := obj(part["data"])
					if text(issue["providerErrorCategory"]) != tc.category || text(issue["message"]) == "" {
						t.Fatalf("wrong safe diagnostic: %#v", issue)
					}
					if tc.httpStatus != 0 && replaySequence(issue["statusCode"]) != int64(tc.httpStatus) {
						t.Fatalf("HTTP status lost: %#v", issue)
					}
				}
				if count != 1 {
					t.Fatalf("expected one durable error card, got %d", count)
				}
			}
			assertDiagnostic(array(obj(row["data"])["parts"]))
			s.mu.Lock()
			projection := s.topicProjection(g.topicID)
			s.flushProjection(projection)
			view := clone(projection.view)
			s.mu.Unlock()
			messages := array(view["messages"])
			if len(messages) != 1 {
				t.Fatal("terminal projection omitted the failed message")
			}
			assertDiagnostic(array(obj(messages[0])["parts"]))
			wire := output.String()
			serialized, _ := json.Marshal(row)
			if strings.Contains(wire, sentinel) || strings.Contains(string(serialized), sentinel) || !strings.Contains(wire, "ai.stream.error") || strings.Contains(wire, "ai.stream.done") {
				t.Fatal("unsafe provider payload escaped, or failure was announced as success")
			}
			s.store.db.Close()
			reopened, err := openStore(directory)
			if err != nil {
				t.Fatal(err)
			}
			defer reopened.db.Close()
			saved, err := reopened.get("messages", text(row["id"]))
			if err != nil {
				t.Fatal(err)
			}
			assertDiagnostic(array(obj(saved["data"])["parts"]))
		})
	}
}

func TestReasoningOnlyResponseRemainsValid(t *testing.T) {
	for _, finish := range []string{"stop", "length"} {
		t.Run(finish, func(t *testing.T) {
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprintf(w, "data: {\"choices\":[{\"delta\":{\"reasoning_content\":\"retained reasoning\"},\"finish_reason\":%q}]}\n\ndata: [DONE]\n\n", finish)
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			g := launch(t, s, seedChat(t, s, endpoint.URL))
			waitDone(t, g)
			row, err := s.store.get("messages", text(g.row["id"]))
			if err != nil || row["status"] != "success" || g.reasoning != "retained reasoning" {
				t.Fatalf("reasoning-only completion was lost: status=%v, error=%v", row["status"], err)
			}
		})
	}
}
