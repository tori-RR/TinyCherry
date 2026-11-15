package main

import (
	"bytes"
	"context"
	"database/sql"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"image"
	"image/png"
	"io"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"
)

func compatibilityIPC(t *testing.T, s *server, route string, input object) any {
	t.Helper()
	encoded, _ := json.Marshal(input)
	var wire object
	_ = json.Unmarshal(encoded, &wire)
	result, err, after := s.invoke("ipc-api:request", []any{route, wire})
	if err != nil || obj(result)["ok"] != true {
		t.Fatalf("%s failed: %v %v", route, result, err)
	}
	if after != nil {
		after()
	}
	return obj(result)["data"]
}

func TestAvatarImageHistoryAndDefaultSemantics(t *testing.T) {
	s, directory := testServer(t)
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Avatar", "emoji": "🌸"}))
	var buffer bytes.Buffer
	if err := png.Encode(&buffer, image.NewRGBA(image.Rect(0, 0, 2, 2))); err != nil {
		t.Fatal(err)
	}
	payload := object{"assistantId": assistant["id"], "avatar": object{"kind": "image", "data": skillBytes(buffer.Bytes())}}
	if value := compatibilityIPC(t, s, "assistant.set_avatar", payload); value != nil {
		t.Fatal("set avatar must return void")
	}
	assistant, _ = s.store.get("assistants", text(assistant["id"]))
	fileID := text(assistant["avatarFileId"])
	if fileID == "" || !strings.HasPrefix(text(assistant["avatarSrc"]), "data:image/png;base64,") {
		t.Fatal("image was not projected", assistant)
	}
	topic := obj(dataOK(t, s, "POST", "/topics", object{"assistantId": assistant["id"]}))
	var row object
	if err := s.transaction(func(tx *server) error {
		var err error
		row, err = tx.createMessage(topic, object{"role": "assistant", "data": object{"parts": []any{}}, "messageSnapshot": object{"avatarFileId": fileID}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	compatibilityIPC(t, s, "assistant.set_avatar", object{"assistantId": assistant["id"], "avatar": object{"kind": "default"}})
	assistant, _ = s.store.get("assistants", text(assistant["id"]))
	if assistant["emoji"] != "🌸" || assistant["avatarSrc"] != nil || assistant["avatarFileId"] != nil {
		t.Fatal("default must clear image only", assistant)
	}
	read := obj(compatibilityIPC(t, s, "file.read", object{"handle": object{"kind": "entry", "entryId": fileID}, "options": object{"mode": "full", "encoding": "binary"}}))
	if read["mime"] != "image/png" || !reflect.DeepEqual(read["content"], skillBytes(buffer.Bytes())) {
		t.Fatal("historical avatar bytes lost", read)
	}
	compatibilityIPC(t, s, "assistant.set_avatar", object{"assistantId": assistant["id"], "avatar": object{"kind": "emoji", "emoji": "🍓"}})
	saved, _ := s.store.get("messages", text(row["id"]))
	if obj(saved["messageSnapshot"])["avatarFileId"] != fileID {
		t.Fatal("historical snapshot changed")
	}
	_ = s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	if _, err := reopened.get("avatar-images", fileID); err != nil {
		t.Fatal("image not durable", err)
	}
}

func TestAvatarAcceptsNormalizedWebPAndRejectsMalformedInput(t *testing.T) {
	s, _ := testServer(t)
	assistant := obj(dataOK(t, s, "POST", "/assistants", object{"name": "Avatar"}))
	// A complete 1x1 lossless WebP, the same format emitted by prepareAvatarImage.
	webp, err := base64.StdEncoding.DecodeString("UklGRiIAAABXRUJQVlA4TBUAAAAvAAAAAAfQ//73v/+BiOh/AAA=")
	if err != nil {
		t.Fatal(err)
	}
	if mime, err := avatarImage(webp); err != nil || mime != "image/webp" {
		t.Fatal("normalized WebP rejected", mime, err)
	}
	compatibilityIPC(t, s, "assistant.set_avatar", object{"assistantId": assistant["id"], "avatar": object{"kind": "image", "data": skillBytes(webp)}})
	for _, avatar := range []object{{"kind": "image", "data": []any{0, 1, 2}}, {"kind": "image", "data": []any{false}}, {"kind": "image", "data": []any{-1}}, {"kind": "emoji", "emoji": "plain"}, {"kind": "default", "path": "C:/private"}} {
		result, _, _ := s.invoke("ipc-api:request", []any{"assistant.set_avatar", object{"assistantId": assistant["id"], "avatar": avatar}})
		if obj(result)["ok"] == true {
			t.Fatal("invalid avatar accepted", avatar)
		}
	}
	result, _, _ := s.invoke("ipc-api:request", []any{"file.read", object{"handle": object{"kind": "entry", "entryId": newID()}, "options": object{"mode": "full", "encoding": "binary"}}})
	if obj(result)["ok"] == true {
		t.Fatal("unregistered entry read succeeded")
	}
}

func TestTemporaryChatMemoryOnlyThenAtomicPromotion(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"temporary answer\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	seedChat(t, s, endpoint.URL)
	topic := obj(compatibilityIPC(t, s, "ai.temporary_topic.create", object{}))
	id := text(topic["id"])
	if topic["activeNodeId"] != nil || topic["orderKey"] != "" {
		t.Fatal("temporary create contract drift", topic)
	}
	g := launch(t, s, topic)
	waitDone(t, g)
	var count int
	if err := s.store.db.QueryRow("SELECT count(*) FROM entity WHERE (resource='topics' AND id=?) OR (resource='messages' AND json_extract(body,'$.topicId')=?)", id, id).Scan(&count); err != nil || count != 0 {
		t.Fatal("temporary conversation leaked to SQLite", count, err)
	}
	notifications, _ := s.store.list("notifications")
	if len(notifications) != 0 {
		t.Fatal("temporary chat produced durable notifications")
	}
	savedTopic, _ := s.store.get("topics", id)
	savedReply, _ := s.store.get("messages", text(g.row["id"]))
	compatibilityIPC(t, s, "ai.temporary_topic.persist", object{"id": id})
	if s.store.temporary.has(id) {
		t.Fatal("promotion left temporary owner")
	}
	durable, _ := s.store.get("topics", id)
	reply, _ := s.store.get("messages", text(g.row["id"]))
	if durable["activeNodeId"] != savedTopic["activeNodeId"] || durable["createdAt"] != topic["createdAt"] || !reflect.DeepEqual(reply, savedReply) {
		t.Fatal("promotion lost ids/history")
	}
	if _, err := s.temporaryCommand("ai.temporary_topic.delete", object{"id": id}); !errors.Is(err, sql.ErrNoRows) {
		t.Fatal("stale cleanup targeted persistent topic", err)
	}
}

func TestTemporaryPromotionRollbackAndDiscard(t *testing.T) {
	s, _ := testServer(t)
	topic := obj(compatibilityIPC(t, s, "ai.temporary_topic.create", object{}))
	id := text(topic["id"])
	_, err := s.store.db.Exec("CREATE TRIGGER reject_temporary_promotion BEFORE INSERT ON entity WHEN NEW.resource='topics' BEGIN SELECT RAISE(ABORT,'test promotion failure'); END")
	if err != nil {
		t.Fatal(err)
	}
	if _, err := s.temporaryCommand("ai.temporary_topic.persist", object{"id": id}); err == nil {
		t.Fatal("promotion should fail")
	}
	if !s.store.temporary.has(id) || len(s.store.temporary.rows(id)) != 1 {
		t.Fatal("rollback lost temporary repository")
	}
	if _, err := s.store.db.Exec("DROP TRIGGER reject_temporary_promotion"); err != nil {
		t.Fatal(err)
	}
	compatibilityIPC(t, s, "ai.temporary_topic.delete", object{"id": id})
	if s.store.temporary.has(id) {
		t.Fatal("discard retained memory")
	}
	rows, _ := s.store.list("topics")
	if len(rows) != 0 {
		t.Fatal("discard persisted topic")
	}
}

func TestTemporaryCleanupCannotCancelPersistentGeneration(t *testing.T) {
	s, _ := testServer(t)
	topic := obj(dataOK(t, s, "POST", "/topics", object{}))
	id := text(topic["id"])
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	s.active[id] = &generation{cancel: cancel, done: make(chan struct{})}
	_, err := s.temporaryCommand("ai.temporary_topic.delete", object{"id": id})
	delete(s.active, id)
	if !errors.Is(err, sql.ErrNoRows) || ctx.Err() != nil {
		t.Fatal("stale temporary cleanup cancelled persistent generation", err, ctx.Err())
	}
}

func TestTemporaryPromotesDuringReplyAndDiscardDrains(t *testing.T) {
	for _, promote := range []bool{true, false} {
		t.Run(fmt.Sprint(promote), func(t *testing.T) {
			started, finish := make(chan struct{}), make(chan struct{})
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
				w.(http.Flusher).Flush()
				close(started)
				select {
				case <-finish:
					fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\" final\"}}]}\n\ndata: [DONE]\n\n")
				case <-r.Context().Done():
				}
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			seedChat(t, s, endpoint.URL)
			topic := obj(compatibilityIPC(t, s, "ai.temporary_topic.create", object{}))
			g := launch(t, s, topic)
			select {
			case <-started:
			case <-time.After(5 * time.Second):
				t.Fatal("provider was not called")
			}
			if promote {
				compatibilityIPC(t, s, "ai.temporary_topic.persist", object{"id": topic["id"]})
				close(finish)
				waitDone(t, g)
				row, err := s.store.get("messages", text(g.row["id"]))
				if err != nil || row["status"] != "success" || row["searchableText"] != "partial final" {
					t.Fatal("live promotion lost final reply", row, err)
				}
				records, _ := s.store.list("notifications")
				if len(records) != 1 {
					t.Fatal("promoted terminal result missing")
				}
			} else {
				compatibilityIPC(t, s, "ai.temporary_topic.delete", object{"id": topic["id"]})
				waitDone(t, g)
				if s.store.temporary.has(text(topic["id"])) || s.active[text(topic["id"])] != nil {
					t.Fatal("discard did not drain")
				}
				var count int
				_ = s.store.db.QueryRow("SELECT count(*) FROM entity WHERE resource='messages' AND json_extract(body,'$.topicId')=?", topic["id"]).Scan(&count)
				if count != 0 {
					t.Fatal("discard leaked reply")
				}
			}
		})
	}
}

func TestAvatarEmojiMatchesSharedPropertyContract(t *testing.T) {
	for _, value := range []string{"🍓", "🌸", "👩‍💻", "🇨🇳", "1️⃣", "©️", "#"} {
		if !validAvatarEmoji(value) {
			t.Fatal("valid shared emoji rejected", value)
		}
	}
	for _, value := range []string{"", "plain", "中文", "🍓text", "\n🍒"} {
		if validAvatarEmoji(value) {
			t.Fatal("invalid shared emoji accepted", value)
		}
	}
}

func TestNotificationPolicyCancellationAndPostcommit(t *testing.T) {
	s, _ := testServer(t)
	capture := &projectionCapture{}
	s.writer = &wireWriter{output: capture}
	topic := obj(dataOK(t, s, "POST", "/topics", object{}))
	capture.Reset()
	row := object{"id": newID(), "topicId": topic["id"], "role": "assistant", "data": object{"parts": []any{}}, "status": "pending", "createdAt": timestamp()}
	if err := s.store.put("messages", row); err != nil {
		t.Fatal(err)
	}
	g := &generation{topicID: text(topic["id"]), row: row, parts: []any{}}
	if _, err := s.store.db.Exec("CREATE TRIGGER reject_notification BEFORE INSERT ON entity WHEN NEW.resource='notifications' BEGIN SELECT RAISE(ABORT,'test notification failure'); END"); err != nil {
		t.Fatal(err)
	}
	if err := s.persistGeneration(g, "success"); err == nil {
		t.Fatal("terminal transaction should roll back")
	}
	saved, _ := s.store.get("messages", text(row["id"]))
	if saved["status"] != "pending" || capture.Len() != 0 {
		t.Fatal("terminal write/effects escaped rollback", saved, capture.String())
	}
	if _, err := s.store.db.Exec("DROP TRIGGER reject_notification"); err != nil {
		t.Fatal(err)
	}
	if err := s.persistGeneration(g, "paused"); err != nil {
		t.Fatal(err)
	}
	records, _ := s.store.list("notifications")
	if len(records) != 1 || records[0]["readAt"] == nil || strings.Contains(capture.String(), "notification.present") {
		t.Fatal("cancelled result must be read and record-only", records, capture.String())
	}
	if err := s.store.setPreference("app.notification.center.system.enabled", false); err != nil {
		t.Fatal(err)
	}
	other := object{"id": newID(), "topicId": topic["id"], "role": "assistant", "createdAt": timestamp()}
	if err := s.store.transaction(func(tx *store) error {
		record, err := tx.generationNotification(other, "success", time.Now().UnixMilli())
		if record != nil {
			t.Fatal("disabled center produced a record")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setPreference("app.notification.center.system.enabled", true); err != nil {
		t.Fatal(err)
	}
	if err := s.store.transaction(func(tx *store) error {
		record, err := tx.generationNotification(other, "success", time.Now().UnixMilli())
		if record != nil {
			t.Fatal("suppressed outcome resurrected")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func notificationFixture(t *testing.T, s *server, topic object, status string, at int64) object {
	t.Helper()
	var record object
	err := s.transaction(func(tx *server) error {
		row := object{"id": newID(), "topicId": topic["id"], "role": "assistant", "createdAt": timestamp(), "searchableText": "result"}
		var err error
		record, err = tx.store.generationNotification(row, status, at)
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return record
}

func TestNotificationPagingReadScopesDismissAndActivation(t *testing.T) {
	s, _ := testServer(t)
	capture := &projectionCapture{}
	s.writer = &wireWriter{output: capture}
	topic := obj(dataOK(t, s, "POST", "/topics", object{"name": "Result"}))
	at := time.Now().UnixMilli()
	first := notificationFixture(t, s, topic, "success", at)
	second := notificationFixture(t, s, topic, "error", at+1)
	// Same conversation id in another domain must not be acknowledged accidentally.
	agent := clone(second)
	agent["id"], agent["eventKey"] = newID(), "agent-other"
	agent["target"] = object{"kind": "conversation", "conversationType": "agent", "conversationId": topic["id"]}
	if err := s.store.put("notifications", agent); err != nil {
		t.Fatal(err)
	}
	page, err, _ := s.notificationData("GET", "/notifications", object{"limit": 1}, nil)
	if err != nil {
		t.Fatal(err)
	}
	items := obj(page)["items"].([]object)
	if len(items) != 1 || text(obj(page)["nextCursor"]) == "" {
		t.Fatal("cursor contract", page)
	}
	next, err, _ := s.notificationData("GET", "/notifications", object{"limit": 100, "cursor": obj(page)["nextCursor"]}, nil)
	if err != nil || len(obj(next)["items"].([]object)) != 2 || obj(next)["nextCursor"] != nil {
		t.Fatal("pagination lost/duplicated items", next, err)
	}
	dataOK(t, s, "POST", "/notifications/read-conversation", object{"conversationType": "assistant", "conversationId": topic["id"]})
	if obj(dataOK(t, s, "GET", "/notifications/unread-count", nil))["count"] != 1 {
		t.Fatal("conversation ack crossed domains")
	}
	dataOK(t, s, "DELETE", "/notifications/"+text(first["id"]), nil)
	if dataResponse(t, s, "GET", "/notifications/"+text(first["id"]), nil)["status"] != 404 {
		t.Fatal("dismissed record remains visible")
	}
	compatibilityIPC(t, s, "notification.activate", object{"id": second["id"]})
	if !strings.Contains(capture.String(), "navigation.conversation_focus_or_open_requested") {
		t.Fatal("activation did not navigate")
	}
	dataOK(t, s, "POST", "/notifications/read-all", nil)
	if obj(dataOK(t, s, "GET", "/notifications/unread-count", nil))["count"] != 0 {
		t.Fatal("read-all failed")
	}
	if dataResponse(t, s, "PATCH", "/notifications/"+text(second["id"]), object{"read": false})["error"] == nil {
		t.Fatal("invalid ack accepted")
	}
}

func TestDataAPIVoidResponseOmitsData(t *testing.T) {
	s, _ := testServer(t)
	response := dataResponse(t, s, "POST", "/notifications/read-all", nil)
	encoded, err := json.Marshal(response)
	if err != nil {
		t.Fatal(err)
	}
	var wire object
	if err := json.Unmarshal(encoded, &wire); err != nil {
		t.Fatal(err)
	}
	if _, exists := wire["data"]; exists {
		t.Fatal("void DataApi result must decode to undefined, not null", string(encoded))
	}
	if wire["status"] != float64(200) || wire["error"] != nil {
		t.Fatal("void response failed", wire)
	}
}

func TestNotificationConsumptionSurvivesRollbackDismissAndReopen(t *testing.T) {
	s, directory := testServer(t)
	topic := obj(dataOK(t, s, "POST", "/topics", object{}))
	row := object{"id": newID(), "topicId": topic["id"], "role": "assistant", "createdAt": timestamp()}
	rollback := errors.New("rollback")
	if err := s.store.transaction(func(tx *store) error {
		if _, err := tx.generationNotification(row, "success", time.Now().UnixMilli()); err != nil {
			return err
		}
		return rollback
	}); !errors.Is(err, rollback) {
		t.Fatal(err)
	}
	var record object
	if err := s.store.transaction(func(tx *store) error {
		var err error
		record, err = tx.generationNotification(row, "success", time.Now().UnixMilli())
		return err
	}); err != nil || record == nil {
		t.Fatal("rollback consumed result", err)
	}
	dataOK(t, s, "DELETE", "/notifications/"+text(record["id"]), nil)
	_ = s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	if err := reopened.transaction(func(tx *store) error {
		again, err := tx.generationNotification(row, "success", time.Now().UnixMilli())
		if again != nil {
			t.Fatal("dismissed result resurrected")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
}

func TestNotificationTerminalProducerAndCrashRecovery(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		io.WriteString(w, "data: {\"choices\":[{\"delta\":{\"content\":\"complete\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	s, directory := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	capture := &projectionCapture{}
	s.writer = &wireWriter{output: capture}
	g := launch(t, s, topic)
	waitDone(t, g)
	records, _ := s.store.list("notifications")
	if len(records) != 1 || obj(obj(records[0]["target"])["result"])["status"] != "succeeded" {
		t.Fatal("terminal outcome missing", records)
	}
	if !strings.Contains(capture.String(), "notification.present") {
		t.Fatal("postcommit delivery missing")
	}
	if err := s.persistGeneration(g, "success"); err != nil {
		t.Fatal(err)
	}
	records, _ = s.store.list("notifications")
	if len(records) != 1 {
		t.Fatal("duplicate terminal delivery")
	}
	var pending object
	if err := s.transaction(func(tx *server) error {
		current, _ := tx.store.get("topics", text(topic["id"]))
		var err error
		pending, err = tx.createMessage(current, object{"role": "assistant", "data": object{"parts": []any{}}})
		return err
	}); err != nil {
		t.Fatal(err)
	}
	_ = s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	records, _ = reopened.list("notifications")
	if len(records) != 2 {
		t.Fatal("interruption not recorded", records)
	}
	saved, _ := reopened.get("messages", text(pending["id"]))
	if saved["status"] != "error" {
		t.Fatal("crash recovery failed")
	}
}
