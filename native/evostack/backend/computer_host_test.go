package main

import (
	"bufio"
	"context"
	"encoding/json"
	"errors"
	"io"
	"strings"
	"sync"
	"testing"
	"time"
)

type computerWriterFunc func([]byte) (int, error)

func (f computerWriterFunc) Write(data []byte) (int, error) { return f(data) }

func bridgeFixture(t *testing.T) (*computerBridge, <-chan object) {
	t.Helper()
	reader, writer := io.Pipe()
	bridge := newComputerBridge(&wireWriter{output: writer})
	frames := make(chan object, 16)
	go func() {
		defer close(frames)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), maxFrame)
		for scanner.Scan() {
			var frame object
			if json.Unmarshal(scanner.Bytes(), &frame) == nil {
				frames <- frame
			}
		}
	}()
	t.Cleanup(func() { bridge.close(); reader.Close(); writer.Close() })
	return bridge, frames
}

func nextComputerFrame(t *testing.T, frames <-chan object) object {
	t.Helper()
	select {
	case frame := <-frames:
		if frame == nil {
			t.Fatal("desktop request stream closed")
		}
		return frame
	case <-time.After(time.Second):
		t.Fatal("desktop request did not arrive")
		return nil
	}
}

func computerResponse(t *testing.T, bridge *computerBridge, id any, result object) {
	t.Helper()
	encoded, err := json.Marshal(object{"jsonrpc": "2.0", "id": id, "result": result})
	if err != nil || !bridge.receive(encoded) {
		t.Fatal("desktop response was not consumed", err)
	}
}

func TestComputerBridgeCorrelatesRepliesWithoutTreatingThemAsInvocations(t *testing.T) {
	bridge, frames := bridgeFixture(t)
	results := make(chan object, 2)
	for _, task := range []string{"one", "two"} {
		go func(task string) {
			data, err := bridge.Call(context.Background(), object{"operation": "invoke", "taskId": task})
			results <- object{"data": data, "error": err}
		}(task)
	}
	first, second := nextComputerFrame(t, frames), nextComputerFrame(t, frames)
	for _, frame := range []object{second, first} {
		if frame["method"] != "host.computer" || !strings.HasPrefix(text(frame["id"]), "host:") {
			t.Fatal("unexpected reverse request", frame)
		}
		computerResponse(t, bridge, frame["id"], object{"ok": true, "data": object{"task": obj(frame["params"])["taskId"]}})
	}
	seen := map[string]bool{}
	for range 2 {
		result := <-results
		if result["error"] != nil {
			t.Fatal(result["error"])
		}
		seen[text(obj(result["data"])["task"])] = true
	}
	if !seen["one"] || !seen["two"] {
		t.Fatal("crossed desktop replies", seen)
	}
	computerResponse(t, bridge, first["id"], object{"ok": true, "data": object{}})
	if bridge.receive([]byte(`{"jsonrpc":"2.0","id":1,"method":"backend.info"}`)) {
		t.Fatal("ordinary host request was consumed as a desktop reply")
	}
}

func TestComputerBridgeCancelDoesNotReplayAndIgnoresLateResults(t *testing.T) {
	bridge, frames := bridgeFixture(t)
	ctx, cancel := context.WithCancel(context.Background())
	result := make(chan error, 1)
	go func() {
		_, err := bridge.Call(ctx, object{"operation": "invoke", "taskId": "owned-task", "tool": "click"})
		result <- err
	}()
	request := nextComputerFrame(t, frames)
	cancel()
	notification := nextComputerFrame(t, frames)
	if notification["method"] != "host.computer.cancel" || obj(notification["params"])["requestId"] != request["id"] || obj(notification["params"])["taskId"] != "owned-task" {
		t.Fatal("cancellation did not identify the owned request", notification)
	}
	if err := <-result; !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	computerResponse(t, bridge, request["id"], object{"ok": true, "data": object{"status": "completed"}})
	bridge.mu.Lock()
	remaining := len(bridge.pending)
	bridge.mu.Unlock()
	if remaining != 0 || len(frames) != 0 {
		t.Fatal("cancelled action was retained or replayed")
	}
}

func TestComputerBridgePreservesUncertainEffectsAndStopsOnHostExit(t *testing.T) {
	bridge, frames := bridgeFixture(t)
	result := make(chan error, 1)
	go func() {
		_, err := bridge.Call(context.Background(), object{"operation": "invoke", "taskId": "owned-task"})
		result <- err
	}()
	request := nextComputerFrame(t, frames)
	computerResponse(t, bridge, request["id"], object{"ok": false, "error": object{"code": "ACTION_UNCONFIRMED", "effect": "possible", "message": "Inspect before continuing"}})
	var control *computerControlError
	if err := <-result; !errors.As(err, &control) || control.Effect != "possible" || !terminalComputerError(err) {
		t.Fatal("uncertain effect was lost", err)
	}
	go func() {
		_, err := bridge.Call(context.Background(), object{"operation": "invoke", "taskId": "second"})
		result <- err
	}()
	nextComputerFrame(t, frames)
	bridge.close()
	if err := <-result; !errors.Is(err, io.ErrClosedPipe) {
		t.Fatal(err)
	}
	if _, err := bridge.Call(context.Background(), object{}); err == nil {
		t.Fatal("closed desktop host accepted a new request")
	}
}

func TestComputerBridgeRejectsOversizedInputBeforeSending(t *testing.T) {
	bridge, frames := bridgeFixture(t)
	_, err := bridge.Call(context.Background(), object{"input": strings.Repeat("x", maxFrame)})
	var control *computerControlError
	if !errors.As(err, &control) || control.Effect != "none" || len(frames) != 0 {
		t.Fatal("oversized desktop input reached the host", err)
	}
}

func TestComputerBridgeDrainsRepliesWhileAnotherPipeWriteIsBlocked(t *testing.T) {
	writes := make(chan object, 2)
	release := make(chan struct{})
	var once sync.Once
	unblock := func() { once.Do(func() { close(release) }) }
	t.Cleanup(unblock)
	count := 0 // wireWriter serializes Write calls.
	bridge := newComputerBridge(&wireWriter{output: computerWriterFunc(func(data []byte) (int, error) {
		var frame object
		if err := json.Unmarshal(data, &frame); err != nil {
			return 0, err
		}
		count++
		writes <- frame
		if count == 2 {
			<-release
		}
		return len(data), nil
	})})
	t.Cleanup(func() { unblock(); bridge.close() })
	results := make(chan error, 2)
	go func() { _, err := bridge.Call(context.Background(), object{"taskId": "first"}); results <- err }()
	first := nextComputerFrame(t, writes)
	go func() { _, err := bridge.Call(context.Background(), object{"taskId": "second"}); results <- err }()
	second := nextComputerFrame(t, writes)
	responseDone := make(chan struct{})
	go func() {
		computerResponse(t, bridge, first["id"], object{"ok": true, "data": object{"status": "completed"}})
		close(responseDone)
	}()
	select {
	case <-responseDone:
	case <-time.After(time.Second):
		t.Fatal("an unrelated blocked pipe write stranded the completed desktop reply")
	}
	if err := <-results; err != nil {
		t.Fatal(err)
	}
	unblock()
	computerResponse(t, bridge, second["id"], object{"ok": true, "data": object{}})
	if err := <-results; err != nil {
		t.Fatal(err)
	}
}
