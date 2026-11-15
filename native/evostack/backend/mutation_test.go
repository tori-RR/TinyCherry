package main

import (
	"bytes"
	"encoding/json"
	"testing"
)

func changedEndpoints(t *testing.T, output []byte) map[string]bool {
	t.Helper()
	result := map[string]bool{}
	for _, line := range bytes.Split(bytes.TrimSpace(output), []byte{'\n'}) {
		var frame object
		if err := json.Unmarshal(line, &frame); err != nil {
			t.Fatal(err)
		}
		params := obj(frame["params"])
		if params["channel"] != "data-api:data-changed" {
			continue
		}
		for _, value := range array(array(params["args"])[0]) {
			result[text(obj(value)["endpoint"])] = true
		}
	}
	return result
}

func TestTopicRenameDoesNotInvalidateUnrelatedDomains(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	dataOK(t, s, "PATCH", "/topics/"+text(topic["id"]), object{"name": "Renamed"})
	endpoints := changedEndpoints(t, output.Bytes())
	if !endpoints["/topics"] {
		t.Fatal("topic list did not refresh")
	}
	for _, unrelated := range []string{"/providers", "/models", "/skills", "/knowledge-bases", "/topics/:topicId/messages"} {
		if endpoints[unrelated] {
			t.Fatalf("topic rename caused unrelated requery: %s", unrelated)
		}
	}
}

func TestModelReconcilePublishesCascadeEffectsAfterCommit(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Model owner", "modelId": "test::local"}))
	message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "assistant", "status": "success", "modelId": "test::local", "data": object{"parts": []any{object{"type": "text", "text": "historical response"}}}}))
	dataOK(t, s, "POST", "/pins", object{"entityType": "model", "entityId": "test::local", "orderKey": "a0"})
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	dataOK(t, s, "POST", "/providers/test/models:reconcile", object{"toAdd": []any{}, "toRemove": []any{"test::local"}})
	endpoints := changedEndpoints(t, output.Bytes())
	for _, endpoint := range []string{"/models", "/models/:uniqueModelId*", "/assistants", "/topics/:topicId/messages", "/topics/:topicId/tree", "/pins"} {
		if !endpoints[endpoint] {
			t.Fatalf("reconcile omitted changed dependency: %s", endpoint)
		}
	}
	for _, reference := range []struct{ resource, id string }{{"assistants", text(assistant["id"])}, {"messages", text(message["id"])}} {
		row, err := s.store.get(reference.resource, reference.id)
		if err != nil || row["modelId"] != nil {
			t.Fatalf("cascade did not commit: %v %v", row, err)
		}
	}
	if pins, err := s.store.list("pins"); err != nil || len(pins) != 0 {
		t.Fatalf("model pin survived: %v %v", pins, err)
	}
}
