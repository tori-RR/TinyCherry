package main

import (
	"reflect"
	"strings"
	"testing"
)

func promptResponse(t *testing.T, s *server, method, path string, query object, body any) object {
	t.Helper()
	result, err, _ := s.invoke("data-api:request", []any{object{"id": "prompt-test", "method": method, "path": path, "params": query, "body": body}})
	if err != nil {
		t.Fatal(err)
	}
	return obj(result)
}

func promptOK(t *testing.T, s *server, method, path string, query object, body any) any {
	t.Helper()
	response := promptResponse(t, s, method, path, query, body)
	if response["error"] != nil {
		t.Fatalf("%s %s: %v", method, path, response["error"])
	}
	return response["data"]
}

func createPrompt(t *testing.T, s *server, title, visibility string) object {
	t.Helper()
	return obj(promptOK(t, s, "POST", "/prompts", nil, object{"title": title, "content": "保持用户内容\n" + title, "visibility": visibility}))
}

func promptIDs(t *testing.T, result any) []string {
	t.Helper()
	rows, ok := result.([]object)
	if !ok {
		t.Fatalf("prompt response must be an array, got %T", result)
	}
	ids := []string{}
	for _, row := range rows {
		ids = append(ids, text(row["id"]))
	}
	return ids
}

func TestPromptArrayCRUDAndReopen(t *testing.T) {
	s, directory := testServer(t)
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", nil, nil)); len(ids) != 0 {
		t.Fatalf("new profile has prompts: %v", ids)
	}
	prompt := createPrompt(t, s, "  自定义提示词  ", "global")
	if prompt["title"] != "自定义提示词" || len(prompt) != 7 {
		t.Fatalf("prompt DTO mismatch: %#v", prompt)
	}
	id := text(prompt["id"])
	updated := obj(promptOK(t, s, "PATCH", "/prompts/"+id, nil, object{"content": "新内容\n保留换行"}))
	if updated["content"] != "新内容\n保留换行" || updated["createdAt"] != prompt["createdAt"] {
		t.Fatal("prompt update changed the wrong fields")
	}
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", object{"search": "新内容"}, nil)); !reflect.DeepEqual(ids, []string{id}) {
		t.Fatal("content search did not find prompt")
	}
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", object{"search": "absent"}, nil)); len(ids) != 0 {
		t.Fatal("search ignored")
	}
	_ = s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	s.store = reopened
	saved := obj(promptOK(t, s, "GET", "/prompts/"+id, nil, nil))
	if !reflect.DeepEqual(saved, updated) {
		t.Fatal("prompt not persisted across restart")
	}
	promptOK(t, s, "DELETE", "/prompts/"+id, nil, nil)
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", nil, nil)); len(ids) != 0 {
		t.Fatal("prompt not deleted")
	}
}

func TestPromptBindingsVisibilitySnapshotAndDeletion(t *testing.T) {
	s, _ := testServer(t)
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Binding target"}))
	targetID := text(assistant["id"])
	target := object{"type": "assistant", "id": targetID}
	prompt := obj(promptOK(t, s, "POST", "/prompts", nil, object{"title": "受限", "content": "只有绑定助手可见", "visibility": "restricted", "bindingTarget": target}))
	id := text(prompt["id"])
	path := "/prompts/" + id + "/bindings/assistant/" + targetID
	promptOK(t, s, "PUT", path, nil, nil)
	relations := promptOK(t, s, "GET", "/prompt-bindings", nil, nil).([]object)
	if len(relations) != 1 || len(relations[0]) != 3 || relations[0]["promptId"] != id {
		t.Fatalf("binding must be idempotent and expose relation DTO only: %#v", relations)
	}
	global := createPrompt(t, s, "全局", "global")
	query := object{"targetType": "assistant", "targetId": targetID, "includeGlobal": true}
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", query, nil)); !reflect.DeepEqual(ids, []string{id, text(global["id"])}) {
		t.Fatalf("target query has wrong visibility/order: %v", ids)
	}
	for _, patch := range []object{{"visibility": "global"}, {"visibility": "global", "expectedBindings": []any{}}} {
		response := promptResponse(t, s, "PATCH", "/prompts/"+id, nil, patch)
		if obj(response["error"])["code"] != "CONCURRENT_MODIFICATION" || response["status"] != 409 {
			t.Fatalf("stale visibility changes need actionable conflict: %#v", response)
		}
		if current, _ := s.store.get("prompts", id); current["visibility"] != "restricted" {
			t.Fatal("conflict changed visibility")
		}
	}
	promptOK(t, s, "PATCH", "/prompts/"+id, nil, object{"visibility": "global", "expectedBindings": []any{target}})
	if relations := promptOK(t, s, "GET", "/prompt-bindings", nil, nil).([]object); len(relations) != 0 {
		t.Fatal("making prompt global left stale bindings")
	}
	promptOK(t, s, "PATCH", "/prompts/"+id, nil, object{"visibility": "restricted"})
	promptOK(t, s, "PUT", path, nil, nil)
	promptOK(t, s, "DELETE", "/prompts/"+id, nil, nil)
	if relations := promptOK(t, s, "GET", "/prompt-bindings", nil, nil).([]object); len(relations) != 0 {
		t.Fatal("deleting prompt left stale bindings")
	}
}

func TestPromptOrderingScopesAndAtomicFailure(t *testing.T) {
	s, _ := testServer(t)
	a := createPrompt(t, s, "A", "restricted")
	b := createPrompt(t, s, "B", "restricted")
	c := createPrompt(t, s, "C", "global")
	order := []string{text(a["id"]), text(b["id"]), text(c["id"])}
	failed := promptResponse(t, s, "PATCH", "/prompts/order:batch", nil, object{"moves": []any{
		object{"id": c["id"], "anchor": object{"position": "first"}},
		object{"id": a["id"], "anchor": object{"before": "missing"}},
	}})
	if failed["error"] == nil || !reflect.DeepEqual(promptIDs(t, promptOK(t, s, "GET", "/prompts", nil, nil)), order) {
		t.Fatal("failed reorder changed persisted order")
	}
	promptOK(t, s, "PATCH", "/prompts/"+text(c["id"])+"/order", nil, object{"before": a["id"]})
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", nil, nil)); !reflect.DeepEqual(ids, []string{text(c["id"]), text(a["id"]), text(b["id"])}) {
		t.Fatalf("single prompt move failed: %v", ids)
	}
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Ordered target"}))
	targetID := text(assistant["id"])
	for _, prompt := range []object{a, b} {
		promptOK(t, s, "PUT", "/prompts/"+text(prompt["id"])+"/bindings/assistant/"+targetID, nil, nil)
	}
	promptOK(t, s, "PATCH", "/prompt-bindings/assistant/"+targetID+"/"+text(b["id"])+"/order", nil, object{"position": "first"})
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompt-bindings/assistant/"+targetID, nil, nil)); !reflect.DeepEqual(ids, []string{text(b["id"]), text(a["id"])}) {
		t.Fatal("binding order did not change")
	}
	if ids := promptIDs(t, promptOK(t, s, "GET", "/prompts", nil, nil)); !reflect.DeepEqual(ids, []string{text(c["id"]), text(a["id"]), text(b["id"])}) {
		t.Fatal("target-specific reorder changed global order")
	}
}

func TestInvalidPromptCreationAndBindingsRollBack(t *testing.T) {
	s, _ := testServer(t)
	for _, input := range []object{
		{"title": " ", "content": "content", "visibility": "global"},
		{"title": "title", "content": "", "visibility": "global"},
		{"title": "title", "content": "content", "visibility": "unknown"},
		{"title": "title", "content": "content", "visibility": "global", "bindingTarget": object{"type": "assistant", "id": newID()}},
		{"title": "title", "content": "content", "visibility": "restricted", "bindingTarget": object{"type": "assistant", "id": newID()}},
		{"title": "title", "content": "content", "visibility": "global", "unexpected": true},
	} {
		response := promptResponse(t, s, "POST", "/prompts", nil, input)
		if response["error"] == nil {
			t.Fatalf("invalid input accepted: %#v", input)
		}
	}
	rows, err := s.store.list("prompts")
	if err != nil || len(rows) != 0 {
		t.Fatalf("failed prompt create leaked records: %v %#v", err, rows)
	}
	if _, err := validatePromptText(strings.Repeat("a", 100001), false); err == nil {
		t.Fatal("oversized content accepted")
	}
}
