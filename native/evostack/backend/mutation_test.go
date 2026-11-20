package main

import (
	"bytes"
	"database/sql"
	"encoding/json"
	"errors"
	"slices"
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

func TestDeleteModelsCollection(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	const regular = "test::vendor/model"
	const batch = "test::vendor/model:batch"
	const other = "test::vendor/model%2Fliteral"
	for _, modelID := range []string{"vendor/model", "vendor/model:batch", "vendor/model%2Fliteral"} {
		dataOK(t, s, "POST", "/models", []any{object{"providerId": "test", "modelId": modelID}})
	}
	dataOK(t, s, "POST", "/pins", object{"entityType": "model", "entityId": batch, "orderKey": "a0"})
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	deleteModels := func(ids any) object {
		t.Helper()
		result, err, _ := s.invoke("data-api:request", []any{object{
			"id": "delete-models", "method": "DELETE", "path": "/models", "params": object{"ids": ids},
		}})
		if err != nil {
			t.Fatal(err)
		}
		return obj(result)
	}
	if response := deleteModels([]any{batch}); response["status"] != 200 || response["data"] != nil {
		t.Fatalf("drawer delete failed: %v", response)
	}
	assertModelEffects(t, output.Bytes(), batch)
	if _, err := s.store.get("models", batch); !errors.Is(err, sql.ErrNoRows) {
		t.Fatalf("batch variant still present: %v", err)
	}
	if pins, err := s.store.list("pins"); err != nil || len(pins) != 0 {
		t.Fatalf("batch variant pin survived: %v %v", pins, err)
	}

	output.Reset()
	if response := deleteModels([]any{regular, "test::missing"}); response["status"] != 404 {
		t.Fatalf("missing model did not reject the group delete: %v", response)
	}
	if output.Len() != 0 {
		t.Fatal("failed delete emitted updates", output.String())
	}
	if _, err := s.store.get("models", regular); err != nil {
		t.Fatalf("regular variant removed along with batch or on failed group delete: %v", err)
	}
	if response := deleteModels([]any{regular, other, other}); response["status"] != 200 {
		t.Fatalf("group delete failed: %v", response)
	}
	for _, id := range []string{regular, other} {
		if _, err := s.store.get("models", id); !errors.Is(err, sql.ErrNoRows) {
			t.Fatalf("%s survived group delete: %v", id, err)
		}
	}
	if response := deleteModels("test::local"); response["status"] != 200 {
		t.Fatalf("single string ID was rejected: %v", response)
	}
}

func TestProviderReorderPersistsThroughRestart(t *testing.T) {
	s, directory := testServer(t)
	const legacyID = "test:legacy-provider"
	if _, err := s.store.connection().Exec(
		"INSERT INTO entity(resource,id,body) VALUES('providers',?,json_object('id',?,'name','Legacy fixture'))", legacyID, legacyID,
	); err != nil {
		t.Fatal(err)
	}
	nous := nativeNousFixture(t, s)
	binding := nativeNousBinding(nous)
	putSyntheticSealedSecret(t, s, nativeNousSecretID(binding))
	getIDs := func() []string {
		rows := dataOK(t, s, "GET", "/providers", nil).([]object)
		ids := make([]string, 0, len(rows))
		for _, row := range rows {
			ids = append(ids, text(row["id"]))
		}
		return ids
	}
	original := getIDs()
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}

	dataOK(t, s, "PATCH", "/providers/"+nativeNousProviderID+"/order", object{"before": original[0]})
	wantSingle := append([]string{nativeNousProviderID}, slices.DeleteFunc(slices.Clone(original), func(id string) bool {
		return id == nativeNousProviderID
	})...)
	if ids := getIDs(); !slices.Equal(ids, wantSingle) {
		t.Fatalf("single reorder persisted %v, want %v", ids, wantSingle)
	}
	if endpoints := changedEndpoints(t, output.Bytes()); len(endpoints) != 1 || !endpoints["/providers"] {
		t.Fatalf("unexpected reorder invalidation: %v", endpoints)
	}

	dataOK(t, s, "PATCH", "/providers/order:batch", object{"moves": []any{
		object{"id": nativeHermesProviderID, "anchor": object{"position": "first"}},
		object{"id": legacyID, "anchor": object{"after": nativeHermesProviderID}},
	}})
	wantBatch := append([]string{nativeHermesProviderID, legacyID}, slices.DeleteFunc(slices.Clone(wantSingle), func(id string) bool {
		return id == nativeHermesProviderID || id == legacyID
	})...)
	if ids := getIDs(); !slices.Equal(ids, wantBatch) {
		t.Fatalf("batch reorder persisted %v, want %v", ids, wantBatch)
	}
	output.Reset()
	failed := dataResponse(t, s, "PATCH", "/providers/order:batch", object{"moves": []any{
		object{"id": nativeHermesProviderID, "anchor": object{"position": "last"}},
		object{"id": legacyID, "anchor": object{"after": "missing-provider"}},
	}})
	if failed["status"] != 400 || output.Len() != 0 || !slices.Equal(getIDs(), wantBatch) {
		t.Fatalf("invalid batch did not roll back: %v", failed)
	}

	if err := s.store.db.Close(); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	s.store = reopened
	if ids := getIDs(); !slices.Equal(ids, wantBatch) {
		t.Fatalf("restarted provider order: %v, want %v", ids, wantBatch)
	}
	var sealed []byte
	if err := reopened.connection().QueryRow("SELECT sealed FROM secret WHERE id=?", nativeNousSecretID(binding)).Scan(&sealed); err != nil ||
		string(sealed) != "synthetic-sealed-fixture" || nativeNousBinding(nativeNousFixture(t, s)) != binding {
		t.Fatal("reordering changed the Nous OAuth binding or credential", err)
	}
}
