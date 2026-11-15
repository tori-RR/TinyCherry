package main

import (
	"errors"
	"reflect"
	"strings"
	"time"

	"github.com/google/uuid"
)

const projectionBatchDelay = 80 * time.Millisecond
const maxProjectionSubscriptions = 128
const maxUnobservedProjections = 64

// The projection is a live assistant-message overlay, not another copy of saved
// topic history. All fields and timers are owned by serverState.mu.
type topicProjection struct {
	view     object
	pending  *generation
	status   string
	issue    error
	timer    *time.Timer
	batch    uint64
	lastUsed uint64
}

func projectionRequest(input object) (string, string, error) {
	if len(input) != 2 {
		return "", "", errors.New("projection requires target and subscriptionId")
	}
	subscription, ok := input["subscriptionId"].(string)
	id, err := uuid.Parse(subscription)
	if !ok || err != nil || len(subscription) != 36 || !strings.EqualFold(id.String(), subscription) ||
		(id != uuid.Nil && !strings.EqualFold(subscription, "ffffffff-ffff-ffff-ffff-ffffffffffff") &&
			(id.Version() < 1 || id.Version() > 8 || id.Variant() != uuid.RFC4122)) {
		return "", "", errors.New("projection subscriptionId must be a UUID")
	}
	target := obj(input["target"])
	if target["kind"] == "child" {
		return "", "", notMigrated("child message projection")
	}
	topic, ok := target["topicId"].(string)
	if len(target) != 2 || target["kind"] != "topic" || !ok || topic == "" {
		return "", "", errors.New("invalid topic projection target")
	}
	return topic, subscription, nil
}

func (s *server) projectionCommand(route string, input object) (any, error) {
	topicID, subscription, err := projectionRequest(input)
	if err != nil {
		return nil, err
	}
	if route == "ai.projection.detach" {
		if s.projectionSubscriptions[subscription] == topicID {
			delete(s.projectionSubscriptions, subscription)
		}
		s.pruneProjections()
		return nil, nil
	}
	if _, err := s.store.get("topics", topicID); err != nil {
		return nil, err
	}
	if _, exists := s.projectionSubscriptions[subscription]; !exists && len(s.projectionSubscriptions) >= maxProjectionSubscriptions {
		return nil, errors.New("too many projection subscriptions")
	}
	p := s.topicProjection(topicID)
	// Flush before registering this delivery lease: the returned baseline already
	// contains those updates. Other leases still receive their next revision.
	s.flushProjection(p)
	s.projectionSubscriptions[subscription] = topicID
	s.pruneProjections()
	return clone(p.view), nil
}

func (s *server) topicProjection(topicID string) *topicProjection {
	if s.projections == nil {
		s.projections = map[string]*topicProjection{}
	}
	if s.projectionSubscriptions == nil {
		s.projectionSubscriptions = map[string]string{}
	}
	p := s.projections[topicID]
	if p == nil {
		p = &topicProjection{view: object{"kind": "topic", "topicId": topicID, "revision": int64(0), "messages": []any{}, "executions": []any{}}}
		s.projections[topicID] = p
	}
	s.projectionClock++
	p.lastUsed = s.projectionClock
	return p
}

func (s *server) pruneProjections() {
	for len(s.projections) > maxUnobservedProjections {
		var oldest string
		var used uint64
		for topicID, p := range s.projections {
			if s.active[topicID] != nil || p.pending != nil {
				continue
			}
			observed := false
			for _, topic := range s.projectionSubscriptions {
				observed = observed || topic == topicID
			}
			if !observed && (oldest == "" || p.lastUsed < used) {
				oldest, used = topicID, p.lastUsed
			}
		}
		if oldest == "" {
			return
		}
		delete(s.projections, oldest)
	}
}

func (s *server) updateProjection(g *generation, status string, issue error, immediate bool) {
	p := s.topicProjection(g.topicID)
	p.pending, p.status, p.issue = g, status, issue
	if immediate {
		s.flushProjection(p)
		s.pruneProjections()
		return
	}
	if p.timer == nil {
		p.batch++
		batch := p.batch
		p.timer = time.AfterFunc(projectionBatchDelay, func() {
			s.mu.Lock()
			defer s.mu.Unlock()
			if p.batch == batch && s.projections[g.topicID] == p {
				s.flushProjection(p)
			}
		})
	}
}

func projectionMessage(g *generation, status string, issue error) object {
	row := copyReplayObject(g.row)
	row["data"] = object{"parts": g.parts}
	switch status {
	case "active":
		row["status"] = "pending"
	case "done":
		row["status"] = "success"
	case "paused":
		row["status"] = "paused"
	default:
		row["status"] = "error"
	}
	message := clone(toUIMessage(row))
	if issue != nil && (status == "error" || status == "unresolved") {
		message["parts"] = appendGenerationError(array(message["parts"]), issue)
	}
	return message
}

func projectionPatches(previous, next []any) []any {
	byID := map[string]object{}
	for _, value := range previous {
		message := obj(value)
		byID[text(message["id"])] = message
	}
	patches := []any{}
	for _, value := range next {
		message := obj(value)
		before := byID[text(message["id"])]
		if reflect.DeepEqual(before, message) {
			continue
		}
		parts, oldParts := array(message["parts"]), array(before["parts"])
		appendOnly := before != nil && before["role"] == message["role"] && len(parts) == len(oldParts) && reflect.DeepEqual(before["metadata"], message["metadata"])
		appended := []any{}
		if appendOnly {
			for index, value := range parts {
				part, old := obj(value), obj(oldParts[index])
				if reflect.DeepEqual(part, old) {
					continue
				}
				oldText, oldOK := old["text"].(string)
				newText, newOK := part["text"].(string)
				oldFields, newFields := copyReplayObject(old), copyReplayObject(part)
				oldFields["text"], newFields["text"] = "", ""
				if (part["type"] != "text" && part["type"] != "reasoning") || !oldOK || !newOK || !strings.HasPrefix(newText, oldText) || !reflect.DeepEqual(oldFields, newFields) {
					appendOnly = false
					break
				}
				appended = append(appended, object{"type": "append", "messageId": message["id"], "part": index, "text": newText[len(oldText):]})
			}
		}
		if appendOnly {
			patches = append(patches, appended...)
		} else {
			patches = append(patches, object{"type": "message", "message": message})
		}
	}
	return patches
}

func (s *server) flushProjection(p *topicProjection) {
	if p.timer != nil {
		p.timer.Stop()
		p.timer = nil
		p.batch++
	}
	g := p.pending
	if g == nil {
		return
	}
	p.pending = nil
	status, issue := p.status, p.issue
	message := projectionMessage(g, status, issue)
	execution := clone(g.execution())
	execution["status"], execution["messageId"] = status, g.row["id"]
	if status != "active" {
		execution["userMessageId"] = g.user["id"]
	}
	next := object{"kind": "topic", "topicId": g.topicID, "revision": p.view["revision"], "messages": []any{message}, "executions": []any{execution}}
	// A projection must fit both an attach reply and a single event. On overflow,
	// stop this owned turn and expose an unresolved error rather than losing an
	// event and advertising a successful result. Saved parts are never truncated.
	if size, err := wireEncodedSize(next); err != nil || size > maxFrame-65536 {
		g.projectionErr = errors.New("live answer exceeds the desktop projection budget; partial history is retained")
		g.cancel()
		execution["status"] = "unresolved"
		execution["userMessageId"] = g.user["id"]
		message = object{"id": g.row["id"], "role": "assistant", "parts": []any{object{"type": "data-error", "data": object{"name": "Error", "message": g.projectionErr.Error()}}}, "metadata": object{"status": "error", "parentId": g.row["parentId"]}}
		next["messages"] = []any{message}
	}
	if reflect.DeepEqual(p.view, next) {
		return
	}
	next["revision"] = replaySequence(p.view["revision"]) + 1
	patches := projectionPatches(array(p.view["messages"]), array(next["messages"]))
	order := []any{}
	for _, value := range array(next["messages"]) {
		order = append(order, obj(value)["id"])
	}
	p.view = clone(next)
	update := object{"kind": "topic", "topicId": g.topicID, "revision": next["revision"], "executions": next["executions"], "patches": patches, "order": order}
	for subscription, topicID := range s.projectionSubscriptions {
		if topicID == g.topicID {
			s.event("ai.projection.changed", object{"subscriptionId": subscription, "update": update})
		}
	}
}
