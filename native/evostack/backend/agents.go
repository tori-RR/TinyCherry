package main

import (
	"database/sql"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

const agentTopicPrefix = "agent-session:"

func agentSessionID(topic string) string { return strings.TrimPrefix(topic, agentTopicPrefix) }
func isAgentTopic(topic string) bool     { return strings.HasPrefix(topic, agentTopicPrefix) }

func agentPermissionMode(agent object) string {
	mode := text(obj(agent["configuration"])["permission_mode"])
	if mode == "" {
		return "default"
	}
	return mode
}

func (s *server) validateNativeAgent(agent object) error {
	if agent["type"] != "native" {
		return errors.New("this desktop supports TinyCherry Native agents")
	}
	if name := strings.TrimSpace(text(agent["name"])); name == "" || utf8.RuneCountInString(name) > 255 {
		return errors.New("agent name must contain 1–255 characters")
	}
	if len(text(agent["instructions"])) > 65536 || len(text(agent["description"])) > 4096 {
		return errors.New("agent instructions or description are too long")
	}
	if mode := agentPermissionMode(agent); mode != "default" && mode != "plan" {
		return errors.New("native agents support only default (approve changes) and plan (read only) permissions")
	}
	configuration := obj(agent["configuration"])
	if len(array(agent["mcps"])) > 0 || len(obj(configuration["env_vars"])) > 0 || configuration["scheduler_enabled"] == true || configuration["heartbeat_enabled"] == true {
		return notMigrated("native agent MCP, environment overrides or scheduled tasks")
	}
	for _, key := range []string{"model", "planModel", "smallModel"} {
		id := text(agent[key])
		if id == "" && key == "model" {
			return errors.New("select a model for this agent")
		}
		if id != "" {
			if _, err := s.store.get("models", id); err != nil {
				return fmt.Errorf("agent %s: %w", key, err)
			}
		}
	}
	if len(array(agent["knowledgeBaseIds"])) > 10 {
		return errors.New("select at most 10 knowledge bases")
	}
	for _, id := range array(agent["knowledgeBaseIds"]) {
		if _, err := s.store.get("knowledge-bases", text(id)); err != nil {
			return err
		}
	}
	for _, name := range array(agent["disabledTools"]) {
		if _, ok := nativeAgentToolSchema(text(name)); !ok {
			return errors.New("unknown native agent tool")
		}
	}
	return nil
}

func (s *server) agentEntity(row object) object {
	result := clone(row)
	result["modelName"] = nil
	if model, err := s.store.get("models", text(row["model"])); err == nil {
		result["modelName"] = model["name"]
	} else {
		result["model"] = nil
	}
	return result
}

func (s *server) agentSessionEntity(row object) (object, error) {
	workspace, err := s.store.get("agent-workspaces", text(row["workspaceId"]))
	if err != nil {
		return nil, err
	}
	result := clone(row)
	delete(result, "activeNodeId")
	result["workspace"] = workspace
	return result, nil
}

func (s *server) newAgent(input object) (object, error) {
	if len(array(input["skillIds"])) > 0 {
		return nil, notMigrated("native agent skill bindings")
	}
	now := timestamp()
	row := object{"id": newID(), "type": input["type"], "name": strings.TrimSpace(text(input["name"])), "model": input["model"], "configuration": object{"permission_mode": "default"}, "mcps": []any{}, "disabledTools": []any{}, "knowledgeBaseIds": []any{}, "createdAt": now, "updatedAt": now, "orderKey": now + newID()}
	for _, key := range []string{"description", "instructions", "planModel", "smallModel", "configuration", "mcps", "disabledTools", "knowledgeBaseIds"} {
		if value, ok := input[key]; ok {
			row[key] = value
		}
	}
	if err := s.validateNativeAgent(row); err != nil {
		return nil, err
	}
	if err := s.store.put("agents", row); err != nil {
		return nil, err
	}
	return s.agentEntity(row), nil
}

func (s *server) registerAgentWorkspace(path, name string) (object, error) {
	if !filepath.IsAbs(path) {
		return nil, errors.New("workspace must be an absolute directory selected by the user")
	}
	resolved, err := filepath.EvalSymlinks(filepath.Clean(path))
	if err != nil {
		return nil, err
	}
	root, err := os.OpenRoot(resolved)
	if err != nil {
		return nil, err
	}
	root.Close()
	rows, err := s.store.list("agent-workspaces")
	if err != nil {
		return nil, err
	}
	for _, row := range rows {
		if row["path"] == resolved && row["type"] == "user" {
			return row, nil
		}
	}
	if strings.TrimSpace(name) == "" {
		name = filepath.Base(resolved)
	}
	now := timestamp()
	row := object{"id": newID(), "name": name, "path": resolved, "type": "user", "orderKey": now + newID(), "createdAt": now, "updatedAt": now}
	return row, s.store.put("agent-workspaces", row)
}

func (s *server) agentWorkspace(source object) (object, error) {
	if source["type"] == "user" {
		workspace, err := s.store.get("agent-workspaces", text(source["workspaceId"]))
		if err != nil {
			return nil, err
		}
		if workspace["type"] != "user" {
			return nil, errors.New("select a registered user workspace")
		}
		return workspace, nil
	}
	if source["type"] != "system" {
		return nil, errors.New("select a workspace")
	}
	id, now := newID(), timestamp()
	path := filepath.Join(s.store.directory, "agent-workspaces", id)
	if err := os.MkdirAll(path, 0700); err != nil {
		return nil, err
	}
	row := object{"id": id, "name": "Workspace " + id[:8], "path": path, "type": "system", "orderKey": now + id, "createdAt": now, "updatedAt": now}
	return row, s.store.put("agent-workspaces", row)
}

func (s *server) newAgentSession(input object) (object, error) {
	agent, err := s.store.get("agents", text(input["agentId"]))
	if err != nil {
		return nil, err
	}
	if agent["deletedAt"] != nil {
		return nil, errors.New("agent is archived")
	}
	if utf8.RuneCountInString(text(input["name"])) > 255 {
		return nil, errors.New("session name is too long")
	}
	workspace, err := s.agentWorkspace(obj(input["workspace"]))
	if err != nil {
		return nil, err
	}
	now := timestamp()
	row := object{"id": newID(), "agentId": agent["id"], "name": text(input["name"]), "isNameManuallyEdited": text(input["name"]) != "", "workspaceId": workspace["id"], "orderKey": now + newID(), "lastActivityAt": now, "createdAt": now, "updatedAt": now}
	if description, ok := input["description"]; ok {
		row["description"] = description
	}
	if err := s.store.put("agent-sessions", row); err != nil {
		return nil, err
	}
	return s.agentSessionEntity(row)
}

func (s *server) agentRows(resource string, query object) ([]object, error) {
	rows, err := s.store.list(resource)
	if err != nil {
		return nil, err
	}
	result := []object{}
	for _, row := range rows {
		if (row["deletedAt"] != nil) != (query["inTrash"] == true) {
			continue
		}
		if id := text(query["agentId"]); id != "" && row["agentId"] != id {
			continue
		}
		if id := text(query["workspaceId"]); id != "" && row["workspaceId"] != id {
			continue
		}
		if ids := array(query["ids"]); len(ids) > 0 && !contains(ids, text(row["id"])) {
			continue
		}
		if search := strings.ToLower(text(query["search"])); search != "" && !strings.Contains(strings.ToLower(text(row["name"])+" "+text(row["description"])), search) {
			continue
		}
		if role := text(query["builtinRole"]); role != "" && obj(row["configuration"])["builtin_role"] != role {
			continue
		}
		result = append(result, row)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if resource == "agent-sessions" {
			return text(result[i]["lastActivityAt"])+text(result[i]["id"]) > text(result[j]["lastActivityAt"])+text(result[j]["id"])
		}
		return text(result[i]["orderKey"]) < text(result[j]["orderKey"])
	})
	return result, nil
}

func (s *server) agentData(method, path string, query object, body any) (any, error, bool) {
	resource := strings.Split(strings.Trim(path, "/"), "/")[0]
	if resource != "agents" && resource != "agent-sessions" && resource != "agent-workspaces" {
		return nil, nil, false
	}
	value, err := s.agentRoute(method, path, query, obj(body))
	return value, err, true
}

func (s *server) agentRoute(method, path string, query, input object) (any, error) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	for i, part := range parts {
		decoded, err := url.PathUnescape(part)
		if err != nil {
			return nil, err
		}
		parts[i] = decoded
	}
	resource := parts[0]
	if len(parts) == 1 {
		if method == "POST" && resource == "agent-sessions" {
			return s.newAgentSession(input)
		}
		if method != "GET" {
			return nil, notMigrated(method + " " + path)
		}
		rows, err := s.agentRows(resource, query)
		if err != nil {
			return nil, err
		}
		switch resource {
		case "agents":
			limit, page := min(number(query["limit"], 100), 500), number(query["page"], 1)
			start := min((page-1)*limit, len(rows))
			items := []object{}
			for _, row := range rows[start:min(start+limit, len(rows))] {
				items = append(items, s.agentEntity(row))
			}
			return object{"items": items, "total": len(rows), "page": page}, nil
		case "agent-sessions":
			items := []object{}
			for _, row := range rows {
				item, err := s.agentSessionEntity(row)
				if err != nil {
					return nil, err
				}
				items = append(items, item)
			}
			return paginate(items, query), nil
		default:
			return rows, nil
		}
	}
	if resource == "agent-sessions" && parts[1] == "latest" && method == "GET" {
		rows, err := s.agentRows(resource, query)
		if err != nil {
			return nil, err
		}
		if len(rows) == 0 {
			return object{"session": nil}, nil
		}
		row, err := s.agentSessionEntity(rows[0])
		return object{"session": row}, err
	}
	row, err := s.store.get(resource, parts[1])
	if err != nil {
		return nil, err
	}
	if len(parts) >= 3 {
		if resource == "agent-sessions" && parts[2] == "messages" {
			return s.agentMessageRoute(method, row, parts[3:], query)
		}
		if resource == "agent-workspaces" && parts[2] == "references" && method == "GET" {
			rows, err := s.agentRows("agent-sessions", object{"workspaceId": row["id"]})
			if err != nil {
				return nil, err
			}
			items := []object{}
			for _, session := range rows {
				items = append(items, object{"id": session["id"], "name": session["name"]})
			}
			return object{"sessions": object{"items": items, "total": len(items)}, "channels": object{"items": []any{}, "total": 0}, "tasks": object{"items": []any{}, "total": 0}}, nil
		}
		if resource == "agent-sessions" && parts[2] == "workspace" && method == "PUT" {
			messages, err := s.agentMessageRows(text(row["id"]))
			if err != nil {
				return nil, err
			}
			if len(messages) != 0 || s.active[agentTopicPrefix+text(row["id"])] != nil {
				return nil, errors.New("a started session cannot change its workspace")
			}
			workspace, err := s.agentWorkspace(input)
			if err != nil {
				return nil, err
			}
			row["workspaceId"], row["updatedAt"] = workspace["id"], timestamp()
			if err := s.store.put(resource, row); err != nil {
				return nil, err
			}
			return s.agentSessionEntity(row)
		}
		return nil, notMigrated(method + " " + path)
	}
	if method == "PATCH" {
		allowed := map[string]bool{}
		switch resource {
		case "agents":
			for _, key := range []string{"name", "description", "instructions", "model", "planModel", "smallModel", "mcps", "knowledgeBaseIds", "disabledTools", "configuration"} {
				allowed[key] = true
			}
		case "agent-sessions":
			for _, key := range []string{"name", "isNameManuallyEdited", "description", "agentId"} {
				allowed[key] = true
			}
		default:
			allowed["name"] = true
		}
		for key, value := range input {
			if !allowed[key] {
				return nil, errors.New("unsupported agent update field")
			}
			if key == "configuration" {
				configuration := clone(obj(row[key]))
				for k, v := range obj(value) {
					configuration[k] = v
				}
				row[key] = configuration
			} else {
				row[key] = value
			}
		}
		if utf8.RuneCountInString(text(row["name"])) > 255 || (resource != "agent-sessions" && strings.TrimSpace(text(row["name"])) == "") {
			return nil, errors.New("invalid name")
		}
		if resource == "agents" {
			if err := s.validateNativeAgent(row); err != nil {
				return nil, err
			}
		}
		if resource == "agent-sessions" && input["agentId"] != nil {
			if s.active[agentTopicPrefix+text(row["id"])] != nil {
				return nil, errors.New("stop the session before changing its agent")
			}
			agent, err := s.store.get("agents", text(row["agentId"]))
			if err != nil {
				return nil, err
			}
			if agent["deletedAt"] != nil {
				return nil, errors.New("agent is archived")
			}
		}
		row["updatedAt"] = timestamp()
		if err := s.store.put(resource, row); err != nil {
			return nil, err
		}
	} else if method != "GET" {
		return nil, notMigrated(method + " " + path)
	}
	if resource == "agents" {
		return s.agentEntity(row), nil
	}
	if resource == "agent-sessions" {
		return s.agentSessionEntity(row)
	}
	return row, nil
}

func (s *server) agentChanged() {
	s.changed("/agents", "/agents/:agentId", "/agent-sessions", "/agent-sessions/:sessionId", "/agent-sessions/latest", "/agent-sessions/:sessionId/messages", "/agent-workspaces")
}

func (s *server) nativeAgentCommand(route string, input object) (any, error, bool) {
	if route == "ai.tool.respond_approval" {
		value, err := s.respondAgentApproval(input)
		return value, err, true
	}
	if !strings.HasPrefix(route, "ai.agent.") {
		return nil, nil, false
	}
	var value any
	err := s.transaction(func(tx *server) error {
		var err error
		value, err = tx.agentCommand(route, input)
		return err
	})
	if err == nil {
		s.agentChanged()
	}
	return value, err, true
}

func (s *server) agentCommand(route string, input object) (any, error) {
	switch route {
	case "ai.agent.create":
		return s.newAgent(input)
	case "ai.agent.workspace.register":
		return s.registerAgentWorkspace(text(input["path"]), text(input["name"]))
	case "ai.agent.session.prewarm", "ai.agent.session.close_warm", "ai.agent.session.refresh_context_usage", "ai.agent.session.set_pending_input_count":
		_, err := s.store.get("agent-sessions", text(input["sessionId"]))
		return nil, err
	case "ai.agent.session.reuse_or_create":
		rows, err := s.agentRows("agent-sessions", object{"agentId": input["agentId"]})
		if err != nil {
			return nil, err
		}
		source := obj(input["workspace"])
		for _, row := range rows {
			if row["id"] == input["excludeSessionId"] {
				continue
			}
			workspace, err := s.store.get("agent-workspaces", text(row["workspaceId"]))
			if err != nil {
				return nil, err
			}
			if workspace["type"] != source["type"] || (source["type"] == "user" && workspace["id"] != source["workspaceId"]) {
				continue
			}
			messages, err := s.agentMessageRows(text(row["id"]))
			if err != nil {
				return nil, err
			}
			if len(messages) == 0 {
				entity, err := s.agentSessionEntity(row)
				return object{"session": entity, "created": false, "deletedDuplicateSessionIds": []any{}}, err
			}
		}
		row, err := s.newAgentSession(object{"agentId": input["agentId"], "name": "", "workspace": source})
		return object{"session": row, "created": true, "deletedDuplicateSessionIds": []any{}}, err
	case "ai.agent.restore", "ai.agent.session.restore":
		resource, id := "agents", text(input["agentId"])
		if route == "ai.agent.session.restore" {
			resource, id = "agent-sessions", text(input["sessionId"])
		}
		row, err := s.store.get(resource, id)
		if err != nil {
			return nil, err
		}
		delete(row, "deletedAt")
		row["updatedAt"] = timestamp()
		if err := s.store.put(resource, row); err != nil {
			return nil, err
		}
		if resource == "agents" {
			return s.agentEntity(row), nil
		}
		return s.agentSessionEntity(row)
	case "ai.agent.session.delete", "ai.agent.sessions.delete":
		if input["permanent"] == true {
			return nil, notMigrated("permanent native session deletion; archive instead")
		}
		ids := array(input["sessionIds"])
		if route == "ai.agent.sessions.delete" {
			rows, err := s.agentRows("agent-sessions", object{"agentId": input["agentId"]})
			if err != nil {
				return nil, err
			}
			for _, row := range rows {
				ids = append(ids, row["id"])
			}
		}
		if len(ids) > 200 {
			return nil, errors.New("too many sessions")
		}
		for _, id := range ids {
			if err := s.archiveAgentSession(text(id)); err != nil {
				return nil, err
			}
		}
		return object{"deletedIds": ids}, nil
	case "ai.agent.delete":
		if input["permanent"] == true {
			return nil, notMigrated("permanent native agent deletion; archive instead")
		}
		row, err := s.store.get("agents", text(input["agentId"]))
		if err != nil {
			return nil, err
		}
		sessions, err := s.agentRows("agent-sessions", object{"agentId": row["id"]})
		if err != nil {
			return nil, err
		}
		ids := []any{}
		for _, session := range sessions {
			if s.active[agentTopicPrefix+text(session["id"])] != nil {
				return nil, errors.New("stop active sessions before archiving the agent")
			}
			if input["deleteSessions"] == true {
				if err := s.archiveAgentSession(text(session["id"])); err != nil {
					return nil, err
				}
				ids = append(ids, session["id"])
			}
		}
		row["deletedAt"], row["updatedAt"] = timestamp(), timestamp()
		return object{"deleted": true, "deletedSessionIds": ids}, s.store.put("agents", row)
	case "ai.agent.workspace.delete":
		id := text(input["workspaceId"])
		if _, err := s.store.get("agent-workspaces", id); err != nil {
			return nil, err
		}
		rows, err := s.store.list("agent-sessions")
		if err != nil {
			return nil, err
		}
		for _, row := range rows {
			if row["workspaceId"] == id {
				return nil, errors.New("workspace is still referenced by a session, including archived sessions")
			}
		}
		// Removing registration never deletes the user's directory or generated work.
		return object{"deletedIds": []any{id}}, s.store.delete("agent-workspaces", id)
	default:
		return nil, notMigrated(route)
	}
}

func (s *server) archiveAgentSession(id string) error {
	if s.active[agentTopicPrefix+id] != nil {
		return errors.New("stop the session before archiving it")
	}
	row, err := s.store.get("agent-sessions", id)
	if err != nil {
		return err
	}
	row["deletedAt"], row["updatedAt"] = timestamp(), timestamp()
	return s.store.put("agent-sessions", row)
}

func (s *server) agentMessageRows(id string) ([]object, error) {
	return s.store.entities("SELECT body FROM entity WHERE resource='agent-messages' AND json_extract(body,'$.sessionId')=? ORDER BY rowid", id)
}

func agentMessageEntity(row object) object {
	result := clone(row)
	delete(result, "parentId")
	delete(result, "requestId")
	return result
}

func (s *server) agentMessageRoute(method string, session object, tail []string, query object) (any, error) {
	if method != "GET" {
		return nil, notMigrated("native agent message mutation")
	}
	rows, err := s.agentMessageRows(text(session["id"]))
	if err != nil {
		return nil, err
	}
	if len(tail) > 0 {
		for _, row := range rows {
			if row["id"] == tail[0] {
				return agentMessageEntity(row), nil
			}
		}
		return nil, sql.ErrNoRows
	}
	items := []object{}
	for i := len(rows) - 1; i >= 0; i-- {
		items = append(items, agentMessageEntity(rows[i]))
	}
	start := 0
	if cursor := text(query["cursor"]); cursor != "" {
		start = len(items)
		for i, item := range items {
			if item["id"] == cursor {
				start = i + 1
				break
			}
		}
	}
	page, bytes := []object{}, 512
	end := start
	limit := min(number(query["limit"], 50), 200)
	for end < len(items) && len(page) < limit {
		encoded, err := json.Marshal(items[end])
		if err != nil {
			return nil, err
		}
		if bytes+len(encoded)+1 > maxFrame-8192 {
			if len(page) == 0 {
				return nil, errors.New("agent message exceeds the desktop IPC budget")
			}
			break
		}
		page = append(page, items[end])
		bytes += len(encoded) + 1
		end++
	}
	result := object{"items": page}
	if end < len(items) && end > start {
		result["nextCursor"] = items[end-1]["id"]
	}
	return result, nil
}
