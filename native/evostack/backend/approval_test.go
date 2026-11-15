package main

import (
	"context"
	"errors"
	"sync/atomic"
	"testing"
	"time"
)

func approvalFixture(t *testing.T) (*server, *generation, context.Context, context.CancelFunc, *atomic.Int32, string) {
	t.Helper()
	s, directory := testServer(t)
	if err := s.store.setPreference(computerPreference, true); err != nil {
		t.Fatal(err)
	}
	if err := s.store.setPreference(approvedComputerAppsPreference, []any{}); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithCancel(context.Background())
	g := &generation{topicID: newID(), computerTaskID: newID(), computerEnabled: true, cancel: cancel, done: make(chan struct{})}
	s.active[g.topicID] = g
	t.Cleanup(func() {
		cancel()
		s.mu.Lock()
		delete(s.active, g.topicID)
		s.cancelComputerApprovalsLocked("", "", "")
		s.mu.Unlock()
		close(g.done)
	})
	var opens atomic.Int32
	s.computerHost = computerHostFunc(func(_ context.Context, request object) (object, error) {
		switch request["operation"] {
		case "approval_app":
			return object{"id": "app-1", "name": "Owned fixture", "identity": "fixture:stable"}, nil
		case "invoke":
			if request["tool"] == "open_app" {
				if request["approvedIdentity"] != "fixture:stable" {
					return nil, errors.New("missing trusted identity")
				}
				opens.Add(1)
			}
		}
		return object{"cleanup": "complete"}, nil
	})
	return s, g, ctx, cancel, &opens, directory
}

func pendingApproval(t *testing.T, s *server) object {
	t.Helper()
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		result, err, _ := s.invoke("ipc-api:request", []any{"computer_use.get_approvals", nil})
		if err != nil || obj(result)["ok"] != true {
			t.Fatal("approval query failed", err, result)
		}
		items, ok := obj(result)["data"].([]object)
		if ok && len(items) == 1 {
			return items[0]
		}
		time.Sleep(time.Millisecond)
	}
	t.Fatal("application approval did not appear")
	return nil
}

func respondApproval(t *testing.T, s *server, id, scope string) bool {
	t.Helper()
	result, err, _ := s.invoke("ipc-api:request", []any{"computer_use.respond_approval", object{"approvalId": id, "scope": scope}})
	if err != nil || obj(result)["ok"] != true {
		t.Fatal("application response failed", err, result)
	}
	return obj(result)["data"] == true
}

func startApprovalOpen(s *server, g *generation, ctx context.Context) <-chan error {
	done := make(chan error, 1)
	go func() {
		_, err := s.computerTool(ctx, g.topicID, g.computerTaskID, "Fixture", "mcp__computer__open_app", object{"appId": "app-1"})
		done <- err
	}()
	return done
}

func awaitApprovalOpen(t *testing.T, done <-chan error) error {
	t.Helper()
	select {
	case err := <-done:
		return err
	case <-time.After(2 * time.Second):
		t.Fatal("approval wait did not settle")
		return nil
	}
}

func TestComputerApprovalAlwaysPersistsAndRevokeRequiresNewConsent(t *testing.T) {
	s, g, ctx, _, opens, directory := approvalFixture(t)
	done := startApprovalOpen(s, g, ctx)
	pending := pendingApproval(t, s)
	if pending["topicId"] != g.topicID || obj(pending["app"])["identity"] != "fixture:stable" || opens.Load() != 0 {
		t.Fatal("application opened before consent or prompt lost its trusted context", pending)
	}
	if !respondApproval(t, s, text(pending["approvalId"]), "always") || awaitApprovalOpen(t, done) != nil || opens.Load() != 1 {
		t.Fatal("explicit approval did not open exactly once")
	}
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	value, err := reopened.preference(approvedComputerAppsPreference)
	reopened.db.Close()
	if err != nil || len(array(value)) != 1 || array(value)[0] != "fixture:stable" {
		t.Fatal("Always did not persist its stable identity", value, err)
	}
	if err := awaitApprovalOpen(t, startApprovalOpen(s, g, ctx)); err != nil || opens.Load() != 2 {
		t.Fatal("remembered access unexpectedly required another prompt", err)
	}
	result, err, _ := s.invoke("ipc-api:request", []any{"computer_use.revoke_approval", object{"identity": "fixture:stable"}})
	if err != nil || obj(result)["ok"] != true {
		t.Fatal("revoke failed", err, result)
	}
	done = startApprovalOpen(s, g, ctx)
	pending = pendingApproval(t, s)
	if opens.Load() != 2 || !respondApproval(t, s, text(pending["approvalId"]), "reject") {
		t.Fatal("revoked application retained access")
	}
	if awaitApprovalOpen(t, done) == nil || opens.Load() != 2 {
		t.Fatal("Reject opened a native session")
	}
}

func TestComputerApprovalSessionAndBypassNeverPersist(t *testing.T) {
	for _, bypass := range []bool{false, true} {
		t.Run(map[bool]string{false: "session", true: "bypass"}[bypass], func(t *testing.T) {
			s, g, ctx, _, opens, directory := approvalFixture(t)
			g.computerBypass = bypass
			done := startApprovalOpen(s, g, ctx)
			if !bypass {
				pending := pendingApproval(t, s)
				if !respondApproval(t, s, text(pending["approvalId"]), "session") {
					t.Fatal("session response rejected")
				}
			}
			if err := awaitApprovalOpen(t, done); err != nil {
				t.Fatal(err)
			}
			if err := awaitApprovalOpen(t, startApprovalOpen(s, g, ctx)); err != nil || opens.Load() != 2 {
				t.Fatal("current conversation grant lost", err)
			}
			reopened, err := openStore(directory)
			if err != nil {
				t.Fatal(err)
			}
			value, err := reopened.preference(approvedComputerAppsPreference)
			reopened.db.Close()
			if err != nil || len(array(value)) != 0 {
				t.Fatal("transient authorization became permanent", value, err)
			}
			if bypass {
				s.mu.Lock()
				grants := len(s.computerApprovalsLocked().grants)
				s.mu.Unlock()
				if grants != 0 {
					t.Fatal("bypass saved a session grant")
				}
			}
		})
	}
}

func TestComputerApprovalStopAndCancellationRejectLateResponses(t *testing.T) {
	for _, stop := range []string{"cancel", "app", "all", "off", "new-attempt"} {
		t.Run(stop, func(t *testing.T) {
			s, g, ctx, cancel, opens, _ := approvalFixture(t)
			done := startApprovalOpen(s, g, ctx)
			pending := pendingApproval(t, s)
			var err error
			switch stop {
			case "cancel":
				cancel()
			case "app":
				_, err, _ = s.invoke("ipc-api:request", []any{"computer_use.stop_app", object{"ownerId": g.topicID, "appId": "app-1"}})
			case "all":
				_, err, _ = s.invoke("ipc-api:request", []any{"computer_use.stop_all", nil})
			case "off":
				_, err, _ = s.invoke("preference:set", []any{computerPreference, false})
			case "new-attempt":
				s.mu.Lock()
				g.computerTaskID = newID()
				s.mu.Unlock()
			}
			if err != nil {
				t.Fatal(err)
			}
			if respondApproval(t, s, text(pending["approvalId"]), "always") {
				t.Fatal("late approval accepted after revocation")
			}
			if awaitApprovalOpen(t, done) == nil || opens.Load() != 0 {
				t.Fatal("stopped pending application was opened")
			}
			value, err := s.store.preference(approvedComputerAppsPreference)
			if err != nil || len(array(value)) != 0 {
				t.Fatal("stale approval was persisted", value, err)
			}
		})
	}
}

func TestComputerApprovalSessionDoesNotCrossConversations(t *testing.T) {
	s, g, ctx, _, _, _ := approvalFixture(t)
	done := startApprovalOpen(s, g, ctx)
	pending := pendingApproval(t, s)
	respondApproval(t, s, text(pending["approvalId"]), "session")
	if err := awaitApprovalOpen(t, done); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	// A new turn in the same conversation retains its session approval.
	g.computerTaskID = newID()
	s.mu.Unlock()
	if err := awaitApprovalOpen(t, startApprovalOpen(s, g, ctx)); err != nil {
		t.Fatal("session grant did not survive a new turn", err)
	}
	other := &generation{topicID: newID(), computerTaskID: newID(), computerEnabled: true}
	s.mu.Lock()
	s.active[other.topicID] = other
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.active, other.topicID)
		s.mu.Unlock()
	}()
	done = startApprovalOpen(s, other, ctx)
	pending = pendingApproval(t, s)
	if pending["topicId"] != other.topicID {
		t.Fatal("another conversation inherited a session grant")
	}
	respondApproval(t, s, text(pending["approvalId"]), "reject")
	if awaitApprovalOpen(t, done) == nil {
		t.Fatal("a rejected conversation retained another conversation's grant")
	}
}

func TestComputerApprovalDeduplicatesWaitersAndValidatesStoredIdentities(t *testing.T) {
	s, g, ctx, _, _, _ := approvalFixture(t)
	app := object{"id": "app-1", "name": "Fixture", "identity": "fixture:stable"}
	done := make(chan error, 2)
	for range 2 {
		go func() { done <- s.authorizeComputerApp(ctx, g.topicID, g.computerTaskID, 1, app) }()
	}
	pending := pendingApproval(t, s)
	if !respondApproval(t, s, text(pending["approvalId"]), "session") {
		t.Fatal("shared response rejected")
	}
	for range 2 {
		if err := awaitApprovalOpen(t, done); err != nil {
			t.Fatal(err)
		}
	}
	for _, value := range []any{"fixture:stable", []any{""}, []any{"same", "same"}, []any{42}} {
		if _, err, _ := s.invoke("preference:set", []any{approvedComputerAppsPreference, value}); err == nil {
			t.Fatal("invalid approved identity preferences accepted", value)
		}
	}
}
