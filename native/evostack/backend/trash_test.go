package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"net/url"
	"reflect"
	"sort"
	"testing"
)

func trashResult(t *testing.T, s *server, route string, input object) object {
	t.Helper()
	result, err, _ := s.invoke("ipc-api:request", []any{route, input})
	if err != nil {
		t.Fatal(err)
	}
	return obj(result)
}

func trashOK(t *testing.T, s *server, route string, input object) object {
	t.Helper()
	result := trashResult(t, s, route, input)
	if result["ok"] != true {
		t.Fatalf("%s: %v", route, result)
	}
	return obj(result["data"])
}

func TestTrashOriginalRoutesArchiveRestoreAndPermanentlyDelete(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Restore me"}))
	dataOK(t, s, "PATCH", "/topics/"+text(topic["id"]), object{"assistantId": assistant["id"]})
	message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "text", "text": "retained through undo"}}}}))
	pin := obj(dataOK(t, s, "POST", "/pins", object{"entityType": "topic", "entityId": topic["id"], "orderKey": "a0"}))
	result := trashOK(t, s, "trash.assistant.archive", object{"assistantId": assistant["id"], "deleteTopics": true})
	if result["deleted"] != true || !reflect.DeepEqual(result["deletedTopicIds"], []string{text(topic["id"])}) {
		t.Fatal(result)
	}
	for resource, id := range map[string]string{"assistants": text(assistant["id"]), "topics": text(topic["id"])} {
		row, err := s.store.get(resource, id)
		if err != nil || row["deletedAt"] == nil {
			t.Fatal("archive did not retain trashed row", resource, err)
		}
	}
	if _, err := s.store.get("messages", text(message["id"])); err != nil {
		t.Fatal("archive destroyed history", err)
	}
	if _, err := s.store.get("pins", text(pin["id"])); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("archive retained pin", err)
	}
	dataOK(t, s, "POST", "/assistants/"+text(assistant["id"])+"/restore", nil)
	dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/restore", nil)
	if row, _ := s.store.get("topics", text(topic["id"])); row["deletedAt"] != nil || row["assistantId"] != assistant["id"] {
		t.Fatal("undo did not restore owner and active topic", row)
	}
	if r := dataResponse(t, s, "DELETE", "/topics/"+text(topic["id"]), nil); r["error"] == nil {
		t.Fatal("unqualified Data DELETE removed active topic")
	}
	result = trashOK(t, s, "trash.topic.delete_permanently", object{"topicIds": []any{topic["id"]}})
	if result["deletedCount"] != 1 {
		t.Fatal(result)
	}
	if _, err := s.store.get("messages", text(message["id"])); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("permanent delete retained history", err)
	}
	trashOK(t, s, "trash.assistant.archive", object{"assistantId": assistant["id"], "deleteTopics": false})
	response, err, _ := s.invoke("data-api:request", []any{object{"id": "purge", "method": "DELETE", "path": "/assistants/" + text(assistant["id"]), "params": object{"permanent": true}}})
	if err != nil || obj(response)["error"] != nil || obj(obj(response)["data"])["deleted"] != true {
		t.Fatal(response, err)
	}
}

func TestTrashBatchIsAtomicBusyAwareAndPreservesUnrelatedRows(t *testing.T) {
	s, _ := testServer(t)
	first := seedChat(t, s, "http://127.0.0.1:1")
	second := obj(dataOK(t, s, "POST", "/topics", object{}))
	s.active[text(second["id"])] = &generation{}
	result := trashResult(t, s, "trash.topic.archive", object{"topicIds": []any{first["id"], second["id"], first["id"]}})
	delete(s.active, text(second["id"]))
	if obj(result["error"])["code"] != "TRASH_TOPIC_BUSY" {
		t.Fatal(result)
	}
	if row, _ := s.store.get("topics", text(first["id"])); row["deletedAt"] != nil {
		t.Fatal("batch archived before validating busy topic")
	}
	ordered := []string{text(first["id"]), text(second["id"])}
	sort.Strings(ordered)
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_archive BEFORE UPDATE ON entity WHEN NEW.resource='topics' AND NEW.id='` + ordered[1] + `' BEGIN SELECT RAISE(ABORT,'fail archive'); END`); err != nil {
		t.Fatal(err)
	}
	result = trashResult(t, s, "trash.topic.archive", object{"topicIds": []any{first["id"], second["id"]}})
	if result["ok"] != false {
		t.Fatal("injected failure ignored")
	}
	if row, _ := s.store.get("topics", text(first["id"])); row["deletedAt"] != nil {
		t.Fatal("failed batch did not roll back")
	}
	if _, err := s.store.db.Exec("DROP TRIGGER fail_archive"); err != nil {
		t.Fatal(err)
	}
	result = trashOK(t, s, "trash.topic.archive", object{"topicIds": []any{first["id"], first["id"]}})
	if result["deletedCount"] != 1 {
		t.Fatal("duplicate ID archived twice", result)
	}
	if row, _ := s.store.get("topics", text(second["id"])); row["deletedAt"] != nil {
		t.Fatal("unrelated topic archived")
	}
	result = trashOK(t, s, "trash.purge_now", object{})
	if result["status"] != "completed" || result["deletedCount"] != 1 {
		t.Fatal(result)
	}
}

func TestTrashAssistantKeepTopicsAndBulkArchive(t *testing.T) {
	s, _ := testServer(t)
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Keep history"}))
	one := obj(dataOK(t, s, "POST", "/topics", object{"assistantId": assistant["id"]}))
	two := obj(dataOK(t, s, "POST", "/topics", object{"assistantId": assistant["id"]}))
	trashOK(t, s, "trash.assistant.archive", object{"assistantId": assistant["id"], "deleteTopics": false})
	if row, _ := s.store.get("topics", text(one["id"])); row["deletedAt"] != nil || row["assistantId"] != assistant["id"] {
		t.Fatal(row)
	}
	dataOK(t, s, "POST", "/assistants/"+text(assistant["id"])+"/restore", nil)
	r := trashOK(t, s, "trash.assistant_topics.archive", object{"assistantId": assistant["id"]})
	if r["deletedCount"] != 2 {
		t.Fatal(r)
	}
	trashOK(t, s, "trash.assistant.delete_permanently", object{"assistantId": assistant["id"], "deleteTopics": false})
	for _, id := range []string{text(one["id"]), text(two["id"])} {
		if row, _ := s.store.get("topics", id); row["deletedAt"] == nil || row["assistantId"] != nil {
			t.Fatal("permanent assistant delete changed topic trash state", row)
		}
	}
}

func TestGroupDeletionAndTargetPinsKeepRelationsConsistent(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	group := obj(dataOK(t, s, "POST", "/groups", object{"name": "A", "entityType": "assistant", "orderKey": "a0"}))
	other := obj(dataOK(t, s, "POST", "/groups", object{"name": "B", "entityType": "assistant", "orderKey": "a1"}))
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Grouped", "groupId": group["id"]}))
	keep := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Unrelated", "groupId": other["id"]}))
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_group_delete BEFORE DELETE ON entity WHEN OLD.resource='groups' BEGIN SELECT RAISE(ABORT,'fail group deletion'); END`); err != nil {
		t.Fatal(err)
	}
	if response := dataResponse(t, s, "DELETE", "/groups/"+text(group["id"]), nil); response["error"] == nil {
		t.Fatal("injected group failure ignored")
	}
	if row, _ := s.store.get("assistants", text(assistant["id"])); row["groupId"] != group["id"] {
		t.Fatal("group unlink escaped failed transaction")
	}
	if _, err := s.store.db.Exec("DROP TRIGGER fail_group_delete"); err != nil {
		t.Fatal(err)
	}
	dataOK(t, s, "DELETE", "/groups/"+text(group["id"]), nil)
	if row, _ := s.store.get("assistants", text(assistant["id"])); row["groupId"] != nil {
		t.Fatal("deleted group left dangling assistant", row)
	}
	if row, _ := s.store.get("assistants", text(keep["id"])); row["groupId"] != other["id"] {
		t.Fatal("unrelated group changed")
	}
	for _, input := range []object{{"entityType": "topic", "entityId": "missing", "orderKey": "a0"}, {"entityType": "assistant", "entityId": topic["id"], "orderKey": "a0"}} {
		if r := dataResponse(t, s, "POST", "/pins", input); r["error"] == nil {
			t.Fatal("invalid pin persisted", input)
		}
	}
	pin := obj(dataOK(t, s, "POST", "/pins", object{"entityType": "model", "entityId": "test::local", "orderKey": "a0"}))
	dataOK(t, s, "DELETE", "/models/test::local", nil)
	if _, err := s.store.get("pins", text(pin["id"])); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("model pin survived target delete", err)
	}
}

func TestGreedyModelIDsAndExactPostCommitInvalidation(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	for _, apiID := range []string{"vendor/model", "模型/百分%2F", "trailing/", "100%literal"} {
		model := dataOK(t, s, "POST", "/models", []any{object{"providerId": "test", "modelId": apiID}}).([]object)[0]
		id := text(model["id"])
		path := "/models/" + url.PathEscape(id)
		if got := obj(dataOK(t, s, "GET", path, nil)); got["id"] != id {
			t.Fatal("encoded ID did not decode exactly once", got)
		}
		if got := obj(dataOK(t, s, "GET", "/models/"+id, nil)); got["id"] != id {
			t.Fatal("raw greedy ID lost tail or decoded a percent literal", got)
		}
		output.Reset()
		dataOK(t, s, "PATCH", path, object{"name": "After"})
		assertModelEffects(t, output.Bytes(), id)
		output.Reset()
		dataOK(t, s, "DELETE", path, nil)
		assertModelEffects(t, output.Bytes(), id)
	}
	// The collection batch endpoint must remain a collection operation.
	result := dataOK(t, s, "PATCH", "/models", []any{object{"uniqueModelId": "test::local", "patch": object{"name": "Batch"}}})
	if result.([]object)[0]["name"] != "Batch" {
		t.Fatal(result)
	}
	output.Reset()
	if r := dataResponse(t, s, "PATCH", "/models/test::local", object{"id": "immutable"}); r["error"] == nil {
		t.Fatal("invalid mutation accepted")
	}
	if output.Len() != 0 {
		t.Fatal("failed mutation emitted change effects", output.String())
	}
}

func assertModelEffects(t *testing.T, wire []byte, id string) {
	t.Helper()
	found := map[string]bool{}
	for _, line := range bytes.Split(bytes.TrimSpace(wire), []byte{'\n'}) {
		var frame object
		if err := json.Unmarshal(line, &frame); err != nil {
			t.Fatal(err)
		}
		params := obj(frame["params"])
		if params["channel"] != "data-api:data-changed" {
			continue
		}
		for _, raw := range array(array(params["args"])[0]) {
			effect := obj(raw)
			endpoint := text(effect["endpoint"])
			if endpoint == "/models" || endpoint == "/models/:uniqueModelId*" {
				if !reflect.DeepEqual(effect["entityIds"], []any{id}) {
					t.Fatal("broad or wrong scalar invalidation", effect)
				}
				found[endpoint] = true
			}
		}
	}
	if len(found) != 2 {
		t.Fatal("collection/scalar effect missing", found, string(wire))
	}
}
