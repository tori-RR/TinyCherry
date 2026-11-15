package main

import (
	"database/sql"
	"errors"
	"testing"
)

func TestContextBoundaryCanBeCancelledWithoutDeletingHistory(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	user := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "text", "text": "retained history"}}}}))
	marker := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "parentId": user["id"], "data": object{"parts": []any{object{"type": "data-clear", "data": object{}}}}}))
	result := obj(dataOK(t, s, "DELETE", "/messages/"+text(marker["id"]), nil))
	if result["newActiveNodeId"] != user["id"] {
		t.Fatalf("boundary undo did not restore active parent: %v", result)
	}
	if _, err := s.store.get("messages", text(marker["id"])); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("marker survived cancellation", err)
	}
	if retained, err := s.store.get("messages", text(user["id"])); err != nil || partsText(obj(retained["data"])["parts"]) != "retained history" {
		t.Fatal("undo removed history", err)
	}
	current, _ := s.store.get("topics", text(topic["id"]))
	if current["activeNodeId"] != user["id"] {
		t.Fatal("persisted active node was not restored")
	}
}

func TestContextBoundaryWithDescendantsCannotSilentlyDropBranches(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	marker := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "data-clear", "data": object{}}}}}))
	child := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "text", "text": "child branch"}}}}))
	if result := dataResponse(t, s, "DELETE", "/messages/"+text(marker["id"]), nil); result["error"] == nil {
		t.Fatal("non-leaf boundary deletion was accepted")
	}
	for _, id := range []string{text(marker["id"]), text(child["id"])} {
		if _, err := s.store.get("messages", id); err != nil {
			t.Fatal("refused cancellation changed the branch", err)
		}
	}
}
