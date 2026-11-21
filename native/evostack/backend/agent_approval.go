package main

import (
	"context"
	"errors"
	"path/filepath"
)

type agentPendingApproval struct {
	id         string
	generation *generation
	tool       string
	input      object
	context    context.Context
	result     chan bool
}

func (s *server) respondAgentApproval(input object) (any, error) {
	approved, ok := input["approved"].(bool)
	if !ok {
		return nil, errors.New("approved must be a boolean")
	}
	pending := s.agentApprovals[text(input["approvalId"])]
	if pending == nil {
		return object{"ok": false, "reason": "undelivered"}, nil
	}
	g := pending.generation
	if (text(input["topicId"]) != "" && input["topicId"] != g.topicID) || (text(input["anchorId"]) != "" && input["anchorId"] != g.row["id"]) || input["updatedInput"] != nil {
		return object{"ok": false, "reason": "rejected"}, nil
	}
	if pending.context.Err() != nil || s.active[g.topicID] != g {
		return object{"ok": false, "reason": "undelivered"}, nil
	}
	if approved {
		if err := s.agentToolAllowedLocked(g, pending.tool); err != nil {
			return object{"ok": false, "reason": "rejected"}, nil
		}
	}
	delete(s.agentApprovals, pending.id)
	pending.result <- approved
	return object{"ok": true}, nil
}

func (s *server) awaitAgentApproval(ctx context.Context, g *generation, name string, input, part object) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	pending := &agentPendingApproval{id: newID(), generation: g, tool: name, input: clone(input), context: ctx, result: make(chan bool, 1)}
	s.mu.Lock()
	if s.agentApprovals == nil {
		s.agentApprovals = map[string]*agentPendingApproval{}
	}
	s.agentApprovals[pending.id] = pending
	part["state"], part["approval"] = "approval-requested", object{"id": pending.id}
	// Display the trusted workspace beside the exact proposed command/content.
	part["callProviderMetadata"] = object{"cherry": object{"toolSource": "native", "workspacePath": g.agent.workspacePath, "resolvedCwd": filepath.Join(g.agent.workspacePath, text(input["cwd"])), "hostShell": name == "run_shell"}}
	err := s.chunk(g, object{"type": "tool-approval-request", "approvalId": pending.id, "toolCallId": part["toolCallId"]})
	if err == nil {
		err = s.persistGeneration(g, "pending")
	}
	if err == nil {
		s.updateProjection(g, "active", nil, true)
		s.cache("topic.stream.statuses."+g.topicID, object{"status": "awaiting-approval", "activeExecutions": []object{g.execution()}, "awaitingApprovalAnchors": []object{g.execution()}})
	}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.agentApprovals, pending.id)
		s.mu.Unlock()
	}()
	if err != nil {
		return err
	}
	var approved bool
	select {
	case approved = <-pending.result:
	case <-ctx.Done():
		return ctx.Err()
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	s.mu.Lock()
	part["state"], part["approval"] = "approval-responded", object{"id": pending.id, "approved": approved}
	err = s.persistGeneration(g, "pending")
	s.updateProjection(g, "active", nil, true)
	s.cache("topic.stream.statuses."+g.topicID, object{"status": "streaming", "activeExecutions": []object{g.execution()}, "awaitingApprovalAnchors": []any{}})
	s.mu.Unlock()
	if err != nil {
		return err
	}
	if !approved {
		return errors.New("user denied this action; do not retry it or find another way to perform it")
	}
	return nil
}
