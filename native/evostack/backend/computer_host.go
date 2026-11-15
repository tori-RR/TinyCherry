package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"strings"
	"sync"
)

type computerHost interface {
	Call(context.Context, object) (object, error)
}

type computerControlError struct {
	Code    string
	Effect  string
	Message string
	Cause   error
}

func (e *computerControlError) Unwrap() error { return e.Cause }

func (e *computerControlError) Error() string {
	if e.Message != "" {
		return e.Code + ": " + e.Message
	}
	return e.Code
}

func terminalComputerError(err error) bool {
	var control *computerControlError
	if errors.As(err, &control) {
		return control.Effect != "none" || control.Code != "INVALID_INPUT"
	}
	return err != nil
}

type computerReply struct {
	data object
	err  error
}

// Numeric IDs belong to Rust's regular RPC client; string IDs belong to this reverse client.
type computerBridge struct {
	writer  *wireWriter
	mu      sync.Mutex
	next    uint64
	pending map[string]chan computerReply
	closed  bool
}

func newComputerBridge(writer *wireWriter) *computerBridge {
	return &computerBridge{writer: writer, pending: map[string]chan computerReply{}}
}

func (b *computerBridge) Call(ctx context.Context, params object) (object, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	b.mu.Lock()
	if b.closed || len(b.pending) >= 64 {
		b.mu.Unlock()
		return nil, &computerControlError{Code: "CONTROL_UNAVAILABLE", Effect: "none", Message: "Desktop host is unavailable"}
	}
	b.next++
	id := fmt.Sprintf("host:%d", b.next)
	replies := make(chan computerReply, 1)
	b.pending[id] = replies
	b.mu.Unlock()
	defer func() {
		b.mu.Lock()
		delete(b.pending, id)
		b.mu.Unlock()
	}()
	frame := object{"jsonrpc": "2.0", "id": id, "method": "host.computer", "params": params}
	encoded, err := json.Marshal(frame)
	if err != nil || len(encoded)+1 > maxFrame {
		return nil, &computerControlError{Code: "INVALID_INPUT", Effect: "none", Message: "Desktop request exceeds the IPC budget"}
	}
	b.mu.Lock()
	if b.closed || ctx.Err() != nil {
		b.mu.Unlock()
		if ctx.Err() != nil {
			return nil, ctx.Err()
		}
		return nil, io.ErrClosedPipe
	}
	b.mu.Unlock()
	// A pipe write must not hold the response-routing lock under bidirectional backpressure.
	err = b.writer.send(frame)
	if err != nil {
		return nil, &computerControlError{Code: "CONTROL_TRANSPORT", Effect: "possible", Message: "Desktop request outcome is unconfirmed. Do not replay the action automatically.", Cause: err}
	}
	select {
	case reply := <-replies:
		return reply.data, reply.err
	case <-ctx.Done():
		b.cancel(id, text(params["taskId"]))
		return nil, &computerControlError{Code: "CONTROL_CANCELLED", Effect: "possible", Message: "Desktop request was interrupted; its effect is unconfirmed. Do not replay the action automatically.", Cause: ctx.Err()}
	}
}

func (b *computerBridge) cancel(requestID, taskID string) {
	if taskID == "" {
		return
	}
	_ = b.writer.send(object{"jsonrpc": "2.0", "method": "host.computer.cancel", "params": object{"requestId": requestID, "taskId": taskID}})
}

func (b *computerBridge) CancelTask(taskID string) { b.cancel("", taskID) }

func (b *computerBridge) receive(line []byte) bool {
	var frame struct {
		JSONRPC string          `json:"jsonrpc"`
		ID      any             `json:"id"`
		Method  string          `json:"method"`
		Result  json.RawMessage `json:"result"`
		Error   json.RawMessage `json:"error"`
	}
	if json.Unmarshal(line, &frame) != nil || frame.Method != "" {
		return false
	}
	id, ok := frame.ID.(string)
	if !ok || !strings.HasPrefix(id, "host:") {
		return false
	}
	b.mu.Lock()
	replies := b.pending[id]
	delete(b.pending, id)
	b.mu.Unlock()
	if replies == nil {
		return true // Late or duplicate responses never become new requests.
	}
	reply := computerReply{}
	var result struct {
		OK    bool   `json:"ok"`
		Data  object `json:"data"`
		Error struct {
			Code    string `json:"code"`
			Message string `json:"message"`
			Effect  string `json:"effect"`
		} `json:"error"`
	}
	if frame.JSONRPC != "2.0" || len(frame.Error) != 0 || json.Unmarshal(frame.Result, &result) != nil {
		reply.err = &computerControlError{Code: "CONTROL_PROTOCOL", Effect: "possible", Message: "Desktop result could not be confirmed"}
	} else if !result.OK {
		effect := result.Error.Effect
		if effect != "none" && effect != "possible" && effect != "applied" {
			effect = "possible"
		}
		code := result.Error.Code
		if code == "" {
			code = "CONTROL_PROTOCOL"
		}
		reply.err = &computerControlError{Code: code, Effect: effect, Message: result.Error.Message}
	} else if result.Data == nil {
		reply.err = &computerControlError{Code: "CONTROL_PROTOCOL", Effect: "possible", Message: "Desktop response data is missing"}
	} else {
		reply.data = result.Data
	}
	replies <- reply
	return true
}

func (b *computerBridge) close() {
	b.mu.Lock()
	defer b.mu.Unlock()
	b.closed = true
	for id, replies := range b.pending {
		delete(b.pending, id)
		replies <- computerReply{err: &computerControlError{Code: "CONTROL_LOST", Effect: "possible", Message: "Desktop connection ended; the request effect is unconfirmed. Do not replay the action automatically.", Cause: io.ErrClosedPipe}}
	}
}
