package main

import (
	"context"
	"errors"
	"sort"
	"strings"
	"unicode/utf16"
)

const approvedComputerAppsPreference = "app.computer_use.approved_apps"

type computerPendingApproval struct {
	id, owner, task, identity string
	app                       object
	action                    object
	epoch                     uint64
	context                   context.Context
	done                      chan struct{}
	decision                  string
}

type computerApprovalState struct {
	pending map[string]*computerPendingApproval
	grants  map[string]map[string]bool
	blocked map[string]map[string]bool
}

func (s *server) computerApprovalsLocked() *computerApprovalState {
	if s.computerApprovals == nil {
		s.computerApprovals = &computerApprovalState{pending: map[string]*computerPendingApproval{}, grants: map[string]map[string]bool{}, blocked: map[string]map[string]bool{}}
	}
	return s.computerApprovals
}

func validComputerIdentity(value string) bool {
	return value != "" && len(utf16.Encode([]rune(value))) <= 512
}

func computerApprovedApps(value any) ([]any, error) {
	items, ok := value.([]any)
	if !ok || len(items) > 512 {
		return nil, errors.New("approved applications must be a bounded array")
	}
	seen := map[string]bool{}
	result := []any{}
	for _, item := range items {
		identity, ok := item.(string)
		if !ok || !validComputerIdentity(identity) || seen[identity] {
			return nil, errors.New("approved applications must contain unique stable identities")
		}
		seen[identity] = true
		result = append(result, identity)
	}
	return result, nil
}

func (s *server) computerApprovalsChanged() {
	// A void event has no payload argument, matching the shared IPC contract.
	s.writer.event("ipc-api:event", "computer_use.approvals_changed")
}

func (s *server) finishComputerApprovalLocked(p *computerPendingApproval, scope string) {
	state := s.computerApprovalsLocked()
	if state.pending[p.id] != p {
		return
	}
	delete(state.pending, p.id)
	p.decision = scope
	close(p.done)
	s.computerApprovalsChanged()
}

func (s *server) cancelComputerApprovalsLocked(owner, task, app string) {
	state := s.computerApprovalsLocked()
	for _, pending := range state.pending {
		if (owner == "" || pending.owner == owner) && (task == "" || pending.task == task) && (app == "" || text(pending.app["id"]) == app || pending.identity == app) {
			s.finishComputerApprovalLocked(pending, "cancelled")
		}
	}
}

func (s *server) computerApprovalCommand(route string, input object) (any, error, bool) {
	if route != "computer_use.get_approvals" && route != "computer_use.respond_approval" && route != "computer_use.revoke_approval" && route != "computer_use.stop_app" && route != "computer_use.stop_all" {
		return nil, nil, false
	}
	state := s.computerApprovalsLocked()
	switch route {
	case "computer_use.get_approvals":
		if len(input) != 0 {
			return nil, errors.New("invalid approval query"), true
		}
		result := []object{}
		for _, pending := range state.pending {
			if pending.context.Err() != nil {
				s.finishComputerApprovalLocked(pending, "cancelled")
				continue
			}
			item := object{"approvalId": pending.id, "topicId": pending.owner, "app": clone(pending.app)}
			if pending.action != nil {
				item["action"] = clone(pending.action)
			}
			result = append(result, item)
		}
		sort.Slice(result, func(i, j int) bool { return text(result[i]["approvalId"]) < text(result[j]["approvalId"]) })
		return result, nil, true
	case "computer_use.respond_approval":
		scope := text(input["scope"])
		if len(input) != 2 || (scope != "always" && scope != "session" && scope != "once" && scope != "reject") {
			return nil, errors.New("invalid desktop approval response"), true
		}
		pending := state.pending[text(input["approvalId"])]
		if pending == nil {
			return false, nil, true
		}
		if scope != "reject" && (pending.action != nil) != (scope == "once") {
			return false, nil, true
		}
		enabled, err := s.store.preference(computerPreference)
		if err != nil {
			return nil, err, true
		}
		generation := s.active[pending.owner]
		if pending.context.Err() != nil || enabled != true || pending.epoch != s.computerEpoch || generation == nil || generation.computerTaskID != pending.task || !generation.computerEnabled || state.blocked[pending.task][text(pending.app["id"])] || state.blocked[pending.task]["*"] {
			s.finishComputerApprovalLocked(pending, "cancelled")
			return false, nil, true
		}
		if scope == "always" {
			value, err := s.store.preference(approvedComputerAppsPreference)
			if err != nil {
				return nil, err, true
			}
			approved, err := computerApprovedApps(value)
			if err != nil {
				return nil, err, true
			}
			found := false
			for _, entry := range approved {
				found = found || entry == pending.identity
			}
			if !found {
				if len(approved) >= 512 {
					return nil, errors.New("approved application limit reached"), true
				}
				approved = append(approved, pending.identity)
				if err := s.store.setPreference(approvedComputerAppsPreference, approved); err != nil {
					return nil, err, true
				}
				s.writer.event("preference:changed", approvedComputerAppsPreference, approved)
			}
		} else if scope == "session" {
			if state.grants[pending.owner] == nil {
				state.grants[pending.owner] = map[string]bool{}
			}
			state.grants[pending.owner][pending.identity] = true
		}
		s.finishComputerApprovalLocked(pending, scope)
		return true, nil, true
	case "computer_use.revoke_approval":
		identity := text(input["identity"])
		if len(input) != 1 || !validComputerIdentity(identity) {
			return nil, errors.New("invalid application identity"), true
		}
		value, err := s.store.preference(approvedComputerAppsPreference)
		if err != nil {
			return nil, err, true
		}
		approved, err := computerApprovedApps(value)
		if err != nil {
			return nil, err, true
		}
		retained := []any{}
		for _, item := range approved {
			if !strings.EqualFold(text(item), identity) {
				retained = append(retained, item)
			}
		}
		if err := s.store.setPreference(approvedComputerAppsPreference, retained); err != nil {
			return nil, err, true
		}
		for _, grants := range state.grants {
			for granted := range grants {
				if strings.EqualFold(granted, identity) {
					delete(grants, granted)
				}
			}
		}
		for _, pending := range state.pending {
			if strings.EqualFold(pending.identity, identity) {
				s.finishComputerApprovalLocked(pending, "cancelled")
			}
		}
		s.writer.event("preference:changed", approvedComputerAppsPreference, retained)
		return nil, nil, true
	case "computer_use.stop_all":
		if len(input) != 0 {
			return nil, errors.New("invalid stop request"), true
		}
		s.cancelComputerApprovalsLocked("", "", "")
		state.grants = map[string]map[string]bool{}
		for _, generation := range s.active {
			if generation.computerEnabled {
				state.blocked[generation.computerTaskID] = map[string]bool{"*": true}
			}
		}
		return nil, nil, true
	case "computer_use.stop_app":
		owner, app := text(input["ownerId"]), text(input["appId"])
		if len(input) != 2 || owner == "" || app == "" {
			return nil, errors.New("invalid application stop request"), true
		}
		if generation := s.active[owner]; generation != nil {
			if state.blocked[generation.computerTaskID] == nil {
				state.blocked[generation.computerTaskID] = map[string]bool{}
			}
			state.blocked[generation.computerTaskID][app] = true
		}
		s.cancelComputerApprovalsLocked(owner, "", app)
		return nil, nil, true
	}
	panic("unreachable computer approval route")
}

func (s *server) authorizeComputerApp(ctx context.Context, owner, task string, epoch uint64, app object) error {
	identity := text(app["identity"])
	if !validComputerIdentity(identity) || text(app["id"]) == "" || text(app["name"]) == "" {
		return &computerControlError{Code: "APPROVAL_UNAVAILABLE", Effect: "none", Message: "Application approval requires a stable native identity"}
	}
	s.mu.Lock()
	state := s.computerApprovalsLocked()
	if ctx.Err() != nil || state.blocked[task][text(app["id"])] || state.blocked[task]["*"] {
		s.mu.Unlock()
		return &computerControlError{Code: "USER_STOPPED", Effect: "none", Message: "The desktop task or application was stopped"}
	}
	generation := s.active[owner]
	if generation == nil || generation.computerTaskID != task || !generation.computerEnabled {
		s.mu.Unlock()
		return &computerControlError{Code: "TASK_CLOSED", Effect: "none", Message: "Application approval requires the active desktop conversation"}
	}
	enabled, err := s.store.preference(computerPreference)
	if err != nil || enabled != true || epoch != s.computerEpoch {
		s.mu.Unlock()
		return &computerControlError{Code: "CONTROL_DISABLED", Effect: "none", Message: "Desktop authorization changed", Cause: err}
	}
	if generation.computerBypass {
		s.mu.Unlock()
		return nil
	}
	value, err := s.store.preference(approvedComputerAppsPreference)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	approved, err := computerApprovedApps(value)
	if err != nil {
		s.mu.Unlock()
		return err
	}
	granted := state.grants[owner][identity]
	for _, item := range approved {
		granted = granted || item == identity
	}
	if granted {
		s.mu.Unlock()
		return nil
	}
	var pending *computerPendingApproval
	for _, existing := range state.pending {
		if existing.task == task && existing.identity == identity && existing.action == nil {
			pending = existing
			break
		}
	}
	if pending == nil {
		if len(state.pending) >= 64 {
			s.mu.Unlock()
			return &computerControlError{Code: "CONTROL_LIMIT", Effect: "none", Message: "Application approval queue is full"}
		}
		pending = &computerPendingApproval{id: newID(), owner: owner, task: task, identity: identity, app: clone(app), epoch: epoch, context: ctx, done: make(chan struct{})}
		state.pending[pending.id] = pending
		s.computerApprovalsChanged()
	}
	s.mu.Unlock()
	decision, err := s.awaitComputerApproval(pending)
	if err != nil {
		return err
	}
	if decision != "always" && decision != "session" {
		return &computerControlError{Code: "PERMISSION_DENIED", Effect: "none", Message: "The user rejected access to this application"}
	}
	return nil
}

func (s *server) authorizeComputerAction(ctx context.Context, owner, task string, epoch uint64, app, action object) error {
	identity, appID := text(app["identity"]), text(app["id"])
	if !validComputerIdentity(identity) || appID == "" || text(app["name"]) == "" {
		return &computerControlError{Code: "APPROVAL_UNAVAILABLE", Effect: "none", Message: "Desktop action approval requires a verified application"}
	}
	s.mu.Lock()
	state := s.computerApprovalsLocked()
	generation := s.active[owner]
	if ctx.Err() != nil || epoch != s.computerEpoch || generation == nil || generation.computerTaskID != task || !generation.computerEnabled || state.blocked[task][appID] || state.blocked[task]["*"] {
		s.mu.Unlock()
		return &computerControlError{Code: "USER_STOPPED", Effect: "none", Message: "The desktop task or application was stopped"}
	}
	if len(state.pending) >= 64 {
		s.mu.Unlock()
		return &computerControlError{Code: "CONTROL_LIMIT", Effect: "none", Message: "Desktop approval queue is full"}
	}
	pending := &computerPendingApproval{id: newID(), owner: owner, task: task, identity: identity, app: clone(app), action: clone(action), epoch: epoch, context: ctx, done: make(chan struct{})}
	state.pending[pending.id] = pending
	s.computerApprovalsChanged()
	s.mu.Unlock()
	decision, err := s.awaitComputerApproval(pending)
	if err != nil {
		return err
	}
	if decision != "once" {
		return &computerControlError{Code: "PERMISSION_DENIED", Effect: "none", Message: "The user rejected this desktop action"}
	}
	return nil
}

func (s *server) awaitComputerApproval(pending *computerPendingApproval) (string, error) {
	select {
	case <-pending.done:
	case <-pending.context.Done():
		s.mu.Lock()
		s.finishComputerApprovalLocked(pending, "cancelled")
		s.mu.Unlock()
		return "", &computerControlError{Code: "CONTROL_CANCELLED", Effect: "none", Message: "Desktop approval was cancelled", Cause: pending.context.Err()}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	state := s.computerApprovalsLocked()
	decision := pending.decision
	stopped := state.blocked[pending.task][text(pending.app["id"])] || state.blocked[pending.task]["*"] || pending.context.Err() != nil || pending.epoch != s.computerEpoch
	if stopped || decision == "cancelled" {
		return "", &computerControlError{Code: "USER_STOPPED", Effect: "none", Message: "The desktop approval is no longer active"}
	}
	return decision, nil
}
