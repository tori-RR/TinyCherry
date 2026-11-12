package main

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"sync"
	"time"
)

const maxFrame = 4 * 1024 * 1024

var appVersion = "2.1.10"
var buildRevision = "development"

func buildInfo() object {
	return object{"version": appVersion, "revision": buildRevision, "protocol": 1, "backend": "go", "database": "sqlite", "profile": "evostack"}
}

type rpcRequest struct {
	JSONRPC string          `json:"jsonrpc"`
	ID      json.RawMessage `json:"id"`
	Method  string          `json:"method"`
	Params  json.RawMessage `json:"params"`
}
type wireWriter struct {
	mu     sync.Mutex
	output io.Writer
}

func (w *wireWriter) send(value any) error {
	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	err := encoder.Encode(value)
	if err != nil {
		return err
	}
	data := buffer.Bytes()
	if len(data) > maxFrame {
		frame, ok := value.(map[string]any)
		if !ok || frame["id"] == nil {
			return errors.New("response frame too large")
		}
		data, _ = json.Marshal(object{"jsonrpc": "2.0", "id": frame["id"], "error": object{"code": -32000, "message": "EVOSTACK_FRAME_TOO_LARGE: reduce the query page size"}})
		data = append(data, '\n')
	}
	w.mu.Lock()
	defer w.mu.Unlock()
	_, err = w.output.Write(data)
	return err
}
func (w *wireWriter) event(channel string, args ...any) {
	_ = w.send(object{"jsonrpc": "2.0", "method": "event", "params": object{"channel": channel, "args": args}})
}

type server struct {
	*serverState
	store *store
}

// Transaction views share process state while keeping their repository executor local.
type serverState struct {
	computerHost      computerHost
	computerEpoch     uint64
	skills            *skillRuntime
	mu                sync.Mutex
	interrupts        sync.Map
	networkTransports *transportPool
	writer            *wireWriter
	active            map[string]*generation
	shared            object
	attempt           int64
	context           context.Context
	cancel            context.CancelFunc
}

func (s *server) registerGenerationCancel(topicID string, cancel context.CancelFunc) {
	s.interrupts.Store(topicID, cancel)
}

func (s *server) unregisterGenerationCancel(topicID string) { s.interrupts.Delete(topicID) }

func (s *server) interruptGeneration(topicID string) {
	if value, ok := s.interrupts.Load(topicID); ok {
		value.(context.CancelFunc)()
	}
}

func newServer(repository *store, writer *wireWriter, ctx context.Context, cancel context.CancelFunc) *server {
	return &server{store: repository, serverState: &serverState{writer: writer, active: map[string]*generation{}, shared: object{}, context: ctx, cancel: cancel, computerEpoch: 1, networkTransports: newTransportPool()}}
}

func (s *server) transaction(operation func(*server) error) error {
	if s.store.tx != nil {
		return operation(s)
	}
	updates := object{}
	err := s.store.transaction(func(repository *store) error {
		view := &server{serverState: s.serverState, store: repository}
		if err := operation(view); err != nil {
			return err
		}
		updates = repository.preferenceUpdates
		return nil
	})
	if err == nil {
		for key, value := range updates {
			s.writer.event("preference:changed", key, value)
		}
	}
	return err
}

func (s *server) event(name string, payload any) { s.writer.event("ipc-api:event", name, payload) }
func (s *server) changed(endpoints ...string) {
	effects := []any{}
	for _, endpoint := range endpoints {
		effect := object{"endpoint": endpoint}
		switch endpoint {
		case "/providers", "/models", "/assistants", "/topics", "/topics/:topicId/messages", "/groups", "/pins", "/tags", "/prompts", "/prompt-bindings", "/prompts/:id/bindings", "/prompt-bindings/:targetType/:targetId", "/skills", "/knowledge-bases", "/knowledge-bases/:id/items", "/archives":
			effect["kind"] = "membership"
		}
		effects = append(effects, effect)
	}
	s.writer.event("data-api:data-changed", effects)
}
func (s *server) cache(key string, value any) {
	s.shared[key] = object{"value": value}
	s.writer.event("cache:sync", object{"type": "shared", "key": key, "value": value})
}

func main() {
	directory := flag.String("data-dir", "", "absolute path to the isolated EvoStack profile")
	printBuildInfo := flag.Bool("evostack-build-info", false, "print package identity without opening a profile")
	flag.Parse()
	if *printBuildInfo {
		_ = json.NewEncoder(os.Stdout).Encode(buildInfo())
		return
	}
	unlock, err := lockProfile(*directory)
	if err != nil {
		fmt.Fprintln(os.Stderr, "EvoStack profile cannot be acquired")
		os.Exit(1)
	}
	defer unlock()
	store, err := openStore(*directory)
	if err != nil {
		fmt.Fprintln(os.Stderr, "EvoStack database initialization failed")
		os.Exit(1)
	}
	defer store.db.Close()
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	writer := &wireWriter{output: os.Stdout}
	computer := newComputerBridge(writer)
	s := newServer(store, writer, ctx, cancel)
	s.computerHost = computer
	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 64*1024), maxFrame)
	var workers sync.WaitGroup
	slots := make(chan struct{}, 32)
readLoop:
	for scanner.Scan() {
		// Host replies must bypass request slots and the store lock: a tool may be waiting on one.
		if computer.receive(scanner.Bytes()) {
			continue
		}
		var request rpcRequest
		if err := json.Unmarshal(scanner.Bytes(), &request); err != nil || request.JSONRPC != "2.0" || len(request.ID) == 0 {
			_ = writer.send(object{"jsonrpc": "2.0", "id": nil, "error": object{"code": -32600, "message": "Invalid Request"}})
			continue
		}
		if request.Method == "backend.shutdown" {
			s.cancel()
			_ = writer.send(object{"jsonrpc": "2.0", "id": request.ID, "result": nil})
			break
		}
		if request.Method == "ipc.invoke" {
			var urgent struct {
				Channel string `json:"channel"`
				Args    []any  `json:"args"`
			}
			if json.Unmarshal(request.Params, &urgent) == nil && urgent.Channel == "ipc-api:request" && argument(urgent.Args, 0) == "ai.stream.abort" {
				s.interruptGeneration(text(obj(argument(urgent.Args, 1))["topicId"]))
			}
		}
		select {
		case slots <- struct{}{}:
		case <-ctx.Done():
			break readLoop
		default:
			// Blocking here would strand reverse host replies behind the request queue.
			_ = writer.send(object{"jsonrpc": "2.0", "id": request.ID, "error": object{"code": -32000, "message": "EVOSTACK_BUSY: too many pending requests"}})
			continue
		}
		workers.Add(1)
		go func(request rpcRequest) {
			defer workers.Done()
			defer func() { <-slots }()
			var result any
			var err error
			var after func()
			var computerTaskID string
			switch request.Method {
			case "backend.info":
				result = buildInfo()
			case "ipc.invoke":
				var params struct {
					Channel string `json:"channel"`
					Args    []any  `json:"args"`
				}
				if json.Unmarshal(request.Params, &params) != nil || params.Channel == "" {
					err = errors.New("invalid invoke")
				} else {
					result, err, after = s.invoke(params.Channel, params.Args)
					if err == nil {
						computerTaskID = s.computerTaskGrant(params.Channel, params.Args, result)
					}
				}
			default:
				err = errors.New("method not found")
			}
			response := object{"jsonrpc": "2.0", "id": request.ID, "result": result}
			if computerTaskID != "" {
				// Private transport metadata: it is not part of the renderer's IpcApi acknowledgement.
				response["computerTaskId"] = computerTaskID
			}
			if err != nil {
				delete(response, "result")
				response["error"] = object{"code": -32603, "message": err.Error()}
			}
			if writeErr := writer.send(response); writeErr != nil {
				s.cancel()
			}
			if after != nil {
				after()
			}
		}(request)
	}
	// Parent death closes stdin. Cancellation closes HTTP bodies before SQLite shuts down.
	s.cancel()
	s.closeNetworkTransports()
	computer.close()
	workers.Wait()
	s.mu.Lock()
	running := []*generation{}
	for _, g := range s.active {
		g.cancel()
		running = append(running, g)
	}
	s.mu.Unlock()
	for _, g := range running {
		select {
		case <-g.done:
		case <-time.After(5 * time.Second):
		}
	}
}
