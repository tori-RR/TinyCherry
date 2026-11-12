package main

import (
	"encoding/json"
	"sort"
	"strings"
)

func modelMutationPath(method, path string) bool {
	return path == "/models" || strings.HasPrefix(path, "/models/") ||
		(strings.HasPrefix(path, "/providers/") && (method == "DELETE" || strings.HasSuffix(path, "/models:reconcile")))
}

func encodedModels(rows []object) (map[string]string, error) {
	result := make(map[string]string, len(rows))
	for _, row := range rows {
		encoded, err := json.Marshal(row)
		if err != nil {
			return nil, err
		}
		result[text(row["id"])] = string(encoded)
	}
	return result, nil
}

func modelChangedIDs(before, after []object) ([]string, error) {
	old, err := encodedModels(before)
	if err != nil {
		return nil, err
	}
	current, err := encodedModels(after)
	if err != nil {
		return nil, err
	}
	changed := map[string]bool{}
	for id, encoded := range old {
		if current[id] != encoded {
			changed[id] = true
		}
	}
	for id, encoded := range current {
		if old[id] != encoded {
			changed[id] = true
		}
	}
	ids := make([]string, 0, len(changed))
	for id := range changed {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	return ids, nil
}

func (s *server) modelsChanged(ids []string) {
	if len(ids) == 0 {
		return
	}
	s.writer.event("data-api:data-changed", []any{
		object{"endpoint": "/models", "kind": "membership", "entityIds": ids},
		object{"endpoint": "/models/:uniqueModelId*", "entityIds": ids},
	})
}

func (s *server) mutationChanged(method, path string, body object) {
	resource := strings.Split(strings.TrimPrefix(path, "/"), "/")[0]
	resource = strings.Split(resource, ":")[0]
	var endpoints []string
	switch resource {
	case "models":
		if method == "DELETE" {
			endpoints = []string{"/assistants", "/topics/:topicId/messages", "/topics/:topicId/tree", "/pins"}
		}
	case "providers":
		endpoints = []string{"/providers"}
		if method == "DELETE" || (strings.HasSuffix(path, "/models:reconcile") && len(array(body["toRemove"])) > 0) {
			endpoints = append(endpoints, "/assistants", "/topics/:topicId/messages", "/topics/:topicId/tree", "/pins")
		}
	case "assistants":
		endpoints = []string{"/assistants", "/archives"}
		if method == "DELETE" {
			endpoints = append(endpoints, "/topics", "/pins", "/prompts", "/prompt-bindings", "/prompts/:id/bindings", "/prompt-bindings/:targetType/:targetId")
		}
	case "topics", "messages":
		endpoints = []string{"/topics"}
		if resource == "topics" {
			endpoints = append(endpoints, "/archives")
		}
		nameOnly := resource == "topics" && method == "PATCH" && len(body) == 1 && body["name"] != nil
		if !nameOnly {
			endpoints = append(endpoints, "/topics/:topicId/messages", "/topics/:topicId/tree")
		}
		if method == "DELETE" && resource == "topics" {
			endpoints = append(endpoints, "/pins")
		}
	case "groups":
		endpoints = []string{"/groups"}
		if method == "DELETE" {
			endpoints = append(endpoints, "/assistants", "/knowledge-bases", "/knowledge-bases/:id")
		}
	case "pins":
		endpoints = []string{"/pins"}
	case "prompts", "prompt-bindings":
		endpoints = []string{"/prompts", "/prompts/:id", "/prompt-bindings", "/prompts/:id/bindings", "/prompt-bindings/:targetType/:targetId"}
	case "skills":
		endpoints = []string{"/skills"}
	case "knowledge-bases", "knowledge-items":
		endpoints = []string{"/knowledge-bases", "/knowledge-bases/:id", "/knowledge-bases/:id/items", "/knowledge-items/:id"}
	default:
		endpoints = []string{path}
	}
	if len(endpoints) > 0 {
		s.changed(endpoints...)
	}
}
