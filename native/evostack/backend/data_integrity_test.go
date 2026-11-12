package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"reflect"
	"strings"
	"testing"
)

func dataResponse(t *testing.T, s *server, method, path string, body any) object {
	t.Helper()
	result, err, _ := s.invoke("data-api:request", []any{object{"id": "integrity-test", "method": method, "path": path, "body": body}})
	if err != nil {
		t.Fatal(err)
	}
	return obj(result)
}

func dataOK(t *testing.T, s *server, method, path string, body any) any {
	t.Helper()
	response := dataResponse(t, s, method, path, body)
	if response["error"] != nil {
		t.Fatalf("%s %s failed: %v", method, path, response["error"])
	}
	return response["data"]
}

func addKey(t *testing.T, s *server, provider, id, plain string) {
	t.Helper()
	dataOK(t, s, "POST", "/providers/"+url.PathEscape(provider)+"/api-keys", object{"id": id, "key": plain})
}

func TestKeyReplacementRemovesOnlySupersededProviderSecrets(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	dataOK(t, s, "POST", "/providers", object{"providerId": "other", "name": "Other"})
	addKey(t, s, "test", "shared-id", "synthetic-old")
	addKey(t, s, "other", "shared-id", "synthetic-other")
	dataOK(t, s, "PUT", "/providers/test/api-keys", object{"keys": []any{object{"id": "new-id", "key": "synthetic-new"}}})
	if _, err := s.store.secret("test:shared-id"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("superseded key remains readable", err)
	}
	for id, expected := range map[string]string{"test:new-id": "synthetic-new", "other:shared-id": "synthetic-other"} {
		if plain, err := s.store.secret(id); err != nil || plain != expected {
			t.Fatalf("wrong retained key %s: %v", id, err)
		}
	}
	provider := obj(dataOK(t, s, "GET", "/providers/test", nil))
	if keys := array(provider["apiKeys"]); len(keys) != 1 || obj(keys[0])["id"] != "new-id" || obj(keys[0])["key"] != nil {
		t.Fatal("provider metadata is not synchronized or exposes plaintext")
	}
	dataOK(t, s, "PUT", "/providers/test/api-keys", object{"keys": []any{object{"id": "new-id", "key": "synthetic-reused-id"}}})
	if plain, err := s.store.secret("test:new-id"); err != nil || plain != "synthetic-reused-id" {
		t.Fatal("PUT with a retained key ID discarded its new secret", err)
	}
	if plain, err := s.store.secret("other:shared-id"); err != nil || plain != "synthetic-other" {
		t.Fatal("PUT with a retained key ID altered another provider", err)
	}
	dataOK(t, s, "DELETE", "/providers/test/api-keys/new-id", nil)
	if _, err := s.store.secret("test:new-id"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("deleted key remains readable", err)
	}
}

func TestCredentialMutationFailureRollsBackSecretsAndMetadata(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	addKey(t, s, "test", "old", "synthetic-old")
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_provider_update BEFORE UPDATE ON entity WHEN NEW.resource='providers' BEGIN SELECT RAISE(ABORT,'injected metadata failure'); END`); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []struct {
		method, path string
		body         any
	}{
		{"PUT", "/providers/test/api-keys", object{"keys": []any{object{"id": "new", "key": "synthetic-new"}}}},
		{"PATCH", "/providers/test/api-keys/old", object{"key": "synthetic-replacement"}},
		{"DELETE", "/providers/test/api-keys/old", nil},
	} {
		if response := dataResponse(t, s, mutation.method, mutation.path, mutation.body); response["error"] == nil {
			t.Fatal("injected metadata failure was ignored")
		}
		if plain, err := s.store.secret("test:old"); err != nil || plain != "synthetic-old" {
			t.Fatal("failed mutation changed original secret", err)
		}
		if _, err := s.store.secret("test:new"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("failed replacement left a new secret", err)
		}
	}
	provider, _ := s.store.get("providers", "test")
	if len(array(provider["apiKeys"])) != 1 || obj(array(provider["apiKeys"])[0])["id"] != "old" {
		t.Fatal("failed mutation changed metadata")
	}
}

func TestInvalidKeyBatchAndIdentityAreAtomic(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	addKey(t, s, "test", "old", "synthetic-old")
	for _, keys := range [][]any{
		{object{"id": "new", "key": "synthetic-new"}, object{"id": "bad", "key": " "}},
		{object{"id": "new", "key": "synthetic-new"}, object{"id": "new", "key": "duplicate"}},
		{object{"id": "other:key", "key": "collision"}},
	} {
		if response := dataResponse(t, s, "PUT", "/providers/test/api-keys", object{"keys": keys}); response["error"] == nil {
			t.Fatal("invalid key batch accepted")
		}
		if _, err := s.store.secret("test:new"); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("invalid batch partly persisted")
		}
		if plain, err := s.store.secret("test:old"); err != nil || plain != "synthetic-old" {
			t.Fatal("invalid batch removed original secret")
		}
	}
}

func TestTopicDeletionCascadesMessagesAndRollsBackOnFailure(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	other := obj(dataOK(t, s, "POST", "/topics", object{}))
	message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "text", "text": "keep until commit"}}}}))
	if _, err := s.store.db.Exec(`CREATE TRIGGER fail_topic_delete BEFORE DELETE ON entity WHEN OLD.resource='topics' BEGIN SELECT RAISE(ABORT,'injected delete failure'); END`); err != nil {
		t.Fatal(err)
	}
	if response := trashResult(t, s, "trash.topic.delete_permanently", object{"topicIds": []any{topic["id"]}}); response["ok"] == true {
		t.Fatal("injected failure was ignored")
	}
	if _, err := s.store.get("messages", text(message["id"])); err != nil {
		t.Fatal("failed topic deletion lost messages", err)
	}
	if _, err := s.store.db.Exec("DROP TRIGGER fail_topic_delete"); err != nil {
		t.Fatal(err)
	}
	trashOK(t, s, "trash.topic.delete_permanently", object{"topicIds": []any{topic["id"]}})
	rows, err := s.topicRows(text(topic["id"]))
	if err != nil || len(rows) != 0 {
		t.Fatal("deleted topic retained messages", err)
	}
	otherRows, err := s.topicRows(text(other["id"]))
	if err != nil || len(otherRows) != 1 {
		t.Fatal("another topic was altered", err)
	}
}

func TestModelAndAssistantDeletionRetainChatHistory(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Assistant", "modelId": "test::local"}))
	dataOK(t, s, "PATCH", "/topics/"+text(topic["id"]), object{"assistantId": assistant["id"]})
	message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "assistant", "status": "success", "modelId": "test::local", "data": object{"parts": []any{object{"type": "text", "text": "saved answer"}}}, "messageSnapshot": object{"model": object{"id": "test::local"}}}))
	if err := s.store.setPreference("chat.retry.fallback_model_ids", []any{"test::local"}); err != nil {
		t.Fatal(err)
	}
	dataOK(t, s, "DELETE", "/models/test::local", nil)
	saved, err := s.store.get("messages", text(message["id"]))
	if err != nil || saved["modelId"] != nil || partsText(obj(saved["data"])["parts"]) != "saved answer" || obj(obj(saved["messageSnapshot"])["model"])["id"] != "test::local" {
		t.Fatal("model deletion removed history or changed its immutable snapshot", err)
	}
	updated, _ := s.store.get("assistants", text(assistant["id"]))
	if updated["modelId"] != nil || updated["modelName"] != nil {
		t.Fatal("assistant kept a deleted default model")
	}
	if value, _ := s.store.preference("chat.default_model_id"); value != nil {
		t.Fatal("default model preference is dangling")
	}
	if value, _ := s.store.preference("chat.retry.fallback_model_ids"); len(array(value)) != 0 {
		t.Fatal("fallback models are dangling")
	}
	trashOK(t, s, "trash.assistant.delete_permanently", object{"assistantId": assistant["id"], "deleteTopics": false})
	savedTopic, err := s.store.get("topics", text(topic["id"]))
	if err != nil || savedTopic["assistantId"] != nil {
		t.Fatal("assistant deletion did not detach its topic", err)
	}
	if _, err := s.store.get("messages", text(message["id"])); err != nil {
		t.Fatal("assistant deletion removed history", err)
	}
}

func TestProviderDeletionCleansOwnedModelsAndSecrets(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	dataOK(t, s, "POST", "/providers", object{"providerId": "test-other", "name": "Other"})
	dataOK(t, s, "POST", "/models", []any{object{"providerId": "test-other", "modelId": "local"}})
	addKey(t, s, "test", "same", "synthetic-delete")
	addKey(t, s, "test-other", "same", "synthetic-preserve")
	// Version 1 allowed ':' in provider IDs; a prefix delete must not erase their keys.
	legacy, _ := s.store.get("providers", "test-other")
	legacy["id"] = "test:legacy"
	encoded, err := json.Marshal(legacy)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.db.Exec("INSERT INTO entity(resource,id,body) VALUES('providers',?,?)", legacy["id"], string(encoded)); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setSecret("test:legacy:same", "synthetic-legacy"); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setSecret("test:legacy-orphan", "synthetic-orphan"); err != nil {
		t.Fatal(err)
	}
	dataOK(t, s, "DELETE", "/providers/test", nil)
	for _, id := range []string{"test:same", "test:legacy-orphan"} {
		if _, err := s.store.secret(id); !errors.Is(err, sql.ErrNoRows) {
			t.Fatal("provider deletion retained credential", err)
		}
	}
	if _, err := s.store.get("models", "test::local"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("provider deletion retained model", err)
	}
	if _, err := s.store.get("models", "test-other::local"); err != nil {
		t.Fatal("unrelated provider model was deleted", err)
	}
	if plain, err := s.store.secret("test-other:same"); err != nil || plain != "synthetic-preserve" {
		t.Fatal("unrelated credential changed", err)
	}
	if plain, err := s.store.secret("test:legacy:same"); err != nil || plain != "synthetic-legacy" {
		t.Fatal("legacy provider credential changed", err)
	}
	dataOK(t, s, "POST", "/providers", object{"providerId": "owner%_🍒", "name": "Unicode owner"})
	addKey(t, s, "owner%_🍒", "same", "synthetic-unicode")
	dataOK(t, s, "DELETE", "/providers/owner%25_%F0%9F%8D%92", nil)
	if _, err := s.store.secret("owner%_🍒:same"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("unicode provider retained credential", err)
	}
}

func TestActiveGenerationBlocksRelatedDeletion(t *testing.T) {
	started := make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		w.(http.Flusher).Flush()
		close(started)
		<-r.Context().Done()
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	defer s.cancel()
	topic := seedChat(t, s, endpoint.URL)
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Active assistant"}))
	dataOK(t, s, "PATCH", "/topics/"+text(topic["id"]), object{"assistantId": assistant["id"]})
	g := launch(t, s, topic)
	<-started
	for _, path := range []string{"/providers/test", "/models/test::local"} {
		response := dataResponse(t, s, "DELETE", path, nil)
		if response["error"] == nil || !strings.Contains(text(obj(response["error"])["message"]), "generation") {
			t.Fatalf("active resource deletion not refused: %s", path)
		}
	}
	for route, input := range map[string]object{
		"trash.topic.delete_permanently":     {"topicIds": []any{topic["id"]}},
		"trash.assistant.delete_permanently": {"assistantId": assistant["id"], "deleteTopics": false},
	} {
		if response := trashResult(t, s, route, input); obj(response["error"])["code"] != "TRASH_TOPIC_BUSY" {
			t.Fatalf("active conversation not protected by original Trash protocol: %s: %v", route, response)
		}
	}
	if err := s.abort(text(topic["id"])); err != nil {
		t.Fatal(err)
	}
	waitDone(t, g)
	dataOK(t, s, "DELETE", "/providers/test", nil)
}

func TestRelationValidationRejectsDanglingWritesAndBatchIdentityChanges(t *testing.T) {
	s, _ := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	for _, request := range []struct {
		method, path string
		body         any
	}{
		{"POST", "/models", []any{object{"providerId": "test", "modelId": "would-rollback"}, object{"providerId": "missing", "modelId": "bad"}}},
		{"POST", "/assistants", object{"name": "Bad assistant", "modelId": "missing"}},
		{"POST", "/topics", object{"assistantId": "missing"}},
		{"PATCH", "/models", []any{object{"uniqueModelId": "test::local", "patch": object{"providerId": "missing"}}}},
	} {
		if response := dataResponse(t, s, request.method, request.path, request.body); response["error"] == nil {
			t.Fatalf("invalid relation accepted: %s %s", request.method, request.path)
		}
	}
	if _, err := s.store.get("models", "test::would-rollback"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("part of a failed model batch persisted")
	}
	if err := s.store.setPreference("chat.default_model_id", "missing"); err == nil {
		t.Fatal("dangling model preference accepted")
	}
}

func TestVersionOneMigrationPrunesOrphanSecretsWithoutReseeding(t *testing.T) {
	s, directory := testServer(t)
	seedChat(t, s, "http://127.0.0.1:1")
	addKey(t, s, "test", "retained", "synthetic-retained")
	dataOK(t, s, "PATCH", "/providers/test", object{"name": "Saved provider", "isEnabled": false})
	if err := s.store.setPreference("app.language", "ja-JP"); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setSecret("test:old-orphan", "synthetic-orphan"); err != nil {
		t.Fatal(err)
	}
	builtin := text(s.store.defaults.Providers[0]["id"])
	if err := s.store.delete("providers", builtin); err != nil {
		t.Fatal(err)
	}
	if _, err := s.store.db.Exec("PRAGMA user_version=1"); err != nil {
		t.Fatal(err)
	}
	s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	if _, err := reopened.secret("test:old-orphan"); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("migration retained orphan secret", err)
	}
	if plain, err := reopened.secret("test:retained"); err != nil || plain != "synthetic-retained" {
		t.Fatal("migration changed active credential", err)
	}
	if _, err := reopened.get("providers", builtin); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("deleted built-in provider reappeared", err)
	}
	provider, err := reopened.get("providers", "test")
	if err != nil || provider["name"] != "Saved provider" || provider["isEnabled"] != false {
		t.Fatal("migration changed saved provider settings", err)
	}
	if _, err := reopened.get("providers", text(s.store.defaults.Providers[1]["id"])); err != nil {
		t.Fatal("migration removed another built-in provider", err)
	}
	if language, err := reopened.preference("app.language"); err != nil || language != "ja-JP" {
		t.Fatal("migration changed saved user preferences", err)
	}
	var version int
	if err := reopened.db.QueryRow("PRAGMA user_version").Scan(&version); err != nil || version != 3 {
		t.Fatal("schema version did not advance", err)
	}
}

func TestHostnameUsesOriginalRendererChannel(t *testing.T) {
	s, _ := testServer(t)
	actual, err, _ := s.invoke("system:getHostname", nil)
	expected, hostErr := os.Hostname()
	if err != nil || hostErr != nil || actual != expected {
		t.Fatal("hostname channel did not return the OS hostname", err, hostErr)
	}
}

func TestVersionOnePendingRecoveryPreservesDanglingHistory(t *testing.T) {
	for _, removed := range []string{"models", "topics"} {
		t.Run("deleted_"+removed, func(t *testing.T) {
			s, directory := testServer(t)
			topic := seedChat(t, s, "http://127.0.0.1:1")
			message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{
				"role": "assistant", "modelId": "test::local",
				"data": object{"parts": []any{object{"type": "text", "text": "saved legacy partial"}}},
			}))
			message["updatedAt"] = "2000-01-01T00:00:00Z"
			message["legacyField"] = object{"retain": true}
			if err := s.store.put("messages", message); err != nil {
				t.Fatal(err)
			}
			// Simulate v1's permissive deletion while this reply was still pending.
			id := "test::local"
			if removed == "topics" {
				id = text(topic["id"])
			}
			if err := s.store.delete(removed, id); err != nil {
				t.Fatal(err)
			}
			if _, err := s.store.db.Exec("PRAGMA user_version=1"); err != nil {
				t.Fatal(err)
			}
			s.store.db.Close()
			reopened, err := openStore(directory)
			if err != nil {
				t.Fatal("legacy dangling history prevented opening the profile", err)
			}
			defer reopened.db.Close()
			saved, err := reopened.get("messages", text(message["id"]))
			if err != nil || saved["status"] != "error" || saved["updatedAt"] == message["updatedAt"] {
				t.Fatal("pending legacy reply was not marked interrupted", err)
			}
			before, after := clone(message), clone(saved)
			for _, field := range []string{"status", "updatedAt"} {
				delete(before, field)
				delete(after, field)
			}
			if !reflect.DeepEqual(before, after) {
				t.Fatal("recovery changed legacy message fields besides status and updatedAt")
			}
			invalid := clone(saved)
			invalid["id"] = newID()
			if err := reopened.put("messages", invalid); err == nil {
				t.Fatal("legacy recovery bypass leaked into normal write validation")
			}
		})
	}
}
