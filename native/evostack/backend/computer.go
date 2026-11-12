package main

import (
	"context"
	"errors"
	"strings"
	"time"
)

const computerPreference = "app.computer_use.agent_control.enabled"

func (s *server) computerTaskGrant(channel string, args []any, result any) string {
	if channel != "ipc-api:request" || argument(args, 0) != "ai.stream.open" || obj(result)["ok"] != true {
		return ""
	}
	ack := obj(obj(result)["data"])
	executions, ok := ack["activeExecutions"].([]object)
	if ack["mode"] != "started" || !ok || len(executions) != 1 {
		return ""
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	g := s.active[text(obj(argument(args, 1))["topicId"])]
	if g == nil || !g.computerEnabled || executions[0]["anchorMessageId"] != g.row["id"] || executions[0]["attemptId"] != g.attempt {
		return ""
	}
	return g.computerTaskID
}

func (s *server) computerEnabled() (bool, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.store.preference(computerPreference)
	return value == true, err
}

func (s *server) computerConfiguration() (bool, uint64, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.computerEpoch == 0 {
		s.computerEpoch = 1
	}
	value, err := s.store.preference(computerPreference)
	return value == true, s.computerEpoch, err
}

func (s *server) computerTool(ctx context.Context, ownerID, taskID, label, name string, input object) (object, error) {
	enabled, epoch, err := s.computerConfiguration()
	if err != nil {
		return nil, err
	}
	if !enabled {
		return nil, &computerControlError{Code: "CONTROL_DISABLED", Effect: "none", Message: "Desktop control was disabled by the user"}
	}
	if s.computerHost == nil {
		return nil, &computerControlError{Code: "CONTROL_UNAVAILABLE", Effect: "none", Message: "The desktop host is unavailable"}
	}
	if _, err := s.computerHost.Call(ctx, object{"operation": "configure", "epoch": epoch, "enabled": true}); err != nil {
		return nil, err
	}
	return s.computerHost.Call(ctx, object{"operation": "invoke", "epoch": epoch, "ownerId": ownerID, "taskId": taskID, "label": label, "tool": strings.TrimPrefix(name, "mcp__computer__"), "input": input})
}

func (s *server) closeComputerTask(taskID string) error {
	if taskID == "" || s.computerHost == nil {
		return nil
	}
	if s.context != nil && s.context.Err() != nil {
		if host, ok := s.computerHost.(interface{ CancelTask(string) }); ok {
			host.CancelTask(taskID)
		}
		return nil // Rust also closes private helpers on parent shutdown.
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	_, err := s.computerHost.Call(ctx, object{"operation": "close_task", "taskId": taskID})
	return err
}

func (s *server) setPreferences(channel string, args []any) (any, error, func()) {
	updates := obj(argument(args, 0))
	if channel == "preference:set" {
		updates = object{text(argument(args, 0)): argument(args, 1)}
	}
	control, hasControl := updates[computerPreference]
	if hasControl {
		if _, ok := control.(bool); !ok {
			return nil, errors.New("desktop control preference must be a boolean"), nil
		}
	}
	s.mu.Lock()
	var old any
	var readErr error
	if hasControl {
		old, readErr = s.store.preference(computerPreference)
	}
	err := s.store.transaction(func(repository *store) error {
		for key, value := range updates {
			if err := repository.setPreference(key, value); err != nil {
				return err
			}
		}
		return nil
	})
	if err == nil && hasControl {
		if s.computerEpoch == 0 {
			s.computerEpoch = 1
		}
		if control != old || readErr != nil {
			s.computerEpoch++
		}
		if control == false {
			for _, g := range s.active {
				if g.computerEnabled {
					g.cancel()
				}
			}
		}
	}
	epoch := s.computerEpoch
	if err == nil {
		for key, value := range updates {
			s.writer.event("preference:changed", key, value)
		}
	}
	s.mu.Unlock()
	if err != nil || !hasControl || s.computerHost == nil {
		return nil, err, nil
	}
	parent := s.context
	if parent == nil {
		parent = context.Background()
	}
	ctx, cancel := context.WithTimeout(parent, 4*time.Second)
	defer cancel()
	_, err = s.computerHost.Call(ctx, object{"operation": "configure", "epoch": epoch, "enabled": control})
	return nil, err, nil
}
