package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"reflect"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type projectionCapture struct {
	mu sync.Mutex
	bytes.Buffer
}

func (w *projectionCapture) Write(data []byte) (int, error) {
	w.mu.Lock()
	defer w.mu.Unlock()
	return w.Buffer.Write(data)
}

func (w *projectionCapture) events(t *testing.T, subscription string) []object {
	t.Helper()
	w.mu.Lock()
	data := append([]byte{}, w.Buffer.Bytes()...)
	w.mu.Unlock()
	decoder := json.NewDecoder(bytes.NewReader(data))
	result := []object{}
	for decoder.More() {
		frame := object{}
		if err := decoder.Decode(&frame); err != nil {
			t.Fatal(err)
		}
		params := obj(frame["params"])
		args := array(params["args"])
		if params["channel"] == "ipc-api:event" && len(args) == 2 && args[0] == "ai.projection.changed" {
			event := obj(args[1])
			if event["subscriptionId"] == subscription {
				result = append(result, obj(event["update"]))
			}
		}
	}
	return result
}

func projectionCall(t *testing.T, s *server, route, topic, subscription string) object {
	t.Helper()
	value, err, _ := s.invoke("ipc-api:request", []any{route, object{"target": object{"kind": "topic", "topicId": topic}, "subscriptionId": subscription}})
	if err != nil || obj(value)["ok"] != true {
		t.Fatal("projection call failed", route, err, value)
	}
	if obj(value)["data"] == nil {
		return nil
	}
	return obj(obj(value)["data"])
}

// This is the consumer-side contract in shared/ai/messageProjection.ts: revision
// gaps require attach, append patches only address existing text/reasoning parts,
// and order is the complete overlay membership, not an append-only history list.
func applyProjection(t *testing.T, baseline, update object) object {
	t.Helper()
	if replaySequence(update["revision"]) != replaySequence(baseline["revision"])+1 || update["kind"] != baseline["kind"] || update["topicId"] != baseline["topicId"] {
		t.Fatal("projection revision/owner mismatch", baseline, update)
	}
	previous := map[string]object{}
	for _, value := range array(baseline["messages"]) {
		message := obj(value)
		previous[text(message["id"])] = clone(message)
	}
	for _, value := range array(update["patches"]) {
		patch := obj(value)
		switch patch["type"] {
		case "message":
			message := clone(obj(patch["message"]))
			previous[text(message["id"])] = message
		case "append":
			message := previous[text(patch["messageId"])]
			parts := array(message["parts"])
			index := int(replaySequence(patch["part"]))
			if index < 0 || index >= len(parts) {
				t.Fatal("append addressed an absent part", patch)
			}
			part := obj(parts[index])
			if part["type"] != "text" && part["type"] != "reasoning" {
				t.Fatal("append addressed a non-text part", patch)
			}
			part["text"] = text(part["text"]) + text(patch["text"])
		default:
			t.Fatal("unknown projection patch", patch)
		}
	}
	view := clone(update)
	delete(view, "patches")
	delete(view, "order")
	messages := []any{}
	seen := map[string]bool{}
	for _, value := range array(update["order"]) {
		id := text(value)
		if previous[id] == nil || seen[id] {
			t.Fatal("invalid projection order", update)
		}
		seen[id] = true
		messages = append(messages, previous[id])
	}
	view["messages"] = messages
	return view
}

func waitProjection(t *testing.T, capture *projectionCapture, subscription string, baseline object, predicate func(object) bool) object {
	t.Helper()
	deadline := time.Now().Add(3 * time.Second)
	for time.Now().Before(deadline) {
		view := clone(baseline)
		for _, event := range capture.events(t, subscription) {
			if replaySequence(event["revision"]) > replaySequence(view["revision"]) {
				view = applyProjection(t, view, event)
			}
		}
		if predicate(view) {
			return view
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("projection did not reach the expected state")
	return nil
}

func projectedText(view object) string {
	var result strings.Builder
	for _, value := range array(view["messages"]) {
		result.WriteString(partsText(obj(value)["parts"]))
	}
	return result.String()
}

func projectedStatus(view object) string {
	if executions := array(view["executions"]); len(executions) == 1 {
		return text(obj(executions[0])["status"])
	}
	return ""
}

func TestProjectionStreamReconnectDetachAndRegenerate(t *testing.T) {
	var requests atomic.Int32
	next, finish := make(chan struct{}), make(chan struct{})
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		if requests.Add(1) > 1 {
			fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"regenerated\"}}]}\n\ndata: [DONE]\n\n")
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"第一段\",\"reasoning_content\":\"思考\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-next:
		case <-r.Context().Done():
			return
		}
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"追加\"}}]}\n\n")
		w.(http.Flusher).Flush()
		select {
		case <-finish:
			fmt.Fprint(w, "data: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}))
	defer endpoint.Close()
	defer endpoint.CloseClientConnections()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	id := text(topic["id"])
	capture := &projectionCapture{}
	s.writer = &wireWriter{output: capture}
	firstID := newID()
	initial := projectionCall(t, s, "ai.projection.attach", id, firstID)
	if initial["kind"] != "topic" || initial["topicId"] != id || replaySequence(initial["revision"]) != 0 || len(array(initial["messages"])) != 0 {
		t.Fatal("fresh topic projection must be an empty overlay", initial)
	}
	ack, err, after := s.invoke("ipc-api:request", []any{"ai.stream.open", object{"topicId": id, "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "request"}}}})
	if err != nil || obj(ack)["ok"] != true || obj(obj(ack)["data"])["mode"] != "started" {
		t.Fatal("old GenerateAck changed", ack, err)
	}
	s.mu.Lock()
	g := s.active[id]
	s.mu.Unlock()
	after()
	first := waitProjection(t, capture, firstID, initial, func(v object) bool { return projectedText(v) == "第一段" })
	if projectedStatus(first) != "active" || len(array(first["messages"])) != 1 {
		t.Fatal("active projection must contain one assistant overlay", first)
	}
	projectionCall(t, s, "ai.projection.detach", id, firstID)
	oldDeliveryCount := len(capture.events(t, firstID))
	secondID := newID()
	baseline := projectionCall(t, s, "ai.projection.attach", id, secondID)
	if projectedText(baseline) != "第一段" || requests.Load() != 1 {
		t.Fatal("reattach lost text or replayed the model request", baseline, requests.Load())
	}
	// A returned snapshot is immutable even while the live parts keep growing.
	baselineBefore := clone(baseline)
	close(next)
	second := waitProjection(t, capture, secondID, baseline, func(v object) bool { return projectedText(v) == "第一段追加" })
	if !reflect.DeepEqual(baselineBefore, baseline) || len(capture.events(t, firstID)) != oldDeliveryCount {
		t.Fatal("snapshot mutated or detached lease received output")
	}
	foundAppend := false
	for _, event := range capture.events(t, secondID) {
		for _, value := range array(event["patches"]) {
			foundAppend = foundAppend || obj(value)["type"] == "append"
		}
	}
	if !foundAppend {
		t.Fatal("growing text should use a consumer-compatible append patch", second)
	}
	close(finish)
	waitDone(t, g)
	final := waitProjection(t, capture, secondID, baseline, func(v object) bool { return projectedStatus(v) == "done" })
	if projectedText(final) != "第一段追加" || obj(array(final["executions"])[0])["userMessageId"] != g.user["id"] {
		t.Fatal("incorrect final projection", final)
	}
	reattached := projectionCall(t, s, "ai.projection.attach", id, newID())
	if !reflect.DeepEqual(final, reattached) {
		t.Fatal("completed baseline differs from delivered terminal view", final, reattached)
	}
	legacy, _, _ := s.invoke("ipc-api:request", []any{"ai.stream.attach", object{"topicId": id}})
	if obj(obj(legacy)["data"])["status"] != "not-found" {
		t.Fatal("old stream attach compatibility changed", legacy)
	}
	ack, err, after = s.invoke("ipc-api:request", []any{"ai.stream.open", object{"topicId": id, "trigger": "regenerate-message", "parentAnchorId": g.user["id"]}})
	if err != nil || obj(ack)["ok"] != true {
		t.Fatal("regenerate failed", err, ack)
	}
	s.mu.Lock()
	regenerated := s.active[id]
	s.mu.Unlock()
	after()
	waitDone(t, regenerated)
	latest := projectionCall(t, s, "ai.projection.attach", id, newID())
	if projectedStatus(latest) != "done" || projectedText(latest) != "regenerated" || len(array(latest["messages"])) != 1 || obj(array(latest["messages"])[0])["id"] != regenerated.row["id"] || requests.Load() != 2 {
		t.Fatal("new attempt did not replace projection membership", latest)
	}
	saved, err := s.store.get("messages", text(g.row["id"]))
	if err != nil || partsText(obj(saved["data"])["parts"]) != "第一段追加" {
		t.Fatal("projection replacement changed saved branch history", err)
	}
	if path := os.Getenv("EVOSTACK_PROJECTION_CASE_FILE"); path != "" {
		data, err := json.Marshal(object{"cases": []any{
			object{"baseline": initial, "updates": capture.events(t, firstID), "expected": first},
			object{"baseline": baseline, "updates": capture.events(t, secondID), "expected": latest},
		}})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
}

func TestProjectionAbortAndInterruptedStream(t *testing.T) {
	for _, abort := range []bool{true, false} {
		t.Run(fmt.Sprint(abort), func(t *testing.T) {
			var requests atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				w.Header().Set("Content-Type", "text/event-stream")
				fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
				w.(http.Flusher).Flush()
				if abort {
					<-r.Context().Done()
				}
			}))
			defer endpoint.Close()
			defer endpoint.CloseClientConnections()
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			id, subscription := text(topic["id"]), newID()
			capture := &projectionCapture{}
			s.writer = &wireWriter{output: capture}
			baseline := projectionCall(t, s, "ai.projection.attach", id, subscription)
			g := launch(t, s, topic)
			if abort {
				waitProjection(t, capture, subscription, baseline, func(v object) bool { return projectedText(v) == "partial" })
				value, err, _ := s.invoke("ipc-api:request", []any{"ai.stream.abort", object{"topicId": id}})
				if err != nil || obj(value)["ok"] != true {
					t.Fatal("abort failed", err, value)
				}
			}
			waitDone(t, g)
			final := projectionCall(t, s, "ai.projection.attach", id, newID())
			status := "error"
			if abort {
				status = "paused"
			}
			if projectedStatus(final) != status || projectedText(final) != "partial" || requests.Load() != 1 {
				t.Fatal("wrong interrupted terminal state or replay", final, requests.Load())
			}
			parts := array(obj(array(final["messages"])[0])["parts"])
			foundError := false
			for _, value := range parts {
				part := obj(value)
				foundError = foundError || part["type"] == "data-error"
				if (part["type"] == "text" || part["type"] == "reasoning") && part["state"] != "done" {
					t.Fatal("terminal projection left a streaming part", part)
				}
			}
			if foundError == abort {
				t.Fatal("error part should describe failure, not a user pause", final)
			}
			row, err := s.store.get("messages", text(g.row["id"]))
			if err != nil || partsText(obj(row["data"])["parts"]) != "partial" {
				t.Fatal("partial history was not retained", err)
			}
		})
	}
}

func TestProjectionPersistenceFailureIsUnresolved(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"answer\"}}]}\n\ndata: [DONE]\n\n")
	}))
	defer endpoint.Close()
	defer endpoint.CloseClientConnections()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	_, err := s.store.db.Exec(`CREATE TRIGGER fixture_reject_final BEFORE UPDATE ON entity
WHEN NEW.resource='messages' AND json_extract(NEW.body,'$.status') IN ('success','paused','error')
BEGIN SELECT RAISE(FAIL,'fixture final write failure'); END`)
	if err != nil {
		t.Fatal(err)
	}
	g := launch(t, s, topic)
	waitDone(t, g)
	final := projectionCall(t, s, "ai.projection.attach", text(topic["id"]), newID())
	if projectedStatus(final) != "unresolved" || projectedText(final) != "answer" {
		t.Fatal("failed persistence must not advertise done", final)
	}
	message := obj(array(final["messages"])[0])
	parts := array(message["parts"])
	if obj(parts[len(parts)-1])["type"] != "data-error" {
		t.Fatal("unresolved projection lacks its error part", final)
	}
}

func TestProjectionValidationAndSubscriptionBudget(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	id, subscription := text(topic["id"]), newID()
	valid := object{"target": object{"kind": "topic", "topicId": id}, "subscriptionId": subscription}
	for _, input := range []object{
		{}, {"target": valid["target"], "subscriptionId": "invalid"},
		{"target": object{"kind": "topic", "topicId": 1}, "subscriptionId": subscription},
		{"target": object{"kind": "topic", "topicId": id, "extra": true}, "subscriptionId": subscription},
		{"target": object{"kind": "child", "sessionId": "s", "toolCallId": "t"}, "subscriptionId": subscription},
		{"target": valid["target"], "subscriptionId": subscription, "extra": true},
	} {
		value, _, _ := s.invoke("ipc-api:request", []any{"ai.projection.attach", input})
		if obj(value)["ok"] != false {
			t.Fatal("invalid or unsupported projection was accepted", input, value)
		}
	}
	for range maxProjectionSubscriptions {
		projectionCall(t, s, "ai.projection.attach", id, newID())
	}
	value, _, _ := s.invoke("ipc-api:request", []any{"ai.projection.attach", valid})
	if obj(value)["ok"] != false {
		t.Fatal("unbounded projection subscriptions")
	}
	for existing := range s.projectionSubscriptions {
		projectionCall(t, s, "ai.projection.detach", id, existing)
		break
	}
	projectionCall(t, s, "ai.projection.attach", id, subscription)
	projectionCall(t, s, "ai.projection.detach", id, subscription)
	projectionCall(t, s, "ai.projection.detach", id, subscription)
	if _, exists := s.projectionSubscriptions[subscription]; exists {
		t.Fatal("idempotent detach retained the delivery lease")
	}
}

func TestProjectionConcurrentAttachAndAbort(t *testing.T) {
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Content-Type", "text/event-stream")
		fmt.Fprint(w, "data: {\"choices\":[{\"delta\":{\"content\":\"partial\"}}]}\n\n")
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer endpoint.Close()
	defer endpoint.CloseClientConnections()
	s, _ := testServer(t)
	s.writer = &wireWriter{output: io.Discard}
	topic := seedChat(t, s, endpoint.URL)
	g := launch(t, s, topic)
	var workers sync.WaitGroup
	for range 8 {
		workers.Add(1)
		go func() {
			defer workers.Done()
			for range 8 {
				id := newID()
				projectionCall(t, s, "ai.projection.attach", text(topic["id"]), id)
				projectionCall(t, s, "ai.projection.detach", text(topic["id"]), id)
			}
		}()
	}
	workers.Wait()
	if err := s.abort(text(topic["id"])); err != nil {
		t.Fatal(err)
	}
	waitDone(t, g)
	final := projectionCall(t, s, "ai.projection.attach", text(topic["id"]), newID())
	if projectedStatus(final) != "paused" {
		t.Fatal("concurrent attach/detach changed cancellation", final)
	}
}

func TestProjectionOverflowStopsOwnedTurnWithoutTruncatingParts(t *testing.T) {
	s, _ := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	s.mu.Lock()
	_, err, _ := s.openGeneration(object{"topicId": topic["id"], "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "request"}}})
	if err != nil {
		s.mu.Unlock()
		t.Fatal(err)
	}
	g := s.active[text(topic["id"])]
	// No HTTP/model request runs in this budget fault injection. A body larger
	// than one IPC frame must never silently disappear from the live projection.
	g.parts = []any{object{"type": "text", "text": strings.Repeat("x", maxFrame), "state": "streaming"}}
	s.updateProjection(g, "active", nil, true)
	p := s.projections[g.topicID]
	view := clone(p.view)
	projectionErr := g.projectionErr
	retained := len(text(obj(g.parts[0])["text"]))
	delete(s.active, g.topicID)
	s.unregisterGenerationCancel(g.topicID)
	close(g.done)
	s.mu.Unlock()
	if projectionErr == nil || projectedStatus(view) != "unresolved" || retained != maxFrame {
		t.Fatal("projection budget claimed success or truncated saved parts", projectionErr, view, retained)
	}
	if size, err := wireEncodedSize(view); err != nil || size >= maxFrame {
		t.Fatal("budget error itself does not fit IPC", size, err)
	}
}
