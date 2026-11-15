package main

import (
	"database/sql"
	"errors"
	"sort"
	"sync"
	"time"
	"unicode/utf16"
)

// Temporary conversations use the same DTOs, but never enter the persistent entity table.
type temporaryState struct {
	mu       sync.Mutex
	topics   map[string]object
	messages map[string]object
	deleting map[string]bool
}

func newTemporaryState() *temporaryState {
	return &temporaryState{topics: map[string]object{}, messages: map[string]object{}, deleting: map[string]bool{}}
}

func (t *temporaryState) copyLocked() *temporaryState {
	view := newTemporaryState()
	for id, row := range t.topics {
		view.topics[id] = clone(row)
	}
	for id, row := range t.messages {
		view.messages[id] = clone(row)
	}
	for id, value := range t.deleting {
		view.deleting[id] = value
	}
	return view
}

func (t *temporaryState) get(resource, id string) (object, bool) {
	t.mu.Lock()
	defer t.mu.Unlock()
	var row object
	if resource == "topics" {
		row = t.topics[id]
	}
	if resource == "messages" {
		row = t.messages[id]
	}
	if row == nil {
		return nil, false
	}
	return clone(row), true
}

func (t *temporaryState) has(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.topics[id] != nil
}

func (t *temporaryState) isDeleting(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	return t.deleting[id]
}

func (t *temporaryState) put(resource string, row object) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	id := text(row["id"])
	if resource == "topics" && t.topics[id] != nil {
		t.topics[id] = clone(row)
		return true
	}
	if resource == "messages" && t.topics[text(row["topicId"])] != nil {
		t.messages[id] = clone(row)
		return true
	}
	return false
}

func (t *temporaryState) rows(id string) []object {
	t.mu.Lock()
	defer t.mu.Unlock()
	rows := []object{}
	for _, row := range t.messages {
		if row["topicId"] == id {
			rows = append(rows, clone(row))
		}
	}
	sort.Slice(rows, func(i, j int) bool { return text(rows[i]["id"]) < text(rows[j]["id"]) })
	return rows
}

func (t *temporaryState) remove(id string) bool {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.topics[id] == nil {
		return false
	}
	delete(t.topics, id)
	delete(t.deleting, id)
	for key, row := range t.messages {
		if row["topicId"] == id {
			delete(t.messages, key)
		}
	}
	return true
}

func (s *server) temporaryCommand(route string, input object) (any, error) {
	id := text(input["id"])
	if route == "ai.temporary_topic.delete" {
		if len(input) != 1 || id == "" {
			return nil, errors.New("temporary topic id required")
		}
		s.mu.Lock()
		if !s.store.temporary.has(id) {
			s.mu.Unlock()
			return nil, sql.ErrNoRows
		}
		s.store.temporary.mu.Lock()
		s.store.temporary.deleting[id] = true
		s.store.temporary.mu.Unlock()
		g := s.active[id]
		if g != nil {
			g.cancel()
		}
		s.mu.Unlock()
		// The temporary identity is checked before cancellation, so stale cleanup
		// cannot stop an ordinary persistent conversation.
		if g != nil {
			select {
			case <-g.done:
			case <-time.After(10 * time.Second):
				return nil, errors.New("temporary generation cancellation did not drain")
			}
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch route {
	case "ai.temporary_topic.create":
		for key := range input {
			if key != "name" && key != "assistantId" {
				return nil, errors.New("invalid temporary topic input")
			}
		}
		if value, ok := input["assistantId"]; ok {
			if _, valid := value.(string); !valid {
				return nil, errors.New("invalid temporary assistant id")
			}
		}
		if assistant := text(input["assistantId"]); assistant != "" {
			row, err := s.store.get("assistants", assistant)
			if err != nil || row["deletedAt"] != nil {
				return nil, sql.ErrNoRows
			}
		}
		now := timestamp()
		topic := object{"id": newID(), "name": "", "isNameManuallyEdited": false, "orderKey": "", "lastActivityAt": now, "createdAt": now, "updatedAt": now}
		if value, ok := input["name"]; ok {
			name, valid := value.(string)
			if !valid || len(utf16.Encode([]rune(name))) > 255 {
				return nil, errors.New("invalid temporary topic name")
			}
			topic["name"] = name
		}
		if assistant := text(input["assistantId"]); assistant != "" {
			topic["assistantId"] = assistant
		}
		s.store.temporary.mu.Lock()
		s.store.temporary.topics[text(topic["id"])] = clone(topic)
		root := object{"id": newID(), "topicId": topic["id"], "parentId": nil, "role": "root", "data": object{"parts": []any{}}, "searchableText": "", "status": "success", "siblingsGroupId": 0, "createdAt": now, "updatedAt": now}
		s.store.temporary.messages[text(root["id"])] = root
		s.store.temporary.mu.Unlock()
		return topic, nil
	case "ai.temporary_topic.delete":
		if len(input) != 1 || id == "" {
			return nil, errors.New("temporary topic id required")
		}
		if !s.store.temporary.remove(id) {
			return nil, sql.ErrNoRows
		}
		delete(s.projections, id)
		for subscription, topic := range s.projectionSubscriptions {
			if topic == id {
				delete(s.projectionSubscriptions, subscription)
			}
		}
		return nil, nil
	case "ai.temporary_topic.persist":
		if len(input) != 1 || id == "" {
			return nil, errors.New("temporary topic id required")
		}
		err := s.transaction(func(tx *server) error {
			if tx.store.temporary.deleting[id] {
				return errors.New("temporary topic is being discarded")
			}
			topic, ok := tx.store.temporary.get("topics", id)
			if !ok {
				return sql.ErrNoRows
			}
			rows := tx.store.temporary.rows(id)
			path, err := pathTo(rows, text(topic["activeNodeId"]))
			if err != nil {
				return err
			}
			root := rootID(rows)
			if root == "" {
				return errors.New("temporary root missing")
			}
			tx.store.temporary.remove(id)
			active := topic["activeNodeId"]
			delete(topic, "activeNodeId")
			topic["orderKey"] = timestamp()
			if err := tx.store.put("topics", topic); err != nil {
				return err
			}
			for _, row := range rows {
				if row["id"] == root {
					if err := tx.store.put("messages", row); err != nil {
						return err
					}
					break
				}
			}
			for _, row := range path {
				if err := tx.store.put("messages", row); err != nil {
					return err
				}
			}
			if active != nil {
				topic["activeNodeId"] = active
			}
			return tx.store.put("topics", topic)
		})
		if err == nil {
			s.changed("/topics", "/topics/:id", "/topics/:topicId/messages", "/topics/:topicId/tree")
		}
		return nil, err
	default:
		return nil, notMigrated(route)
	}
}
