package main

import (
	"encoding/json"
	"strings"
	"testing"
)

func TestLargeToolHistoryPaginatesWithinIPCWithoutLosingMessages(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	want := []string{}
	for i := 0; i < 6; i++ {
		user := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "text", "text": "Observe the test application"}}}}))
		parts := []any{}
		for j := 0; j < 8; j++ {
			parts = append(parts, object{"type": "dynamic-tool", "toolName": "mcp__computer__get_app_state", "toolCallId": newID(), "state": "output-available", "input": object{"appSessionId": "expired-session"}, "output": object{"tree": strings.Repeat("x", 112000)}})
		}
		assistant := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "assistant", "data": object{"parts": parts}}))
		want = append(want, text(user["id"]), text(assistant["id"]))
	}
	seen, pages := []string{}, 0
	query := object{"limit": float64(50)}
	for {
		response, err, _ := s.invoke("data-api:request", []any{object{"id": "history-page", "method": "GET", "path": "/topics/" + text(topic["id"]) + "/messages", "params": query}})
		if err != nil || obj(response)["error"] != nil {
			t.Fatal("could not read the tool history", response, err)
		}
		encoded, err := json.Marshal(object{"jsonrpc": "2.0", "id": 1, "result": response})
		if err != nil || len(encoded)+1 > maxFrame {
			t.Fatal("history response exceeded the wire limit", len(encoded), err)
		}
		page := obj(obj(response)["data"])
		items := page["items"].([]object)
		if len(items) == 0 {
			t.Fatal("byte pagination did not make progress")
		}
		ids := []string{}
		for _, item := range items {
			ids = append(ids, text(obj(item["message"])["id"]))
		}
		seen = append(ids, seen...)
		pages++
		if page["nextCursor"] == nil {
			break
		}
		query["cursor"] = page["nextCursor"]
		if pages > len(want) {
			t.Fatal("history cursor repeated")
		}
	}
	if pages < 2 || strings.Join(seen, ",") != strings.Join(want, ",") {
		t.Fatal("byte pagination lost, reordered or duplicated history", pages, seen, want)
	}
}
