package main

import (
	"bytes"
	"database/sql"
	"errors"
	"reflect"
	"testing"
	"time"
)

func archiveResponse(t *testing.T, s *server, method, path string, query object) object {
	t.Helper()
	value, err, _ := s.invoke("data-api:request", []any{object{"id": "archive-test", "method": method, "path": path, "params": query}})
	if err != nil {
		t.Fatal(err)
	}
	return obj(value)
}

func archivePage(t *testing.T, s *server, query object) object {
	t.Helper()
	response := archiveResponse(t, s, "GET", "/archives", query)
	if response["error"] != nil {
		t.Fatal(response["error"])
	}
	return obj(response["data"])
}

func TestArchivesOriginalDTOAndTrashLifecycle(t *testing.T) {
	s, _ := testServer(t)
	owner := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Original owner"}))
	topic := obj(dataOK(t, s, "POST", "/topics", object{"name": "Archived conversation", "assistantId": owner["id"]}))
	message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "user", "data": object{"parts": []any{object{"type": "text", "text": "retained history"}}}}))
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	trashOK(t, s, "trash.topic.archive", object{"topicIds": []any{topic["id"]}})
	if !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("archive did not invalidate its mounted list")
	}
	page := archivePage(t, s, nil)
	entries := page["items"].([]object)
	if len(entries) != 1 || page["nextCursor"] != nil {
		t.Fatal("archive page did not include the trashed topic", page)
	}
	entry := entries[0]
	if len(entry) != 6 || entry["id"] != "topics:"+text(topic["id"]) || entry["entityId"] != topic["id"] || entry["domain"] != "topics" || entry["name"] != topic["name"] || entry["parentName"] != owner["name"] {
		t.Fatal("archive DTO does not match the original renderer contract", entry)
	}
	stored, _ := s.store.get("topics", text(topic["id"]))
	deleted, err := time.Parse(time.RFC3339Nano, text(stored["deletedAt"]))
	if err != nil || entry["deletedAt"] != float64(deleted.UnixMilli()) {
		t.Fatal("archive timestamp must be epoch milliseconds", entry["deletedAt"], err)
	}
	output.Reset()
	dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/restore", nil)
	if len(archivePage(t, s, nil)["items"].([]object)) != 0 || !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("restored topic remained in the archive list")
	}
	if _, err := s.store.get("messages", text(message["id"])); err != nil {
		t.Fatal("restoring the topic lost history", err)
	}
	trashOK(t, s, "trash.assistant.archive", object{"assistantId": owner["id"], "deleteTopics": true})
	if len(archivePage(t, s, nil)["items"].([]object)) != 2 {
		t.Fatal("All archive did not aggregate assistants and topics")
	}
	output.Reset()
	dataOK(t, s, "POST", "/assistants/"+text(owner["id"])+"/restore", nil)
	if len(archivePage(t, s, nil)["items"].([]object)) != 1 || !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("assistant restore did not update the unified archive")
	}
	output.Reset()
	response := archiveResponse(t, s, "DELETE", "/topics/"+text(topic["id"]), object{"permanent": true})
	if response["error"] != nil || len(archivePage(t, s, nil)["items"].([]object)) != 0 || !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("permanent topic delete did not update the archive", response)
	}
	if _, err := s.store.get("messages", text(message["id"])); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("permanent topic delete retained its message", err)
	}
	trashOK(t, s, "trash.assistant.archive", object{"assistantId": owner["id"], "deleteTopics": false})
	response = archiveResponse(t, s, "DELETE", "/assistants/"+text(owner["id"]), object{"permanent": true})
	if response["error"] != nil || len(archivePage(t, s, nil)["items"].([]object)) != 0 {
		t.Fatal("permanent assistant delete did not update the archive", response)
	}
	other := obj(dataOK(t, s, "POST", "/topics", object{"name": "Purge me"}))
	trashOK(t, s, "trash.topic.archive", object{"topicIds": []any{other["id"]}})
	output.Reset()
	trashOK(t, s, "trash.purge_now", object{})
	if len(archivePage(t, s, nil)["items"].([]object)) != 0 || !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("purge did not update the archive")
	}
}

func TestArchivesKeysetPaginationSurvivesRestoringCursorRow(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	owner := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Same-id owner"}))
	owner["id"], owner["deletedAt"] = topic["id"], "2026-11-12T05:00:00.123111111Z"
	topic["name"], topic["assistantId"], topic["deletedAt"] = "Same-id topic", topic["id"], "2026-11-12T05:00:00.123987654Z"
	older := obj(dataOK(t, s, "POST", "/topics", object{"name": "Older ownerless topic"}))
	older["deletedAt"] = "2026-11-12T04:00:00Z"
	for _, row := range []struct {
		resource string
		value    object
	}{{"assistants", owner}, {"topics", topic}, {"topics", older}} {
		if err := s.store.put(row.resource, row.value); err != nil {
			t.Fatal(err)
		}
	}
	first := archivePage(t, s, object{"limit": 1})
	if item := first["items"].([]object)[0]; item["id"] != "assistants:"+text(topic["id"]) || item["parentName"] != nil {
		t.Fatal("same-time ordering must use the domain-qualified ID", first)
	}
	dataOK(t, s, "POST", "/assistants/"+text(topic["id"])+"/restore", nil)
	second := archivePage(t, s, object{"limit": "1", "cursor": first["nextCursor"]})
	if item := second["items"].([]object)[0]; item["id"] != "topics:"+text(topic["id"]) || item["parentName"] != owner["name"] {
		t.Fatal("restoring the cursor row skipped a same-time entry", second)
	}
	third := archivePage(t, s, object{"limit": 1, "cursor": second["nextCursor"]})
	if item := third["items"].([]object)[0]; item["entityId"] != older["id"] || item["parentName"] != nil || third["nextCursor"] != nil {
		t.Fatal("keyset pagination did not finish at the older entry", third)
	}
	if items := archivePage(t, s, object{"domain": "topics"})["items"].([]object); len(items) != 2 {
		t.Fatal("topic domain filter failed", items)
	}
	for _, domain := range []string{"assistants", "agents", "sessions", "paintings", "files"} {
		if items := archivePage(t, s, object{"domain": domain})["items"].([]object); len(items) != 0 {
			t.Fatal("empty archive domain included unrelated rows", domain, items)
		}
	}
	for _, cursor := range []string{"bad", ":topics:missing", "bad%:topics:missing", "NaN:topics:missing"} {
		if got := archivePage(t, s, object{"cursor": cursor}); !reflect.DeepEqual(got, archivePage(t, s, nil)) {
			t.Fatal("malformed browsing cursor did not fall back to the first page", cursor, got)
		}
	}
}

func TestArchivesRejectInvalidQueryAndFailedArchivePublishesNoChange(t *testing.T) {
	s, _ := testServer(t)
	for _, query := range []object{{"domain": "unknown"}, {"domain": ""}, {"domain": nil}, {"cursor": 1}, {"cursor": nil}, {"limit": 0}, {"limit": 201}, {"limit": 1.5}, {"limit": "bad"}, {"limit": nil}, {"sortBy": "name"}} {
		if response := archiveResponse(t, s, "GET", "/archives", query); response["error"] == nil {
			t.Fatal("invalid archive query was accepted", query)
		}
	}
	if response := archiveResponse(t, s, "POST", "/archives", nil); response["error"] == nil {
		t.Fatal("unsupported archive mutation claimed success")
	}
	topic := obj(dataOK(t, s, "POST", "/topics", object{}))
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	s.active[text(topic["id"])] = &generation{}
	result := trashResult(t, s, "trash.topic.archive", object{"topicIds": []any{topic["id"]}})
	delete(s.active, text(topic["id"]))
	if result["ok"] != false || output.Len() != 0 || len(archivePage(t, s, nil)["items"].([]object)) != 0 {
		t.Fatal("refused active generation archive changed its list", result)
	}
}

func TestArchivesTimestampFormatsAndOwnerProjectionChanges(t *testing.T) {
	s, _ := testServer(t)
	owner := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Original owner"}))
	topic := obj(dataOK(t, s, "POST", "/topics", object{"name": "Archived topic", "assistantId": owner["id"]}))
	base := time.Date(2026, 11, 12, 5, 0, 0, 0, time.UTC).UnixMilli()
	for _, example := range []struct {
		value any
		want  int64
	}{
		{"2026-11-12T05:00:00Z", base},
		{"2026-11-12T05:00:00.1Z", base + 100},
		{"2026-11-12T05:00:00.12Z", base + 120},
		{"2026-11-12T05:00:00.123Z", base + 123},
		{"2026-11-12T05:00:00.999999999Z", base + 999},
		{float64(base + 123), base + 123},
	} {
		topic["deletedAt"] = example.value
		if err := s.store.put("topics", topic); err != nil {
			t.Fatal(err)
		}
		entry := archivePage(t, s, nil)["items"].([]object)[0]
		if entry["deletedAt"] != float64(example.want) {
			t.Fatalf("timestamp %v became %v, want %d", example.value, entry["deletedAt"], example.want)
		}
	}
	var output bytes.Buffer
	s.writer = &wireWriter{output: &output}
	dataOK(t, s, "PATCH", "/assistants/"+text(owner["id"]), object{"name": "Renamed owner"})
	if !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("owner rename did not invalidate archived topic attribution")
	}
	output.Reset()
	dataOK(t, s, "PATCH", "/topics/"+text(topic["id"]), object{"name": "Renamed archived topic"})
	entry := archivePage(t, s, nil)["items"].([]object)[0]
	if entry["name"] != "Renamed archived topic" || entry["parentName"] != "Renamed owner" || !changedEndpoints(t, output.Bytes())["/archives"] {
		t.Fatal("archive projection did not follow source names", entry)
	}
}
