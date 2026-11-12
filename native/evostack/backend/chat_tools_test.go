package main

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"sync/atomic"
	"testing"
	"time"
)

type chatComputerHost struct {
	mu     sync.Mutex
	calls  []object
	closed int
	invoke func(context.Context, string, object) (object, error)
}

func (h *chatComputerHost) Call(ctx context.Context, params object) (object, error) {
	switch params["operation"] {
	case "configure":
		return object{}, nil
	case "close_task":
		h.mu.Lock()
		h.closed++
		h.mu.Unlock()
		return object{}, nil
	case "invoke":
		h.mu.Lock()
		h.calls = append(h.calls, params)
		h.mu.Unlock()
		if h.invoke != nil {
			return h.invoke(ctx, text(params["tool"]), obj(params["input"]))
		}
		return object{"status": "completed"}, nil
	default:
		return nil, fmt.Errorf("unexpected host operation %v", params["operation"])
	}
}
func (h *chatComputerHost) count() int { h.mu.Lock(); defer h.mu.Unlock(); return len(h.calls) }
func enableChatComputer(t *testing.T, s *server, host *chatComputerHost) {
	t.Helper()
	s.computerHost = host
	if err := s.store.setPreference(computerPreference, true); err != nil {
		t.Fatal(err)
	}
}
func writeChatTool(w http.ResponseWriter, id, name, arguments string, done bool) {
	w.Header().Set("Content-Type", "text/event-stream")
	for _, frame := range []object{
		{"choices": []object{{"delta": object{"tool_calls": []object{{"index": 0, "id": id, "type": "function", "function": object{"name": name[:6], "arguments": arguments[:1]}}}}}}},
		{"choices": []object{{"delta": object{"tool_calls": []object{{"index": 0, "function": object{"name": name[6:], "arguments": arguments[1:]}}}}, "finish_reason": "tool_calls"}}},
	} {
		data, _ := json.Marshal(frame)
		fmt.Fprintf(w, "data: %s\n\n", data)
	}
	if done {
		fmt.Fprint(w, "data: [DONE]\n\n")
	}
}
func writeChatText(w http.ResponseWriter, value string) {
	w.Header().Set("Content-Type", "text/event-stream")
	data, _ := json.Marshal(object{"choices": []object{{"delta": object{"content": value}, "finish_reason": "stop"}}})
	fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", data)
}

func TestComputerChatCompletesBoundedToolRoundsAndPersistsOriginalParts(t *testing.T) {
	image := base64.StdEncoding.EncodeToString([]byte("synthetic image fixture"))
	var requests atomic.Int32
	var mu sync.Mutex
	payloads := []object{}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body object
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		mu.Lock()
		payloads = append(payloads, body)
		mu.Unlock()
		switch requests.Add(1) {
		case 1:
			if len(array(body["tools"])) != 9 || body["parallel_tool_calls"] != false {
				t.Error("original desktop tools not provided sequentially")
			}
			for _, tool := range array(body["tools"]) {
				if obj(obj(tool)["function"])["name"] == "mcp__computer__press_key" {
					t.Error("unreliable background key input was advertised")
				}
			}
			writeChatTool(w, "call-observe", "mcp__computer__get_app_state", `{"appSessionId":"owned-session"}`, true)
		case 2:
			writeChatTool(w, "call-type", "mcp__computer__type_text", `{"appSessionId":"owned-session","snapshotId":"snapshot-1","text":"hello 🍒"}`, true)
		default:
			writeChatText(w, "已完成并核对。")
		}
	}))
	defer endpoint.Close()
	host := &chatComputerHost{invoke: func(ctx context.Context, name string, input object) (object, error) {
		snapshot := object{"id": "snapshot-1", "snapshotId": "snapshot-1", "appSessionId": "owned-session", "tree": object{"status": "available", "text": "Editable field"}, "screenshot": object{"status": "available", "image": object{"mimeType": "image/png", "width": 320, "height": 200, "dataBase64": image}}}
		if name == "get_app_state" {
			return snapshot, nil
		}
		if name != "type_text" || input["snapshotId"] != "snapshot-1" || input["text"] != "hello 🍒" {
			t.Error("wrong original tool arguments")
		}
		snapshot["id"] = "snapshot-2"
		snapshot["snapshotId"] = "snapshot-2"
		return object{"status": "completed", "observation": object{"status": "available", "snapshot": snapshot}}, nil
	}}
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	model, _ := s.store.get("models", "test::local")
	model["inputModalities"] = []any{"text", "image"}
	if err := s.store.put("models", model); err != nil {
		t.Fatal(err)
	}
	enableChatComputer(t, s, host)
	g := launch(t, s, topic)
	waitDone(t, g)
	row, err := s.store.get("messages", text(g.row["id"]))
	if err != nil {
		t.Fatal(err)
	}
	if requests.Load() != 3 || host.count() != 2 || row["status"] != "success" {
		t.Fatalf("missing tool loop: requests=%d actions=%d row=%v", requests.Load(), host.count(), row["status"])
	}
	parts := []any{}
	for _, value := range array(obj(row["data"])["parts"]) {
		if obj(value)["type"] != "step-start" {
			parts = append(parts, value)
		}
	}
	if len(parts) != 3 || obj(parts[0])["type"] != "dynamic-tool" || obj(parts[2])["text"] != "已完成并核对。" {
		t.Fatalf("wrong ordered original UI parts %#v", parts)
	}
	if obj(parts[0])["state"] != "output-available" || obj(obj(obj(parts[0])["callProviderMetadata"])["cherry"])["tool"] == nil {
		t.Fatal("tool card identity was lost")
	}
	encoded, _ := json.Marshal(row)
	frames, _ := json.Marshal(g.frames)
	if strings.Contains(string(encoded), image) || strings.Contains(string(frames), image) {
		t.Fatal("private screenshot leaked into database or replay")
	}
	mu.Lock()
	defer mu.Unlock()
	for _, payload := range payloads[1:] {
		imageCount := 0
		toolResults := 0
		for _, value := range array(payload["messages"]) {
			message := obj(value)
			if message["role"] == "tool" {
				toolResults++
			}
			for _, v := range array(message["content"]) {
				if obj(v)["type"] == "image_url" {
					imageCount++
				}
			}
		}
		if imageCount != 1 || toolResults == 0 {
			t.Fatal("tool result or latest-only model screenshot missing")
		}
	}
	if host.closed != 1 {
		t.Fatal("native task was not closed")
	}
	history := computerHistoryMessages(row)
	if len(history) != 5 || history[0]["role"] != "assistant" || history[1]["role"] != "tool" || history[4]["content"] != "已完成并核对。" {
		t.Fatalf("paired tool history lost %#v", history)
	}
	kinds := map[string]int{}
	for _, frame := range g.frames {
		kinds[text(obj(frame["chunk"])["type"])]++
	}
	if kinds["tool-input-available"] != 2 || kinds["tool-output-available"] != 2 || kinds["finish"] != 1 || kinds["start-step"] != 3 {
		t.Fatalf("wrong SDK stream contract %#v", kinds)
	}
}

func TestComputerChatNeverActsOnIncompleteOrInvalidProviderCalls(t *testing.T) {
	cases := []struct {
		name, tool, args string
		done             bool
	}{
		{"missing completion", "mcp__computer__click", `{"appSessionId":"s","snapshotId":"p","elementId":"1"}`, false},
		{"unknown tool", "mcp__computer__launch_app", `{}`, true},
		{"unsupported background key", "mcp__computer__press_key", `{"appSessionId":"s","snapshotId":"p","key":"Return"}`, true},
		{"malformed arguments", "mcp__computer__click", `{"appSessionId":`, true},
		{"missing snapshot", "mcp__computer__click", `{"appSessionId":"s","elementId":"1"}`, true},
		{"global input injection", "mcp__computer__click", `{"appSessionId":"s","snapshotId":"p","elementId":"1","allowGlobalInput":true}`, true},
		{"ambiguous click", "mcp__computer__click", `{"appSessionId":"s","snapshotId":"p","elementId":"1","x":1,"y":2}`, true},
	}
	for _, tt := range cases {
		t.Run(tt.name, func(t *testing.T) {
			var requests atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				writeChatTool(w, "call-1", tt.tool, tt.args, tt.done)
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			host := &chatComputerHost{}
			enableChatComputer(t, s, host)
			g := launch(t, s, topic)
			waitDone(t, g)
			row, _ := s.store.get("messages", text(g.row["id"]))
			if row["status"] != "error" || host.count() != 0 || requests.Load() != 1 {
				t.Fatalf("invalid calls executed/retried: %v %d %d", row["status"], host.count(), requests.Load())
			}
		})
	}
}

func TestComputerChatRequiresCompletionBeforeInvoking(t *testing.T) {
	proposal := make(chan struct{})
	complete := make(chan struct{})
	var requests atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if requests.Add(1) > 1 {
			writeChatText(w, "done")
			return
		}
		writeChatTool(w, "call-1", "mcp__computer__list_apps", `{}`, false)
		w.(http.Flusher).Flush()
		close(proposal)
		select {
		case <-complete:
			fmt.Fprint(w, "data: [DONE]\n\n")
		case <-r.Context().Done():
		}
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	host := &chatComputerHost{}
	enableChatComputer(t, s, host)
	g := launch(t, s, topic)
	<-proposal
	if host.count() != 0 {
		t.Fatal("desktop action ran on an uncommitted model stream")
	}
	close(complete)
	waitDone(t, g)
	if host.count() != 1 {
		t.Fatal("completed proposal not executed once")
	}
}

func TestComputerChatDoesNotRepeatAmbiguousActionOrCallID(t *testing.T) {
	for _, possible := range []bool{false, true} {
		t.Run(fmt.Sprint(possible), func(t *testing.T) {
			var requests atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				writeChatTool(w, "same-call", "mcp__computer__list_apps", `{}`, true)
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			host := &chatComputerHost{}
			if possible {
				host.invoke = func(context.Context, string, object) (object, error) {
					return nil, &computerControlError{Code: "TIMEOUT", Effect: "possible", Message: "The action outcome is unconfirmed; do not replay"}
				}
			}
			enableChatComputer(t, s, host)
			g := launch(t, s, topic)
			waitDone(t, g)
			row, _ := s.store.get("messages", text(g.row["id"]))
			expected := int32(2)
			if possible {
				expected = 1
			}
			if host.count() != 1 || requests.Load() != expected || row["status"] != "error" {
				t.Fatal("ambiguous action or duplicate call was replayed")
			}
		})
	}
}

func TestComputerChatDisableAndAbortCancelPendingActions(t *testing.T) {
	for _, disable := range []bool{true, false} {
		t.Run(fmt.Sprint(disable), func(t *testing.T) {
			entered := make(chan struct{})
			canceled := make(chan struct{})
			host := &chatComputerHost{invoke: func(ctx context.Context, _ string, _ object) (object, error) {
				close(entered)
				<-ctx.Done()
				close(canceled)
				return nil, ctx.Err()
			}}
			var requests atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests.Add(1)
				writeChatTool(w, "call-wait", "mcp__computer__list_apps", `{}`, true)
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			enableChatComputer(t, s, host)
			g := launch(t, s, topic)
			select {
			case <-entered:
			case <-time.After(time.Second * 5):
				t.Fatal("tool did not start")
			}
			if disable {
				if _, err, _ := s.setPreferences("preference:set", []any{computerPreference, false}); err != nil {
					t.Fatal(err)
				}
			} else {
				if err := s.abort(text(topic["id"])); err != nil {
					t.Fatal(err)
				}
			}
			waitDone(t, g)
			select {
			case <-canceled:
			default:
				t.Fatal("native action not canceled")
			}
			row, _ := s.store.get("messages", text(g.row["id"]))
			if row["status"] != "paused" || requests.Load() != 1 || host.count() != 1 {
				t.Fatal("canceled turn resumed")
			}
			part := object{}
			for _, value := range array(obj(row["data"])["parts"]) {
				if obj(value)["type"] == "dynamic-tool" {
					part = obj(value)
					break
				}
			}
			if part["state"] != "output-error" {
				t.Fatal("canceled tool incorrectly looks pending/successful")
			}
		})
	}
}

func TestComputerHistoryMarksInterruptedToolsAndTextOnlyObservations(t *testing.T) {
	if !computerModelImages(object{"inputModalities": []any{"text"}, "capabilities": []any{"function-call", "image-recognition"}}) {
		t.Fatal("explicit vision override on default text model was ignored")
	}
	row := object{"role": "assistant", "data": object{"parts": []any{object{"type": "dynamic-tool", "toolName": "mcp__computer__click", "toolCallId": "interrupted", "state": "input-available", "input": object{"snapshotId": "old"}}}}}
	messages := computerHistoryMessages(row)
	if len(messages) != 2 || !strings.Contains(text(messages[1]["content"]), "unconfirmed") || !strings.Contains(text(messages[1]["content"]), "doNotAutomaticallyReplay") {
		t.Fatal("interrupted outcome was silently removed")
	}
	output := object{"screenshot": object{"status": "available", "image": object{"mimeType": "image/png", "dataBase64": base64.StdEncoding.EncodeToString([]byte("not persisted")), "width": 10, "height": 10}}, "tree": object{"text": "live accessible field"}}
	cleaned, image := computerObservation(output, false)
	if image != "" || computerModelImages(object{"inputModalities": []any{"text"}}) {
		t.Fatal("known text-only model got an image")
	}
	encoded, _ := json.Marshal(cleaned)
	if strings.Contains(string(encoded), "dataBase64") || !strings.Contains(string(encoded), "live accessible field") {
		t.Fatal("AX text or screenshot privacy boundary lost")
	}
}

func TestComputerChatStopsAtModelStepLimitWithoutAnotherAction(t *testing.T) {
	var requests atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := requests.Add(1)
		writeChatTool(w, fmt.Sprintf("unique-%d", n), "mcp__computer__list_apps", `{}`, true)
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	topic := seedChat(t, s, endpoint.URL)
	host := &chatComputerHost{}
	enableChatComputer(t, s, host)
	g := launch(t, s, topic)
	waitDone(t, g)
	row, _ := s.store.get("messages", text(g.row["id"]))
	if requests.Load() != maxComputerRounds || host.count() != maxComputerRounds-1 || row["status"] != "error" {
		t.Fatal("model step limit failed to stop additional actions")
	}
}

func TestComputerToolValidationMatchesOriginalTargetAndValueRules(t *testing.T) {
	for _, test := range []struct {
		name, args string
		valid      bool
	}{
		{"click", `{"appSessionId":"s","snapshotId":"p","x":0,"y":0,"count":3}`, true},
		{"click", `{"appSessionId":"s","snapshotId":"p","x":0,"y":0,"count":1.5}`, false},
		{"click", `{"appSessionId":"s","snapshotId":"p","x":0}`, false},
		{"click", `{"appSessionId":"s","snapshotId":"p","x":-1,"y":0}`, false},
		{"scroll", `{"appSessionId":"s","snapshotId":"p","direction":"down","pages":0}`, false},
		{"scroll", `{"appSessionId":"s","snapshotId":"p","direction":"down","pages":0.5}`, true},
		{"set_value", `{"appSessionId":"s","snapshotId":"p","elementId":"1","value":""}`, true},
		{"drag", `{"appSessionId":"s","snapshotId":"p","from":{"x":"1","y":2},"to":{"x":3,"y":4}}`, false},
		{"press_key", `{"appSessionId":"s","snapshotId":"p","key":"Return"}`, false},
	} {
		var args object
		_ = json.Unmarshal([]byte(test.args), &args)
		if got := validateComputerArguments("mcp__computer__"+test.name, args) == nil; got != test.valid {
			t.Errorf("schema mismatch %s %s: %v", test.name, test.args, got)
		}
	}
	parts := []any{object{"type": "text", "text": "partial", "state": "streaming"}, object{"type": "dynamic-tool", "toolName": "mcp__computer__click", "toolCallId": "stopped", "state": "input-available", "input": object{}}}
	if !finalizeComputerParts(parts) || obj(parts[0])["state"] != "done" || obj(parts[1])["state"] != "output-error" || !strings.Contains(text(obj(parts[1])["errorText"]), "unconfirmed") {
		t.Fatal("interruption left parts streaming or hid its unconfirmed effect")
	}
}

func TestComputerChatKeepsAllBatchToolResponsesBeforeLatestImage(t *testing.T) {
	for _, secondImage := range []bool{false, true} {
		t.Run(fmt.Sprint(secondImage), func(t *testing.T) {
			first := base64.StdEncoding.EncodeToString([]byte("first synthetic screenshot"))
			latest := base64.StdEncoding.EncodeToString([]byte("second synthetic screenshot"))
			var requests atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body object
				if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
					t.Error(err)
				}
				if requests.Add(1) == 1 {
					secondName, secondArgs := "mcp__computer__list_apps", `{}`
					if secondImage {
						secondName, secondArgs = "mcp__computer__get_app_state", `{"appSessionId":"session-two"}`
					}
					frame := object{"choices": []object{{"delta": object{"tool_calls": []object{
						{"index": 0, "id": "batch-one", "type": "function", "function": object{"name": "mcp__computer__get_app_state", "arguments": `{"appSessionId":"session-one"}`}},
						{"index": 1, "id": "batch-two", "type": "function", "function": object{"name": secondName, "arguments": secondArgs}},
					}}, "finish_reason": "tool_calls"}}}
					encoded, _ := json.Marshal(frame)
					w.Header().Set("Content-Type", "text/event-stream")
					fmt.Fprintf(w, "data: %s\n\ndata: [DONE]\n\n", encoded)
					return
				}
				messages := array(body["messages"])
				start := -1
				for i, value := range messages {
					message := obj(value)
					if message["role"] == "assistant" && len(array(message["tool_calls"])) == 2 {
						start = i
						break
					}
				}
				if start < 0 || len(messages)-start != 4 {
					t.Errorf("missing complete two-call batch: %#v", messages)
				} else {
					for i, role := range []string{"assistant", "tool", "tool", "user"} {
						if obj(messages[start+i])["role"] != role {
							t.Errorf("tool responses interrupted by image: %#v", messages[start:])
						}
					}
					if obj(messages[start+1])["tool_call_id"] != "batch-one" || obj(messages[start+2])["tool_call_id"] != "batch-two" {
						t.Error("tool response order/identity changed")
					}
					images := array(obj(messages[start+3])["content"])
					expected := first
					if secondImage {
						expected = latest
					}
					if len(images) != 2 || obj(obj(images[1])["image_url"])["url"] != "data:image/png;base64,"+expected {
						t.Error("batch did not retain exactly its latest image")
					}
				}
				writeChatText(w, "batch complete")
			}))
			defer endpoint.Close()
			host := &chatComputerHost{invoke: func(_ context.Context, name string, input object) (object, error) {
				if name == "list_apps" {
					return object{"apps": []any{}}, nil
				}
				image := first
				if input["appSessionId"] == "session-two" {
					image = latest
				}
				return object{"id": "synthetic-snapshot", "appSessionId": input["appSessionId"], "screenshot": object{"status": "available", "image": object{"mimeType": "image/png", "width": 20, "height": 20, "dataBase64": image}}}, nil
			}}
			s, _ := testServer(t)
			topic := seedChat(t, s, endpoint.URL)
			model, _ := s.store.get("models", "test::local")
			model["inputModalities"] = []any{"text", "image"}
			if err := s.store.put("models", model); err != nil {
				t.Fatal(err)
			}
			enableChatComputer(t, s, host)
			g := launch(t, s, topic)
			waitDone(t, g)
			row, _ := s.store.get("messages", text(g.row["id"]))
			if requests.Load() != 2 || host.count() != 2 || row["status"] != "success" {
				t.Fatal("batch tool call was repeated or failed")
			}
		})
	}
}
