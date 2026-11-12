package main

import (
	"context"
	"errors"
	"reflect"
	"strings"
	"sync"
	"testing"
)

type computerHostFunc func(context.Context, object) (object, error)

func (f computerHostFunc) Call(ctx context.Context, params object) (object, error) {
	return f(ctx, params)
}

func TestComputerTaskGrantIsOnlyForTheAcceptedOpenAttempt(t *testing.T) {
	s, _ := testServer(t)
	owner, task := newID(), newID()
	g := &generation{topicID: owner, computerTaskID: task, computerEnabled: true, attempt: 1, row: object{"id": newID()}}
	s.active[owner] = g
	defer delete(s.active, owner)
	args := []any{"ai.stream.open", object{"topicId": owner}}
	ack := object{"mode": "started", "activeExecutions": []object{g.execution()}}
	result := ipcResult(ack, nil)
	if got := s.computerTaskGrant("ipc-api:request", args, result); got != task {
		t.Fatal("accepted open did not identify its task", got)
	}
	if got := s.computerTaskGrant("ipc-api:request", args, ipcResult(nil, errors.New("TOPIC_BUSY"))); got != "" {
		t.Fatal("rejected open granted the existing task", got)
	}
	g.attempt++
	if got := s.computerTaskGrant("ipc-api:request", args, result); got != "" {
		t.Fatal("old acknowledgement granted a newer attempt", got)
	}
	g.attempt--
	g.computerEnabled = false
	if got := s.computerTaskGrant("ipc-api:request", args, result); got != "" {
		t.Fatal("text-only turn granted desktop control", got)
	}
}

func TestComputerPreferenceRevocationCancelsTurnsWithoutHoldingTheStoreLock(t *testing.T) {
	s, _ := testServer(t)
	var lock sync.Mutex
	calls := []object{}
	stopping, finishStop := make(chan struct{}), make(chan struct{})
	s.computerHost = computerHostFunc(func(ctx context.Context, params object) (object, error) {
		lock.Lock()
		calls = append(calls, params)
		lock.Unlock()
		if params["operation"] == "configure" && params["enabled"] == false {
			// This would deadlock if PreferenceService held the store lock during native cleanup.
			if enabled, err := s.computerEnabled(); err != nil || enabled {
				t.Error("revoked preference not visible during native cleanup", err)
			}
			close(stopping)
			<-finishStop
		}
		return object{"cleanup": "complete"}, nil
	})
	if _, err, _ := s.invoke("preference:set", []any{computerPreference, true}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	g := &generation{computerEnabled: true, cancel: cancel, done: make(chan struct{})}
	s.active["controlled"] = g
	defer func() { delete(s.active, "controlled"); close(g.done) }()
	if _, err := s.computerTool(context.Background(), "owner", "task", "Test", "mcp__computer__list_apps", object{}); err != nil {
		t.Fatal(err)
	}
	finished := make(chan error, 1)
	go func() {
		_, err, _ := s.invoke("preference:set", []any{computerPreference, false})
		finished <- err
	}()
	<-stopping
	if !errors.Is(ctx.Err(), context.Canceled) {
		t.Fatal("turn retained desktop authority after switch off")
	}
	if value, err, _ := s.invoke("preference:get", []any{computerPreference}); err != nil || value != false {
		t.Fatal("ordinary requests blocked or preference stayed enabled", err)
	}
	if _, err := s.computerTool(context.Background(), "owner", "task", "Test", "click", object{}); err == nil {
		t.Fatal("desktop action accepted after revocation")
	}
	close(finishStop)
	if err := <-finished; err != nil {
		t.Fatal(err)
	}
	lock.Lock()
	defer lock.Unlock()
	firstEpoch := calls[0]["epoch"].(uint64)
	lastEpoch := calls[len(calls)-1]["epoch"].(uint64)
	if lastEpoch <= firstEpoch || calls[len(calls)-1]["enabled"] != false {
		t.Fatal("revocation did not supersede stale grants", calls)
	}
}

func TestComputerPreferenceValidationIsAtomicAndFailedCleanupStaysDisabled(t *testing.T) {
	s, _ := testServer(t)
	calls := 0
	s.computerHost = computerHostFunc(func(ctx context.Context, params object) (object, error) {
		calls++
		if params["enabled"] == false {
			return nil, &computerControlError{Code: "CLEANUP_UNCONFIRMED", Effect: "possible"}
		}
		return object{}, nil
	})
	for _, args := range []struct {
		channel string
		args    []any
	}{
		{"preference:set", []any{computerPreference, "true"}},
		{"preference:set-multiple", []any{object{computerPreference: true, "unknown-preference": true}}},
	} {
		if _, err, _ := s.invoke(args.channel, args.args); err == nil {
			t.Fatal("invalid control preference accepted")
		}
	}
	if enabled, err := s.computerEnabled(); err != nil || enabled || calls != 0 {
		t.Fatal("failed preference transaction granted native authority", err, calls)
	}
	if _, err, _ := s.invoke("preference:set", []any{computerPreference, true}); err != nil {
		t.Fatal(err)
	}
	if _, err, _ := s.invoke("preference:set", []any{computerPreference, false}); err == nil {
		t.Fatal("unconfirmed native cleanup was hidden")
	}
	if enabled, err := s.computerEnabled(); err != nil || enabled {
		t.Fatal("cleanup failure restored the revoked permission", err)
	}
}

func TestInterruptedComputerHistoryPreservesContentAndDoesNotResumeAnAction(t *testing.T) {
	s, directory := testServer(t)
	topic := seedChat(t, s, "http://127.0.0.1:1")
	parts := []any{
		object{"type": "text", "text": "Already saved partial answer", "state": "streaming"},
		object{"type": "dynamic-tool", "toolName": "mcp__computer__click", "toolCallId": "interrupted-click", "state": "input-available", "input": object{"appSessionId": "old-session", "snapshotId": "old-snapshot", "elementId": "42"}},
		object{"type": "data-legacy", "data": object{"preserve": true}},
	}
	message := obj(dataOK(t, s, "POST", "/topics/"+text(topic["id"])+"/messages", object{"role": "assistant", "modelId": "test::local", "data": object{"parts": parts}}))
	message["legacyField"] = "preserve"
	if err := s.store.put("messages", message); err != nil {
		t.Fatal(err)
	}
	// Old profiles may have deleted models; recovery must not revalidate their references.
	if err := s.store.delete("models", "test::local"); err != nil {
		t.Fatal(err)
	}
	s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	saved, err := reopened.get("messages", text(message["id"]))
	if err != nil || saved["status"] != "error" || saved["legacyField"] != "preserve" {
		t.Fatal("interrupted message was not safely recovered", err)
	}
	recovered := array(obj(saved["data"])["parts"])
	if obj(recovered[0])["state"] != "done" || obj(recovered[0])["text"] != "Already saved partial answer" || !reflect.DeepEqual(recovered[2], parts[2]) {
		t.Fatal("recovery lost saved or unknown message content", recovered)
	}
	tool := obj(recovered[1])
	if tool["state"] != "output-error" || !strings.Contains(text(tool["errorText"]), "unconfirmed") || !reflect.DeepEqual(tool["input"], obj(parts[1])["input"]) {
		t.Fatal("interrupted action was treated as pending or successful", tool)
	}
	if model := saved["modelId"]; model != "test::local" {
		t.Fatal("recovery changed historical references", model)
	}
}
