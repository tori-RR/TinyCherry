package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
)

const notificationRetention = 30 * 24 * time.Hour

func notificationVisible(row object, now int64) bool {
	return row["dismissedAt"] == nil && replaySequence(row["createdAt"]) > now-notificationRetention.Milliseconds()
}

func (s *server) notificationEffects() {
	s.changed("/notifications", "/notifications/unread-count", "/notifications/:id")
}

// Consumption and the terminal message share one SQLite transaction. Keeping a
// separate tombstone prevents a dismissed or expired outcome being delivered twice.
func (s *store) generationNotification(row object, status string, finished int64) (object, error) {
	if s.temporary.has(text(row["topicId"])) {
		return nil, nil
	}
	encoded, _ := json.Marshal([]string{"assistant", text(row["id"])})
	key := "task-result:" + string(encoded)
	if _, err := s.get("notification-consumed", key); err == nil {
		return nil, nil
	} else if !errors.Is(err, sql.ErrNoRows) {
		return nil, err
	}
	if err := s.put("notification-consumed", object{"id": key}); err != nil {
		return nil, err
	}
	enabled, err := s.preference("app.notification.center.system.enabled")
	if err != nil {
		return nil, err
	}
	if enabled == false {
		return nil, nil
	}
	topic, err := s.get("topics", text(row["topicId"]))
	if err != nil {
		return nil, err
	}
	name := strings.TrimSpace(text(topic["name"]))
	if name == "" {
		name = "新对话"
	}
	resultStatus, title := "succeeded", "任务已完成"
	switch status {
	case "error":
		resultStatus, title = "failed", "任务失败"
	case "paused":
		resultStatus, title = "cancelled", "任务已取消"
	case "interrupted":
		resultStatus, title = "interrupted", "任务已中断"
	}
	result := object{"source": "assistant", "status": resultStatus, "name": name}
	snapshot := obj(row["messageSnapshot"])
	if actor := strings.TrimSpace(text(snapshot["name"])); actor != "" {
		emoji := text(snapshot["emoji"])
		if emoji == "" {
			emoji = "🍒"
		}
		result["actor"] = object{"name": actor, "emoji": emoji}
	}
	if started, err := time.Parse(time.RFC3339Nano, text(row["createdAt"])); err == nil && finished >= started.UnixMilli() {
		result["durationMs"] = finished - started.UnixMilli()
	}
	if status == "error" {
		result["errorSummary"] = "生成回复失败"
	}
	target := object{"kind": "conversation", "conversationType": "assistant", "conversationId": row["topicId"], "messageId": row["id"], "replyPreview": row["searchableText"], "result": result}
	if target["replyPreview"] == nil {
		target["replyPreview"] = ""
	}
	var read any
	if status == "paused" {
		read = finished
	}
	record := object{"id": newID(), "eventKey": key, "category": "system", "kind": "task-result", "title": title, "message": name, "createdAt": finished, "readAt": read, "dismissedAt": nil, "target": target}
	return record, s.put("notifications", record)
}

func (s *server) notificationData(method, path string, query, input object) (any, error, bool) {
	if path != "/notifications" && !strings.HasPrefix(path, "/notifications/") {
		return nil, nil, false
	}
	now := time.Now().UnixMilli()
	rows, err := s.store.list("notifications")
	if err != nil {
		return nil, err, true
	}
	visible := []object{}
	for _, row := range rows {
		if notificationVisible(row, now) {
			visible = append(visible, row)
		}
	}
	if method == "GET" && path == "/notifications/unread-count" {
		count := 0
		for _, row := range visible {
			if row["readAt"] == nil {
				count++
			}
		}
		return object{"count": count}, nil, true
	}
	if path == "/notifications" && method == "GET" {
		for key := range query {
			if key != "category" && key != "cursor" && key != "limit" {
				return nil, errors.New("invalid notification query"), true
			}
		}
		category := text(query["category"])
		if query["category"] != nil && category != "system" && category != "usage" && category != "official" {
			return nil, errors.New("invalid notification category"), true
		}
		limit := 50
		if query["limit"] != nil {
			n, e := strconv.Atoi(fmt.Sprint(query["limit"]))
			if e != nil || n < 1 || n > 100 {
				return nil, errors.New("invalid notification page size"), true
			}
			limit = n
		}
		cursor := text(query["cursor"])
		if len(cursor) > 256 {
			return nil, errors.New("invalid notification cursor"), true
		}
		var cursorTime int64
		var cursorID string
		if parts := strings.SplitN(cursor, ":", 2); len(parts) == 2 {
			decoded, e := url.QueryUnescape(parts[0])
			n, e2 := strconv.ParseInt(decoded, 10, 64)
			if e == nil && e2 == nil && n >= 0 && parts[1] != "" {
				cursorTime, cursorID = n, parts[1]
			}
		}
		sort.Slice(visible, func(i, j int) bool {
			left, right := replaySequence(visible[i]["createdAt"]), replaySequence(visible[j]["createdAt"])
			if left == right {
				return text(visible[i]["id"]) > text(visible[j]["id"])
			}
			return left > right
		})
		items := []object{}
		for _, row := range visible {
			if category != "" && row["category"] != category {
				continue
			}
			if cursorID != "" {
				at := replaySequence(row["createdAt"])
				if at > cursorTime || (at == cursorTime && text(row["id"]) >= cursorID) {
					continue
				}
			}
			items = append(items, row)
			if len(items) > limit {
				break
			}
		}
		page := object{"items": items}
		if len(items) > limit {
			items = items[:limit]
			page["items"] = items
			last := items[len(items)-1]
			page["nextCursor"] = strconv.FormatInt(replaySequence(last["createdAt"]), 10) + ":" + text(last["id"])
		}
		return page, nil, true
	}
	changed := false
	mark := func(row object, field string) error {
		if row[field] != nil {
			return nil
		}
		row[field] = now
		if err := s.store.put("notifications", row); err != nil {
			return err
		}
		changed = true
		return nil
	}
	if method == "POST" && (path == "/notifications/read-all" || path == "/notifications/read-conversation") {
		if path == "/notifications/read-conversation" {
			if len(input) != 2 || (input["conversationType"] != "assistant" && input["conversationType"] != "agent") || text(input["conversationId"]) == "" {
				return nil, errors.New("invalid conversation notification target"), true
			}
		}
		for _, row := range visible {
			target := obj(row["target"])
			if path == "/notifications/read-conversation" && (target["kind"] != "conversation" || target["conversationType"] != input["conversationType"] || target["conversationId"] != input["conversationId"]) {
				continue
			}
			if err := mark(row, "readAt"); err != nil {
				return nil, err, true
			}
		}
	} else {
		id, decodeErr := url.PathUnescape(strings.TrimPrefix(path, "/notifications/"))
		if decodeErr != nil || id == "" || strings.Contains(id, "/") || path == "/notifications" {
			return nil, notMigrated(method + " " + path), true
		}
		var found object
		for _, row := range visible {
			if row["id"] == id {
				found = row
				break
			}
		}
		if method == "GET" {
			if found == nil {
				return nil, sql.ErrNoRows, true
			}
			return found, nil, true
		}
		if method == "PATCH" {
			if len(input) != 1 || input["read"] != true {
				return nil, errors.New("only read:true is supported"), true
			}
			if found != nil {
				err = mark(found, "readAt")
			}
		} else if method == "DELETE" {
			if found != nil {
				err = mark(found, "dismissedAt")
			}
		} else {
			return nil, notMigrated(method + " " + path), true
		}
	}
	if err == nil && changed {
		s.store.onCommit(s.notificationEffects)
	}
	return nil, err, true
}

func (s *server) activateNotification(input object) error {
	if len(input) != 1 || text(input["id"]) == "" {
		return errors.New("notification id required")
	}
	id := text(input["id"])
	row, err := s.store.get("notifications", id)
	if err != nil || !notificationVisible(row, time.Now().UnixMilli()) {
		return sql.ErrNoRows
	}
	if err := s.transaction(func(tx *server) error {
		_, err, _ := tx.notificationData("PATCH", "/notifications/"+url.PathEscape(id), nil, object{"read": true})
		return err
	}); err != nil {
		return err
	}
	target := obj(row["target"])
	switch target["kind"] {
	case nil:
		return nil
	case "conversation":
		if target["conversationType"] != "assistant" {
			return notMigrated("agent notification activation")
		}
		topic, err := s.store.get("topics", text(target["conversationId"]))
		if err != nil || topic["deletedAt"] != nil {
			return sql.ErrNoRows
		}
		title := strings.TrimSpace(text(topic["name"]))
		if title == "" {
			title = "新对话"
		}
		payload := object{"requestId": newID(), "target": object{"conversationType": "assistant", "conversationId": target["conversationId"]}, "title": title}
		if message, ok := target["messageId"]; ok {
			payload["messageId"] = message
		}
		s.event("navigation.conversation_focus_or_open_requested", payload)
	case "settings":
		tab := text(target["tab"])
		if tab != "usage" && tab != "data" && tab != "profile" {
			return errors.New("invalid notification settings target")
		}
		s.event("navigation.open_route_requested", object{"to": "/settings/" + tab})
	case "knowledge":
		base, err := s.store.get("knowledge-bases", text(target["baseId"]))
		if err != nil || base["deletedAt"] != nil {
			return sql.ErrNoRows
		}
		s.event("navigation.open_route_requested", object{"to": "/app/knowledge?baseId=" + url.QueryEscape(text(target["baseId"]))})
	case "release", "announcement":
		s.event("notification.open", object{"id": id})
	default:
		return notMigrated("notification target " + text(target["kind"]))
	}
	return nil
}
