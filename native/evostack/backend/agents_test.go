package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func seedAgent(t *testing.T, s *server, base, mode string) (object, object) {
	t.Helper()
	seedChat(t, s, base)
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err, _ := s.nativeAgentCommand("ai.agent.create", object{"type": "native", "name": "Workspace agent", "model": "test::local", "instructions": "Complete the requested task and verify the result.", "configuration": object{"permission_mode": mode}})
	if err != nil {
		t.Fatal(err)
	}
	agent := obj(value)
	var session object
	err = s.transaction(func(tx *server) error {
		var err error
		session, err = tx.newAgentSession(object{"agentId": agent["id"], "name": "", "workspace": object{"type": "system"}})
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return agent, session
}

func agentSubmit(session object) object {
	return object{"topicId": agentTopicPrefix + text(session["id"]), "requestId": newID(), "trigger": "submit-message", "userMessageParts": []any{object{"type": "text", "text": "Write a greeting in the workspace and verify it."}}}
}

func launchAgent(t *testing.T, s *server, input object) *generation {
	t.Helper()
	s.mu.Lock()
	_, err, after := s.openGeneration(input)
	g := s.active[text(input["topicId"])]
	s.mu.Unlock()
	if err != nil {
		t.Fatal(err)
	}
	if after == nil || g == nil {
		t.Fatal("agent turn was not started")
	}
	after()
	return g
}

func waitAgentApproval(t *testing.T, s *server, g *generation) string {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		s.mu.Lock()
		for id, pending := range s.agentApprovals {
			if pending.generation == g {
				s.mu.Unlock()
				return id
			}
		}
		s.mu.Unlock()
		select {
		case <-g.done:
			t.Fatal("agent finished before requesting approval", g.row["data"])
		default:
		}
		time.Sleep(5 * time.Millisecond)
	}
	t.Fatal("agent approval did not arrive")
	return ""
}

func decideAgent(t *testing.T, s *server, id string, approved bool) object {
	t.Helper()
	s.mu.Lock()
	defer s.mu.Unlock()
	value, err := s.respondAgentApproval(object{"approvalId": id, "approved": approved})
	if err != nil {
		t.Fatal(err)
	}
	return obj(value)
}

func TestNativeAgentExecutesApprovedToolsAndPersistsIndependentSession(t *testing.T) {
	var requests atomic.Int32
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body object
		if err := json.NewDecoder(r.Body).Decode(&body); err != nil {
			t.Error(err)
		}
		if len(array(body["tools"])) != 6 || body["parallel_tool_calls"] != false {
			t.Error("native workspace tools were not supplied sequentially")
		}
		switch requests.Add(1) {
		case 1:
			writeChatTool(w, "call-list", "list_files", `{"path":"."}`, true)
		case 2:
			writeChatTool(w, "call-write", "write_file", `{"path":"notes/hello.txt","content":"Hello 主人"}`, true)
		case 3:
			writeChatTool(w, "call-read", "read_file", `{"path":"notes/hello.txt"}`, true)
		default:
			messages := array(body["messages"])
			if !strings.Contains(text(obj(messages[len(messages)-1])["content"]), "Hello 主人") {
				t.Error("verified file content was not returned to the model")
			}
			writeChatText(w, "已写入并读回核对。")
		}
	}))
	defer endpoint.Close()
	s, directory := testServer(t)
	_, session := seedAgent(t, s, endpoint.URL, "default")
	input := agentSubmit(session)
	g := launchAgent(t, s, input)
	approval := waitAgentApproval(t, s, g)
	path := filepath.Join(text(obj(session["workspace"])["path"]), "notes", "hello.txt")
	if _, err := os.Stat(path); !os.IsNotExist(err) {
		t.Fatal("file changed before approval")
	}
	s.mu.Lock()
	wrong, err := s.respondAgentApproval(object{"approvalId": approval, "approved": true, "topicId": "another-session"})
	baseline, projectionErr := s.projectionCommand("ai.projection.attach", object{"target": object{"kind": "topic", "topicId": input["topicId"]}, "subscriptionId": newID()})
	s.mu.Unlock()
	if err != nil || obj(wrong)["ok"] != false {
		t.Fatal("cross-session approval was accepted")
	}
	if projectionErr != nil || len(array(obj(baseline)["messages"])) != 1 {
		t.Fatal("agent projection did not attach", projectionErr)
	}
	if decideAgent(t, s, approval, true)["ok"] != true || decideAgent(t, s, approval, true)["ok"] != false {
		t.Fatal("approval was not single use")
	}
	waitDone(t, g)
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "Hello 主人" {
		t.Fatal("approved file did not persist", err)
	}
	if g.row["status"] != "success" || g.answer != "已写入并读回核对。" {
		t.Fatal("agent did not finish", g.row)
	}
	s.mu.Lock()
	rows, err := s.agentMessageRows(text(session["id"]))
	topics, topicErr := s.store.list("topics")
	again, repeatErr, after := s.openGeneration(input)
	changed := clone(input)
	changed["userMessageParts"] = []any{object{"type": "text", "text": "different action"}}
	_, conflictErr, _ := s.openGeneration(changed)
	s.mu.Unlock()
	if err != nil || len(rows) != 2 || topicErr != nil || len(topics) != 1 {
		t.Fatal("agent history leaked into ordinary topics", err, topicErr)
	}
	if repeatErr != nil || after != nil || len(array(clone(obj(again))["reservedMessages"])) != 2 || requests.Load() != 4 {
		t.Fatal("retry replayed an agent action", repeatErr)
	}
	if conflictErr == nil {
		t.Fatal("same requestId accepted different content")
	}
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	persisted, err := reopened.get("agent-messages", text(g.row["id"]))
	if err != nil || persisted["status"] != "success" || len(array(obj(persisted["data"])["parts"])) < 4 {
		t.Fatal("agent tool history did not survive reopen", err)
	}
}

func TestNativeAgentDenialAndAbortNeverPerformPendingWrite(t *testing.T) {
	for _, action := range []string{"deny", "abort"} {
		t.Run(action, func(t *testing.T) {
			var requests atomic.Int32
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if requests.Add(1) == 1 {
					writeChatTool(w, "call-write", "write_file", `{"path":"should-not-exist","content":"no"}`, true)
				} else {
					writeChatText(w, "已停止。")
				}
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			_, session := seedAgent(t, s, endpoint.URL, "default")
			g := launchAgent(t, s, agentSubmit(session))
			id := waitAgentApproval(t, s, g)
			if action == "deny" {
				decideAgent(t, s, id, false)
			} else {
				start := time.Now()
				if err := s.abort(g.topicID); err != nil {
					t.Fatal(err)
				}
				if time.Since(start) > time.Second {
					t.Fatal("abort waited on unresolved user approval")
				}
			}
			waitDone(t, g)
			if _, err := os.Stat(filepath.Join(text(obj(session["workspace"])["path"]), "should-not-exist")); !os.IsNotExist(err) {
				t.Fatal("unapproved write was performed")
			}
			if decideAgent(t, s, id, true)["ok"] != false {
				t.Fatal("stale approval remained executable")
			}
			if action == "abort" && (g.row["status"] != "paused" || requests.Load() != 1) {
				t.Fatal("abort resumed the model or lost paused history")
			}
		})
	}
}

func TestNativeAgentPlanModeAndDisabledToolsAreEnforcedInBackend(t *testing.T) {
	for _, mode := range []string{"plan", "disabled"} {
		t.Run(mode, func(t *testing.T) {
			endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				var body object
				_ = json.NewDecoder(r.Body).Decode(&body)
				for _, value := range array(body["tools"]) {
					if obj(obj(value)["function"])["name"] == "write_file" {
						t.Error("prohibited write tool was advertised")
					}
				}
				writeChatTool(w, "call-write", "write_file", `{"path":"forbidden","content":"no"}`, true)
			}))
			defer endpoint.Close()
			s, _ := testServer(t)
			permission := mode
			if mode == "disabled" {
				permission = "default"
			}
			agent, session := seedAgent(t, s, endpoint.URL, permission)
			if mode == "disabled" {
				s.mu.Lock()
				_, err := s.agentRoute("PATCH", "/agents/"+text(agent["id"]), object{}, object{"disabledTools": []any{"write_file"}})
				s.mu.Unlock()
				if err != nil {
					t.Fatal(err)
				}
			}
			g := launchAgent(t, s, agentSubmit(session))
			waitDone(t, g)
			if g.row["status"] != "error" {
				t.Fatal("prohibited provider tool call was accepted")
			}
			if _, err := os.Stat(filepath.Join(text(obj(session["workspace"])["path"]), "forbidden")); !os.IsNotExist(err) {
				t.Fatal("prohibited tool changed a file")
			}
		})
	}
}

func TestNativeAgentWorkspaceRejectsTraversalSymlinksAndStaleEdits(t *testing.T) {
	workspace, outside := t.TempDir(), t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.txt"), []byte("private"), 0600); err != nil {
		t.Fatal(err)
	}
	root, err := os.OpenRoot(workspace)
	if err != nil {
		t.Fatal(err)
	}
	defer root.Close()
	if _, err := agentLocalPath("../secret.txt"); err == nil {
		t.Fatal("relative escape allowed")
	}
	if _, err := agentLocalPath(filepath.Join(outside, "secret.txt")); err == nil {
		t.Fatal("absolute escape allowed")
	}
	if err := os.Symlink(outside, filepath.Join(workspace, "escape")); err == nil {
		if _, _, err := readAgentFile(root, filepath.Join("escape", "secret.txt")); err == nil {
			t.Fatal("symlink escaped workspace")
		}
		if _, err := prepareAgentEdit(root, "write_file", object{"path": "escape/created.txt", "content": "no"}); err == nil {
			t.Fatal("write through symlink escaped workspace")
		}
	}
	if err := root.WriteFile("note.txt", []byte("before"), 0600); err != nil {
		t.Fatal(err)
	}
	edit, err := prepareAgentEdit(root, "edit_file", object{"path": "note.txt", "old_text": "before", "new_text": "after"})
	if err != nil {
		t.Fatal(err)
	}
	if err := root.WriteFile("note.txt", []byte("user changed this"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := applyAgentEdit(root, edit); err == nil {
		t.Fatal("stale approved edit overwrote a concurrent user change")
	}
}

func TestNativeAgentShellIsApprovedAndCancellationStopsDescendants(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix process-group fixture; Windows path is cross-compiled")
	}
	endpoint := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		writeChatTool(w, "call-shell", "run_shell", `{"command":"printf started > started; sleep 5; printf done > done","timeout_seconds":30}`, true)
	}))
	defer endpoint.Close()
	s, _ := testServer(t)
	_, session := seedAgent(t, s, endpoint.URL, "default")
	path := text(obj(session["workspace"])["path"])
	g := launchAgent(t, s, agentSubmit(session))
	id := waitAgentApproval(t, s, g)
	if _, err := os.Stat(filepath.Join(path, "started")); !os.IsNotExist(err) {
		t.Fatal("shell ran before approval")
	}
	decideAgent(t, s, id, true)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filepath.Join(path, "started")); err == nil {
			break
		}
		time.Sleep(5 * time.Millisecond)
	}
	if _, err := os.Stat(filepath.Join(path, "started")); err != nil {
		t.Fatal("approved shell did not start")
	}
	start := time.Now()
	if err := s.abort(g.topicID); err != nil {
		t.Fatal(err)
	}
	waitDone(t, g)
	if time.Since(start) > time.Second {
		t.Fatal("shell cancellation did not stop the process group promptly")
	}
	if _, err := os.Stat(filepath.Join(path, "done")); !os.IsNotExist(err) {
		t.Fatal("stopped shell completed its remaining command")
	}
}

func TestNativeAgentRecoveryMarksPendingToolsUncertainWithoutReplay(t *testing.T) {
	s, directory := testServer(t)
	_, session := seedAgent(t, s, "http://localhost:1", "default")
	id := newID()
	row := object{"id": id, "sessionId": session["id"], "role": "assistant", "status": "pending", "data": object{"parts": []any{object{"type": "dynamic-tool", "toolName": "run_shell", "toolCallId": "crashed-call", "state": "input-available", "input": object{"command": "unconfirmed"}}}}}
	if err := s.store.put("agent-messages", row); err != nil {
		t.Fatal(err)
	}
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	row, err = reopened.get("agent-messages", id)
	if err != nil || row["status"] != "error" {
		t.Fatal("interrupted agent was not recovered", err)
	}
	part := obj(array(obj(row["data"])["parts"])[0])
	if part["state"] != "output-error" || !strings.Contains(text(part["errorText"]), "unconfirmed") {
		t.Fatal("unfinished tool was not marked uncertain", part)
	}
}

func TestNativeAgentShellOutputAndDurationAreBounded(t *testing.T) {
	if runtime.GOOS == "windows" {
		t.Skip("Unix shell fixture")
	}
	result, err := runAgentShell(context.Background(), t.TempDir(), ".", object{"command": "printf hello", "timeout_seconds": float64(1)})
	if err != nil || result["output"] != "hello" || result["exitCode"] != 0 {
		t.Fatal("shell output failed", result, err)
	}
	var buffer agentCommandOutput
	content := []byte(strings.Repeat("x", maxAgentToolOutput+1000))
	n, err := buffer.Write(content)
	if err != nil || n != len(content) || !buffer.truncated || len(buffer.value) != maxAgentToolOutput {
		t.Fatal("shell output was not bounded")
	}
}

func TestNativeAgentArchiveRestoreKeepsWorkspaceAndHistory(t *testing.T) {
	s, _ := testServer(t)
	agent, session := seedAgent(t, s, "http://localhost:1", "default")
	workspace := obj(session["workspace"])
	path := filepath.Join(text(workspace["path"]), "saved.txt")
	if err := os.WriteFile(path, []byte("keep my work"), 0600); err != nil {
		t.Fatal(err)
	}
	message := object{"id": newID(), "sessionId": session["id"], "role": "user", "status": "success", "data": object{"parts": []any{object{"type": "text", "text": "saved history"}}}}
	if err := s.store.put("agent-messages", message); err != nil {
		t.Fatal(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	if _, err := s.agentRoute("PATCH", "/agents/"+text(agent["id"]), object{}, object{"configuration": object{"permission_mode": "bypassPermissions"}}); err == nil {
		t.Fatal("agent accepted automatic permission bypass")
	}
	value, err, _ := s.nativeAgentCommand("ai.agent.session.delete", object{"sessionIds": []any{session["id"]}})
	if err != nil || len(array(clone(obj(value))["deletedIds"])) != 1 {
		t.Fatal("session did not archive", err)
	}
	listed, err := s.agentRows("agent-sessions", object{"inTrash": true})
	if err != nil || len(listed) != 1 {
		t.Fatal("archive is not visible", err)
	}
	if _, err, _ := s.nativeAgentCommand("ai.agent.workspace.delete", object{"workspaceId": workspace["id"]}); err == nil {
		t.Fatal("archived session lost its workspace registration")
	}
	if _, err, _ := s.nativeAgentCommand("ai.agent.session.restore", object{"sessionId": session["id"]}); err != nil {
		t.Fatal(err)
	}
	if _, err, _ := s.nativeAgentCommand("ai.agent.delete", object{"agentId": agent["id"], "deleteSessions": false}); err != nil {
		t.Fatal(err)
	}
	if _, err, _ := s.nativeAgentCommand("ai.agent.restore", object{"agentId": agent["id"]}); err != nil {
		t.Fatal(err)
	}
	history, err := s.agentMessageRows(text(session["id"]))
	if err != nil || len(history) != 1 {
		t.Fatal("archive removed history", err)
	}
	data, err := os.ReadFile(path)
	if err != nil || string(data) != "keep my work" {
		t.Fatal("archive removed workspace data", err)
	}
	entity, err := s.agentRoute("GET", "/agent-sessions/"+text(session["id"]), object{}, nil)
	if err != nil || obj(entity)["workspace"] == nil || obj(entity)["deletedAt"] != nil {
		t.Fatal("restored session DTO is invalid", err)
	}
}

func TestNativeAgentHistoryPaginationRespectsDesktopFrameBudget(t *testing.T) {
	s, _ := testServer(t)
	_, session := seedAgent(t, s, "http://localhost:1", "default")
	for i := 0; i < 4; i++ {
		row := object{"id": newID(), "sessionId": session["id"], "role": "assistant", "status": "success", "data": object{"parts": []any{object{"type": "text", "text": strings.Repeat("x", 1200*1024)}}}}
		if err := s.store.put("agent-messages", row); err != nil {
			t.Fatal(err)
		}
	}
	first, err := s.agentMessageRoute("GET", session, nil, object{"limit": float64(50)})
	if err != nil {
		t.Fatal(err)
	}
	page := clone(obj(first))
	if len(array(page["items"])) != 3 || text(page["nextCursor"]) == "" {
		t.Fatal("large history was not paginated by encoded byte size")
	}
	if size, err := wireEncodedSize(first); err != nil || size > maxFrame-8192 {
		t.Fatal("history exceeds the desktop IPC frame", size, err)
	}
	second, err := s.agentMessageRoute("GET", session, nil, object{"cursor": page["nextCursor"], "limit": float64(50)})
	if err != nil || len(array(clone(obj(second))["items"])) != 1 || obj(second)["nextCursor"] != nil {
		t.Fatal("large history cursor skipped or repeated messages", err)
	}
}
