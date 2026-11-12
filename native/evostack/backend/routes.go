package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"
	"sort"
	"strings"
)

func argument(args []any, index int) any {
	if index < len(args) {
		return args[index]
	}
	return nil
}
func notMigrated(name string) error { return fmt.Errorf("EVOSTACK_NOT_MIGRATED: %s", name) }

func (s *server) invoke(channel string, args []any) (any, error, func()) {
	if channel == "preference:set" || channel == "preference:set-multiple" {
		return s.setPreferences(channel, args)
	}
	if channel == "ipc-api:request" {
		route := text(argument(args, 0))
		input := obj(argument(args, 1))
		if route == "ai.provider.model.list" || route == "ai.provider.model.check" {
			result, err := s.modelOperation(route, input)
			return ipcResult(result, err), nil, nil
		}
		if route == "proxy.test_connection" {
			result, err := s.testProxyConnection(input)
			return ipcResult(result, err), nil, nil
		}
		if route == "ai.stream.abort" {
			err := s.abort(text(input["topicId"]))
			return ipcResult(nil, err), nil, nil
		}
		if strings.HasPrefix(route, "knowledge.") {
			if result, err, handled := s.knowledgeFileCommand(route, input); handled {
				return ipcResult(result, err), nil, nil
			}
			result, err, handled := s.knowledgeCommand(route, input)
			if !handled {
				err = notMigrated(route)
			}
			return ipcResult(result, err), nil, nil
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	switch channel {
	case "ipc-api:request":
		route := text(argument(args, 0))
		input := argument(args, 1)
		result, err, after := s.command(route, input)
		return ipcResult(result, err), nil, after
	case "data-api:request":
		request := obj(argument(args, 0))
		method := text(request["method"])
		var result any
		var err error
		operation := func(s *server) error {
			result, err = s.data(method, text(request["path"]), obj(request["params"]), request["body"])
			return err
		}
		modelIDs := []string{}
		if method == "GET" {
			err = operation(s)
		} else {
			err = s.transaction(func(s *server) error {
				var before []object
				models := modelMutationPath(method, text(request["path"]))
				if models {
					before, err = s.store.list("models")
					if err != nil {
						return err
					}
				}
				if err := operation(s); err != nil {
					return err
				}
				if models {
					after, err := s.store.list("models")
					if err != nil {
						return err
					}
					modelIDs, err = modelChangedIDs(before, after)
					return err
				}
				return nil
			})
		}
		status := 200
		response := object{"id": request["id"], "status": status, "data": result}
		if err != nil {
			code := "INVALID_OPERATION"
			status = 400
			if errors.Is(err, promptConcurrentModification) {
				code = "CONCURRENT_MODIFICATION"
				status = 409
			}
			if errors.Is(err, sql.ErrNoRows) {
				code = "NOT_FOUND"
				status = 404
			}
			response["status"] = status
			response["error"] = object{"code": code, "message": err.Error(), "status": status}
		} else if method != "GET" {
			s.modelsChanged(modelIDs)
			s.mutationChanged(method, text(request["path"]), obj(request["body"]))
		}
		return response, nil, nil
	case "preference:get-all":
		result, err := s.store.preferences()
		return result, err, nil
	case "preference:get":
		result, err := s.store.preference(text(argument(args, 0)))
		return result, err, nil
	case "preference:get-multiple-raw":
		result := object{}
		for _, key := range array(argument(args, 0)) {
			value, err := s.store.preference(text(key))
			if err != nil {
				return nil, err, nil
			}
			result[text(key)] = value
		}
		return result, nil, nil
	case "preference:subscribe":
		return nil, nil, nil
	case "cache:get-all-shared":
		return clone(s.shared), nil, nil
	case "cache:sync":
		update := obj(argument(args, 0))
		key := text(update["key"])
		if update["type"] == "shared" {
			if value, ok := update["value"]; ok {
				s.shared[key] = object{"value": value, "expireAt": update["expireAt"]}
			} else {
				delete(s.shared, key)
			}
		}
		s.writer.event(channel, update)
		return nil, nil, nil
	case "cache:sync-batch":
		for _, update := range array(argument(args, 0)) {
			value := obj(update)
			if value["type"] == "shared" {
				s.shared[text(value["key"])] = object{"value": value["value"]}
			}
		}
		s.writer.event(channel, argument(args, 0))
		return nil, nil, nil
	case "app:log-to-main":
		// Renderer payloads can contain provider settings. Do not log their contents.
		return nil, nil, nil
	case "system:getHostname":
		hostname, err := os.Hostname()
		return hostname, err, nil
	case "application:prevent-quit", "application:allow-quit":
		return nil, notMigrated("quit holds"), nil
	default:
		return nil, notMigrated(channel), nil
	}
}

func ipcResult(result any, err error) object {
	if err != nil {
		var coded interface{ IPCCode() string }
		if errors.As(err, &coded) {
			return object{"ok": false, "error": object{"code": coded.IPCCode(), "message": err.Error()}}
		}
		return object{"ok": false, "error": object{"code": "INTERNAL", "message": err.Error()}}
	}
	if result == nil {
		return object{"ok": true}
	}
	return object{"ok": true, "data": result}
}

func (s *server) command(route string, value any) (any, error, func()) {
	input := obj(value)
	if result, err, handled := s.trashCommand(route, input); handled {
		return result, err, nil
	}
	if result, err, handled := s.skillCommand(route, input); handled {
		return result, err, nil
	}
	if result, err, handled := s.knowledgeFileCommand(route, input); handled {
		return result, err, nil
	}
	switch route {
	case "ai.stream.open":
		return s.openGeneration(input)
	case "ai.stream.attach":
		id := text(input["topicId"])
		if generation := s.active[id]; generation != nil {
			return generation.snapshot(), nil, nil
		}
		return object{"status": "not-found"}, nil, nil
	case "ai.stream.detach":
		return nil, nil, nil
	case "navigation.protocol_dispatch_ready", "navigation.ack_open_route", "navigation.report_conversation_ownership":
		return nil, nil, nil
	case "navigation.open_route_in_main":
		s.event("navigation.open_route_requested", object{"to": input["to"]})
		return nil, nil, nil
	case "app.updater.release_notes.get":
		return nil, nil, nil
	case "app.updater.check_for_update":
		return nil, notMigrated("automatic updates"), nil
	case "app.adjust_zoom":
		return nil, notMigrated("zoom command"), nil
	case "system.get_fonts":
		return []string{"Segoe UI", "Microsoft YaHei UI", "Consolas"}, nil, nil
	case "ai.claude_code.binary.status":
		return nil, notMigrated("Claude Code runtime"), nil
	case "ai.topic.archive":
		_, err, _ := s.trashCommand("trash.topic.archive", object{"topicIds": []any{input["topicId"]}})
		return nil, err, nil
	default:
		return nil, notMigrated(route), nil
	}
}

func (s *server) newTopic(body object) (object, error) {
	now := timestamp()
	topic := object{"id": newID(), "name": "", "isNameManuallyEdited": false, "orderKey": now, "lastActivityAt": now, "createdAt": now, "updatedAt": now}
	if id := text(body["assistantId"]); id != "" {
		if _, err := s.store.get("assistants", id); err != nil {
			return nil, err
		}
		topic["assistantId"] = id
	}
	if name, ok := body["name"].(string); ok {
		topic["name"] = name
	}
	if err := s.store.put("topics", topic); err != nil {
		return nil, err
	}
	root := object{"id": newID(), "topicId": topic["id"], "parentId": nil, "role": "root", "data": object{"parts": []any{}}, "searchableText": "", "status": "success", "siblingsGroupId": 0, "createdAt": now, "updatedAt": now}
	return topic, s.store.put("messages", root)
}

func newModel(body object) object {
	modelID := text(body["modelId"])
	providerID := text(body["providerId"])
	result := object{"id": providerID + "::" + modelID, "providerId": providerID, "apiModelId": modelID, "name": modelID, "capabilities": []any{}, "inputModalities": []any{"text"}, "outputModalities": []any{"text"}, "endpointTypes": []any{"openai-chat-completions"}, "supportsStreaming": true, "isEnabled": true, "isHidden": false}
	for key, value := range body {
		if key != "modelId" && key != "id" {
			result[key] = value
		}
	}
	return result
}

func (s *server) data(method, path string, query object, body any) (any, error) {
	if path == "/archives" {
		if method != "GET" {
			return nil, notMigrated(method + " " + path)
		}
		return s.listArchives(query)
	}
	if result, err, handled := s.promptData(method, path, query, body); handled {
		return result, err
	}
	if result, err, handled := s.skillData(method, path, query, body); handled {
		return result, err
	}
	if result, err, handled := s.knowledgeData(method, path, query, obj(body)); handled {
		return result, err
	}
	segments := strings.Split(strings.Trim(path, "/"), "/")
	// The original IPC router treats model IDs as raw greedy tails, including '%'
	// literals. An encoded alias is tried once only when the exact raw ID is absent.
	// Collection and batch routes retain precedence over the scalar endpoint.
	if strings.HasPrefix(path, "/models/") && strings.TrimPrefix(path, "/models/") != "batch" {
		segments = []string{"models", strings.TrimPrefix(path, "/models/")}
	}
	for i, segment := range segments {
		if i == 1 && segments[0] == "models" {
			continue
		}
		decoded, err := url.PathUnescape(segment)
		if err != nil {
			return nil, err
		}
		segments[i] = decoded
	}
	if len(segments) == 0 {
		return nil, notMigrated(path)
	}
	resource := segments[0]
	input := obj(body)
	if (resource == "assistants" || resource == "topics") && len(segments) == 3 && segments[2] == "restore" && method == "POST" {
		return s.restoreTrash(resource, segments[1])
	}
	if method == "GET" && path == "/agent-sessions/latest" {
		return object{"session": nil}, nil
	}
	if resource == "topics" && len(segments) == 2 && segments[1] == "latest" && method == "GET" {
		topics, err := s.store.list("topics")
		if err != nil {
			return nil, err
		}
		topics = filter(topics, query)
		sort.SliceStable(topics, func(i, j int) bool { return text(topics[i]["lastActivityAt"]) > text(topics[j]["lastActivityAt"]) })
		if len(topics) == 0 {
			return object{"topic": nil}, nil
		}
		return object{"topic": topics[0]}, nil
	}
	if resource == "topics" && len(segments) == 2 && segments[1] == "reusable-placeholder" && method == "POST" {
		topics, err := s.store.list("topics")
		if err != nil {
			return nil, err
		}
		for i := len(topics) - 1; i >= 0; i-- {
			topic := topics[i]
			if topic["assistantId"] == input["assistantId"] && text(topic["name"]) == "" && topic["activeNodeId"] == nil && topic["id"] != input["excludeTopicId"] && topic["deletedAt"] == nil {
				return object{"topic": topic, "created": false}, nil
			}
		}
		topic, err := s.newTopic(input)
		return object{"topic": topic, "created": true}, err
	}
	if resource == "topics" && len(segments) >= 3 {
		topicID := segments[1]
		topic, err := s.store.get("topics", topicID)
		if err != nil {
			return nil, err
		}
		switch segments[2] {
		case "messages":
			if method == "GET" {
				return s.branchMessages(topic, query)
			}
			if s.active[topicID] != nil {
				return nil, errors.New("topic is generating")
			}
			if method == "POST" {
				return s.createMessage(topic, input)
			}
			if method == "DELETE" {
				rows, err := s.store.list("messages")
				if err != nil {
					return nil, err
				}
				ids := []string{}
				for _, row := range rows {
					if row["topicId"] == topicID && row["role"] != "root" {
						if err := s.store.delete("messages", text(row["id"])); err != nil {
							return nil, err
						}
						ids = append(ids, text(row["id"]))
					}
				}
				delete(topic, "activeNodeId")
				return object{"deletedIds": ids}, s.store.put("topics", topic)
			}
		case "tree":
			return s.messageTree(topic)
		case "active-node":
			if method != "PUT" {
				break
			}
			id := text(input["nodeId"])
			message, err := s.store.get("messages", id)
			if err != nil {
				return nil, err
			}
			if message["topicId"] != topicID {
				return nil, errors.New("node belongs to another topic")
			}
			topic["activeNodeId"] = id
			return object{"activeNodeId": id}, s.store.put("topics", topic)
		}
		return nil, notMigrated(method + " " + path)
	}
	if resource == "providers" && len(segments) >= 3 {
		provider, err := s.store.get("providers", segments[1])
		if err != nil {
			return nil, err
		}
		switch segments[2] {
		case "api-keys":
			return s.providerKeys(method, provider, segments[3:], query, input)
		case "auth-config":
			return object{"type": "api-key"}, nil
		case "preset":
			return object{"endpointConfigs": provider["endpointConfigs"], "models": []any{}}, nil
		case "models:resolve":
			result := []object{}
			for _, id := range array(query["ids"]) {
				result = append(result, newModel(object{"providerId": segments[1], "modelId": id}))
			}
			return result, nil
		case "models:reconcile":
			if method != "POST" {
				break
			}
			for _, value := range array(input["toAdd"]) {
				model := newModel(obj(value))
				if model["providerId"] != segments[1] {
					return nil, errors.New("model provider mismatch")
				}
				if err := s.store.put("models", model); err != nil {
					return nil, err
				}
			}
			for _, id := range array(input["toRemove"]) {
				if !strings.HasPrefix(text(id), segments[1]+"::") {
					return nil, errors.New("model provider mismatch")
				}
				if err := s.deleteEntity("models", text(id)); err != nil {
					return nil, err
				}
			}
			rows, err := s.store.list("models")
			return filter(rows, object{"providerId": segments[1]}), err
		}
		return nil, notMigrated(method + " " + path)
	}
	if resource == "tags" && len(segments) > 1 && segments[1] == "entities" && method == "GET" {
		return []any{}, nil
	}
	allowed := map[string]bool{"providers": true, "models": true, "assistants": true, "topics": true, "messages": true, "groups": true, "pins": true, "tags": true}
	// Read-only empty collections let the original launcher render the new, empty profile.
	if method == "GET" && !allowed[resource] && len(segments) == 1 {
		switch resource {
		case "agents", "agent-sessions", "knowledges", "prompts", "jobs":
			return object{"items": []any{}, "total": 0, "page": 1}, nil
		case "mcp-servers", "skills", "mini-apps", "agent-workspaces":
			return []any{}, nil
		}
	}
	if !allowed[resource] {
		return nil, notMigrated(method + " " + path)
	}
	if len(segments) == 1 {
		switch method {
		case "GET":
			rows, err := s.store.list(resource)
			if err != nil {
				return nil, err
			}
			rows = filter(rows, query)
			if resource == "providers" || resource == "models" || resource == "groups" || resource == "pins" || resource == "tags" {
				return rows, nil
			}
			if resource == "assistants" {
				page := number(query["page"], 1)
				limit := number(query["limit"], 50)
				start := min(len(rows), (page-1)*limit)
				end := min(len(rows), start+limit)
				return object{"items": rows[start:end], "total": len(rows), "page": page}, nil
			}
			return paginate(rows, query), nil
		case "POST":
			if resource == "models" {
				result := []object{}
				items, ok := body.([]any)
				if !ok || len(items) == 0 || len(items) > 500 {
					return nil, errors.New("models must be a non-empty array, maximum 500")
				}
				for _, value := range items {
					dto := obj(value)
					if text(dto["modelId"]) == "" || text(dto["providerId"]) == "" {
						return nil, errors.New("model identity missing")
					}
					if _, err := s.store.get("providers", text(dto["providerId"])); err != nil {
						return nil, err
					}
					model := newModel(dto)
					if _, err := s.store.get("models", text(model["id"])); !errors.Is(err, sql.ErrNoRows) {
						return nil, errors.New("duplicate model")
					}
					if err := s.store.put("models", model); err != nil {
						return nil, err
					}
					result = append(result, model)
				}
				return result, nil
			}
			if resource == "topics" {
				return s.newTopic(input)
			}
			row := object{"id": newID(), "createdAt": timestamp(), "updatedAt": timestamp(), "orderKey": timestamp()}
			switch resource {
			case "providers":
				id := text(input["providerId"])
				if id == "" || text(input["name"]) == "" {
					return nil, errors.New("provider id and name required")
				}
				if _, err := s.store.get(resource, id); !errors.Is(err, sql.ErrNoRows) {
					return nil, errors.New("duplicate provider")
				}
				row = object{"id": id, "name": input["name"], "apiKeys": []any{}, "authType": "api-key", "reportsActualCost": false, "settings": object{}, "isEnabled": true, "defaultChatEndpoint": "openai-chat-completions"}
				for _, key := range []string{"presetProviderId", "endpointConfigs", "defaultChatEndpoint"} {
					if value, ok := input[key]; ok {
						row[key] = value
					}
				}
				if keys := array(input["apiKeys"]); len(keys) > 0 {
					if _, err := s.providerKeys("PUT", row, nil, object{}, object{"keys": keys}); err != nil {
						return nil, err
					}
				}
			case "assistants":
				if text(input["name"]) == "" {
					return nil, errors.New("assistant name required")
				}
				merge(row, object{"name": input["name"], "prompt": "", "emoji": "🍒", "description": "", "modelId": nil, "modelName": nil, "groupId": nil, "settings": clone(s.store.defaults.AssistantSettings), "mcpServerIds": []any{}, "knowledgeBaseIds": []any{}})
				for _, key := range []string{"prompt", "emoji", "description", "modelId", "groupId", "mcpServerIds", "knowledgeBaseIds"} {
					if value, ok := input[key]; ok {
						row[key] = value
					}
				}
				row["settings"] = merge(obj(row["settings"]), obj(input["settings"]))
			case "groups", "pins", "tags":
				merge(row, input)
				row["id"] = newID()
			default:
				return nil, notMigrated(method + " " + path)
			}
			return row, s.store.put(resource, row)
		case "PATCH":
			if resource != "models" {
				return nil, notMigrated(path)
			}
			result := []object{}
			for _, item := range array(body) {
				update := obj(item)
				row, err := s.store.get("models", text(update["uniqueModelId"]))
				if err != nil {
					return nil, err
				}
				if err := patchModel(row, obj(update["patch"])); err != nil {
					return nil, err
				}
				if err := s.store.put("models", row); err != nil {
					return nil, err
				}
				result = append(result, row)
			}
			return result, nil
		}
	}
	if len(segments) != 2 {
		return nil, notMigrated(method + " " + path)
	}
	id := segments[1]
	row, err := s.store.get(resource, id)
	if resource == "models" && errors.Is(err, sql.ErrNoRows) {
		if decoded, decodeErr := url.PathUnescape(id); decodeErr == nil && decoded != id {
			row, err = s.store.get(resource, decoded)
			id = decoded
		}
	}
	if err != nil {
		return nil, err
	}
	switch method {
	case "GET":
		return row, nil
	case "PATCH":
		if s.active[id] != nil {
			return nil, errors.New("topic is generating")
		}
		if _, ok := input["id"]; ok {
			return nil, errors.New("identity is immutable")
		}
		switch resource {
		case "providers":
			for _, key := range []string{"name", "isEnabled", "endpointConfigs", "defaultChatEndpoint"} {
				if value, ok := input[key]; ok {
					row[key] = value
				}
			}
			if settings, ok := input["providerSettings"]; ok {
				row["settings"], err = mergeProviderSettings(obj(row["settings"]), obj(settings))
				if err != nil {
					return nil, err
				}
			}
		case "assistants":
			for _, key := range []string{"name", "prompt", "emoji", "description", "modelId", "groupId", "mcpServerIds", "knowledgeBaseIds"} {
				if value, ok := input[key]; ok {
					row[key] = value
				}
			}
			if settings, ok := input["settings"]; ok {
				row["settings"] = merge(obj(row["settings"]), obj(settings))
			}
		case "models":
			if err := patchModel(row, input); err != nil {
				return nil, err
			}
		case "topics":
			for _, key := range []string{"name", "assistantId", "isNameManuallyEdited"} {
				if value, ok := input[key]; ok {
					row[key] = value
				}
			}
		default:
			return nil, notMigrated(method + " " + path)
		}
		row["updatedAt"] = timestamp()
		return row, s.store.put(resource, row)
	case "DELETE":
		if resource == "topics" && s.active[id] != nil {
			return nil, errors.New("stop generation before deleting topic")
		}
		if resource == "messages" {
			return s.removeContextBoundary(row, query)
		}
		if resource == "topics" || resource == "assistants" {
			if query["permanent"] != true {
				return nil, errors.New("archive active conversations with the Trash lifecycle command")
			}
			if resource == "topics" {
				_, err := s.trashTopics([]string{id}, true, true)
				return nil, err
			}
			return s.trashAssistant(id, false, true, true)
		}
		return nil, s.deleteEntity(resource, id)
	}
	return nil, notMigrated(method + " " + path)
}

func (s *server) providerKeys(method string, provider object, path []string, query, input object) (any, error) {
	providerID := text(provider["id"])
	if strings.Contains(providerID, ":") {
		return nil, errors.New("provider identity must not contain a colon")
	}
	keys := array(provider["apiKeys"])
	if method == "GET" {
		result := []object{}
		for _, value := range keys {
			key := clone(obj(value))
			if query["enabled"] == true && key["isEnabled"] != true {
				continue
			}
			secret, err := s.store.secret(providerID + ":" + text(key["id"]))
			if err != nil {
				return nil, err
			}
			key["key"] = secret
			result = append(result, key)
		}
		return object{"keys": result}, nil
	}
	if len(path) > 0 {
		if method != "PATCH" && method != "DELETE" {
			return nil, notMigrated("provider credentials " + method)
		}
		result := []any{}
		var updated object
		found := false
		for _, value := range keys {
			key := obj(value)
			if key["id"] != path[0] {
				result = append(result, key)
				continue
			}
			found = true
			if method == "DELETE" {
				if _, err := s.store.connection().Exec("DELETE FROM secret WHERE id=?", providerID+":"+path[0]); err != nil {
					return nil, err
				}
				continue
			}
			for _, field := range []string{"label", "isEnabled"} {
				if value, ok := input[field]; ok {
					key[field] = value
				}
			}
			if plain, ok := input["key"].(string); ok {
				if strings.TrimSpace(plain) == "" {
					return nil, errors.New("API key must not be empty")
				}
				if err := s.store.setSecret(providerID+":"+path[0], strings.TrimSpace(plain)); err != nil {
					return nil, err
				}
			}
			result = append(result, key)
			updated = key
		}
		if !found {
			return nil, sql.ErrNoRows
		}
		provider["apiKeys"] = result
		return updated, s.store.put("providers", provider)
	}
	if method == "POST" || method == "PUT" {
		oldKeys := keys
		seen := map[string]bool{}
		if method == "POST" {
			for _, value := range keys {
				seen[text(obj(value)["id"])] = true
			}
		}
		items := []any{input}
		if method == "PUT" {
			items = array(input["keys"])
			keys = []any{}
		}
		added := []object{}
		for _, value := range items {
			item := obj(value)
			plain := strings.TrimSpace(text(item["key"]))
			if plain == "" {
				return nil, errors.New("API key must not be empty")
			}
			id := text(item["id"])
			if id == "" {
				id = newID()
			}
			if strings.Contains(id, ":") || seen[id] {
				return nil, errors.New("API key identity is invalid or duplicated")
			}
			seen[id] = true
			key := object{"id": id, "isEnabled": true}
			if label, ok := item["label"]; ok {
				key["label"] = label
			}
			if enabled, ok := item["isEnabled"].(bool); ok {
				key["isEnabled"] = enabled
			}
			if err := s.store.setSecret(providerID+":"+id, plain); err != nil {
				return nil, err
			}
			keys = append(keys, key)
			added = append(added, key)
		}
		if method == "PUT" {
			for _, value := range oldKeys {
				id := text(obj(value)["id"])
				if !seen[id] {
					if _, err := s.store.connection().Exec("DELETE FROM secret WHERE id=?", providerID+":"+id); err != nil {
						return nil, err
					}
				}
			}
		}
		provider["apiKeys"] = keys
		err := s.store.put("providers", provider)
		if method == "POST" && len(added) > 0 {
			return added[0], err
		}
		return added, err
	}
	return nil, notMigrated("provider credentials " + method)
}

func patchModel(row, patch object) error {
	for _, key := range []string{"id", "providerId", "apiModelId", "modelId"} {
		if _, ok := patch[key]; ok {
			return errors.New("model identity is immutable")
		}
	}
	for _, key := range []string{"name", "group", "capabilities", "inputModalities", "outputModalities", "endpointTypes", "supportsStreaming", "isEnabled", "isHidden", "contextWindow", "maxOutputTokens"} {
		if value, ok := patch[key]; ok {
			row[key] = value
		}
	}
	return nil
}

// Called by the serialized Data API write transaction. History is retained unless
// the user explicitly deletes its topic; message snapshots keep their original names.
func (s *server) deleteEntity(resource, id string) error {
	_, err := s.store.get(resource, id)
	if err != nil {
		return err
	}
	modelIDs := map[string]bool{}
	if resource == "models" {
		modelIDs[id] = true
	}
	if resource == "providers" {
		models, err := s.store.list("models")
		if err != nil {
			return err
		}
		for _, model := range models {
			if model["providerId"] == id {
				modelIDs[text(model["id"])] = true
			}
		}
	}
	for topicID, g := range s.active {
		if (resource == "topics" && topicID == id) || modelIDs[text(g.row["modelId"])] {
			return errors.New("stop generation before deleting this resource")
		}
		if resource == "assistants" {
			topic, err := s.store.get("topics", topicID)
			if err != nil {
				return err
			}
			if topic["assistantId"] == id {
				return errors.New("stop generation before deleting this assistant")
			}
		}
	}
	if err := s.purgeEntityPins(resource, id); err != nil {
		return err
	}
	if resource == "groups" {
		if _, err := s.store.connection().Exec("UPDATE entity SET body=json_set(body,'$.groupId',NULL,'$.updatedAt',?) WHERE resource IN ('assistants','knowledge-bases') AND json_extract(body,'$.groupId')=?", timestamp(), id); err != nil {
			return err
		}
	}
	if len(modelIDs) > 0 {
		for _, target := range []string{"assistants", "messages"} {
			rows, err := s.store.list(target)
			if err != nil {
				return err
			}
			for _, value := range rows {
				if modelIDs[text(value["modelId"])] {
					value["modelId"] = nil
					if target == "assistants" {
						value["modelName"] = nil
					}
					if err := s.store.put(target, value); err != nil {
						return err
					}
				}
			}
		}
		preferences, err := s.store.preferences()
		if err != nil {
			return err
		}
		for key, value := range preferences {
			if strings.HasSuffix(key, "model_id") && modelIDs[text(value)] {
				if err := s.store.setPreference(key, s.store.defaults.Preferences[key]); err != nil {
					return err
				}
			}
		}
		fallbacks := []any{}
		for _, value := range array(preferences["chat.retry.fallback_model_ids"]) {
			if !modelIDs[text(value)] {
				fallbacks = append(fallbacks, value)
			}
		}
		if err := s.store.setPreference("chat.retry.fallback_model_ids", fallbacks); err != nil {
			return err
		}
		for modelID := range modelIDs {
			if err := s.purgeEntityPins("models", modelID); err != nil {
				return err
			}
			if err := s.store.delete("models", modelID); err != nil {
				return err
			}
		}
	}
	if resource == "assistants" {
		if _, err := s.store.connection().Exec("DELETE FROM entity WHERE resource='prompt-bindings' AND json_extract(body,'$.targetType')='assistant' AND json_extract(body,'$.targetId')=?", id); err != nil {
			return err
		}
		topics, err := s.store.list("topics")
		if err != nil {
			return err
		}
		for _, topic := range topics {
			if topic["assistantId"] == id {
				delete(topic, "assistantId")
				if err := s.store.put("topics", topic); err != nil {
					return err
				}
			}
		}
	}
	if resource == "topics" {
		if _, err := s.store.connection().Exec("DELETE FROM entity WHERE resource='messages' AND json_extract(body,'$.topicId')=?", id); err != nil {
			return err
		}
	}
	if resource == "providers" {
		if err := s.store.delete(resource, id); err != nil {
			return err
		}
		// Ownership follows remaining metadata, including pre-v2 IDs containing ':'.
		return s.store.pruneUnusedSecrets()
	}
	return s.store.delete(resource, id)
}

func number(value any, fallback int) int {
	if v, ok := value.(float64); ok && v > 0 {
		return min(int(v), 10000)
	}
	return fallback
}
func filter(rows []object, query object) []object {
	result := []object{}
	for _, row := range rows {
		if (row["deletedAt"] != nil) != (query["inTrash"] == true) {
			continue
		}
		matched := true
		for _, field := range []string{"providerId", "assistantId", "groupId", "id", "entityType", "entityId"} {
			if value, ok := query[field]; ok && value != row[field] {
				matched = false
			}
		}
		if enabled, ok := query["enabled"]; ok && row["isEnabled"] != enabled {
			matched = false
		}
		if ids, ok := query["ids"].([]any); ok {
			contains := false
			for _, id := range ids {
				if row["id"] == id {
					contains = true
				}
			}
			if !contains {
				matched = false
			}
		}
		search := text(query["q"])
		if search == "" {
			search = text(query["search"])
		}
		if search != "" && !strings.Contains(strings.ToLower(text(row["name"])), strings.ToLower(search)) {
			matched = false
		}
		if matched {
			result = append(result, row)
		}
	}
	sortBy := text(query["sortBy"])
	if sortBy == "" {
		sortBy = "orderKey"
	}
	descending := query["sortOrder"] == "desc"
	sort.SliceStable(result, func(i, j int) bool {
		a, b := text(result[i][sortBy]), text(result[j][sortBy])
		if descending {
			return a > b
		}
		return a < b
	})
	return result
}
func paginate(rows []object, query object) object {
	start := 0
	if cursor := text(query["cursor"]); cursor != "" {
		for i, row := range rows {
			if row["id"] == cursor {
				start = i + 1
				break
			}
		}
	}
	end := min(len(rows), start+number(query["limit"], 50))
	result := object{"items": rows[start:end]}
	if end < len(rows) && end > 0 {
		result["nextCursor"] = rows[end-1]["id"]
	}
	return result
}
