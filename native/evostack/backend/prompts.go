package main

import (
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"sort"
	"strings"
	"unicode/utf16"
)

var promptConcurrentModification = errors.New("prompt bindings changed; reload before making the prompt global")

// Prompt collections are arrays in the original API, unlike paginated topics.
// The caller owns the server lock and write transaction, including binding changes.
func (s *server) promptData(method, path string, query object, body any) (any, error, bool) {
	parts := strings.Split(strings.Trim(path, "/"), "/")
	if parts[0] != "prompts" && parts[0] != "prompt-bindings" {
		return nil, nil, false
	}
	for i := range parts {
		decoded, err := url.PathUnescape(parts[i])
		if err != nil {
			return nil, err, true
		}
		parts[i] = decoded
	}
	var result any
	var err error
	if parts[0] == "prompts" {
		result, err = s.promptRoute(method, parts[1:], query, body)
	} else {
		result, err = s.promptBindingRoute(method, parts[1:], body)
	}
	return result, err, true
}

func promptFields(input object, allowed ...string) error {
	for key := range input {
		found := false
		for _, candidate := range allowed {
			found = found || key == candidate
		}
		if !found {
			return fmt.Errorf("unsupported prompt field: %s", key)
		}
	}
	return nil
}

func validatePromptText(value any, title bool) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", errors.New("prompt title and content must be strings")
	}
	limit := 100000
	if title {
		text = strings.TrimSpace(text)
		limit = 256
	}
	if len(text) == 0 || len(utf16.Encode([]rune(text))) > limit {
		return "", errors.New("prompt text is empty or too long")
	}
	return text, nil
}

func promptRowsInOrder(rows []object) []object {
	sort.SliceStable(rows, func(i, j int) bool {
		a, b := text(rows[i]["orderKey"]), text(rows[j]["orderKey"])
		if a == b {
			return text(rows[i]["id"]) < text(rows[j]["id"])
		}
		return a < b
	})
	return rows
}

func (s *server) reindexPromptRows(resource string, rows []object) error {
	for i, row := range rows {
		row["orderKey"] = fmt.Sprintf("%020d", i+1)
		if err := s.store.put(resource, row); err != nil {
			return err
		}
	}
	return nil
}

func (s *server) promptList(query object) ([]object, error) {
	rows, err := s.store.list("prompts")
	if err != nil {
		return nil, err
	}
	rows = promptRowsInOrder(rows)
	result := []object{}
	search := strings.ToLower(strings.TrimSpace(text(query["search"])))
	if value, ok := query["search"]; ok && (text(value) == "" || strings.TrimSpace(text(value)) == "") {
		return nil, errors.New("prompt search must not be empty")
	}
	visibility := text(query["visibility"])
	if value, present := query["visibility"]; present && value != "global" && value != "restricted" {
		return nil, errors.New("invalid prompt visibility")
	}
	if text(query["targetType"]) != "" {
		if err := promptFields(query, "targetType", "targetId", "includeGlobal", "search"); err != nil {
			return nil, err
		}
		includeGlobal, ok := query["includeGlobal"].(bool)
		if !ok {
			return nil, errors.New("includeGlobal must be a boolean")
		}
		bindings, err := s.promptTargetBindings(text(query["targetType"]), text(query["targetId"]))
		if err != nil {
			return nil, err
		}
		for _, binding := range bindings {
			prompt, err := s.store.get("prompts", text(binding["promptId"]))
			if err != nil {
				return nil, err
			}
			if prompt["visibility"] == "restricted" && promptMatchesSearch(prompt, search) {
				result = append(result, prompt)
			}
		}
		if includeGlobal {
			for _, prompt := range rows {
				if prompt["visibility"] == "global" && promptMatchesSearch(prompt, search) {
					result = append(result, prompt)
				}
			}
		}
		return result, nil
	}
	if err := promptFields(query, "visibility", "search"); err != nil {
		return nil, err
	}
	for _, prompt := range rows {
		if (visibility == "" || prompt["visibility"] == visibility) && promptMatchesSearch(prompt, search) {
			result = append(result, prompt)
		}
	}
	return result, nil
}

func promptMatchesSearch(prompt object, search string) bool {
	return search == "" || strings.Contains(strings.ToLower(text(prompt["title"])), search) || strings.Contains(strings.ToLower(text(prompt["content"])), search)
}

func (s *server) promptRoute(method string, parts []string, query object, body any) (any, error) {
	input := obj(body)
	if len(parts) == 0 {
		switch method {
		case "GET":
			return s.promptList(query)
		case "POST":
			if err := promptFields(input, "title", "content", "visibility", "bindingTarget"); err != nil {
				return nil, err
			}
			title, err := validatePromptText(input["title"], true)
			if err != nil {
				return nil, err
			}
			content, err := validatePromptText(input["content"], false)
			if err != nil {
				return nil, err
			}
			if input["visibility"] != "global" && input["visibility"] != "restricted" {
				return nil, errors.New("invalid prompt visibility")
			}
			rows, err := s.promptList(object{})
			if err != nil {
				return nil, err
			}
			if err := s.reindexPromptRows("prompts", rows); err != nil {
				return nil, err
			}
			row := object{"id": newID(), "title": title, "content": content, "visibility": input["visibility"], "orderKey": fmt.Sprintf("%020d", len(rows)+1), "createdAt": timestamp(), "updatedAt": timestamp()}
			if err := s.store.put("prompts", row); err != nil {
				return nil, err
			}
			if target, ok := input["bindingTarget"]; ok {
				targetType, targetID, err := parsePromptTarget(target)
				if err != nil {
					return nil, err
				}
				if err := s.bindPrompt(row, targetType, targetID); err != nil {
					return nil, err
				}
			}
			return row, nil
		}
	}
	if len(parts) == 1 && parts[0] == "order:batch" && method == "PATCH" {
		rows, err := s.promptList(object{})
		if err != nil {
			return nil, err
		}
		return nil, s.reorderPromptRows("prompts", rows, body)
	}
	if len(parts) == 0 {
		return nil, notMigrated("prompt method " + method)
	}
	prompt, err := s.store.get("prompts", parts[0])
	if err != nil {
		return nil, err
	}
	if len(parts) == 1 {
		switch method {
		case "GET":
			return prompt, nil
		case "PATCH":
			return s.updatePrompt(prompt, input)
		case "DELETE":
			if err := s.deletePromptBindings(parts[0]); err != nil {
				return nil, err
			}
			return nil, s.store.delete("prompts", parts[0])
		}
	}
	if len(parts) == 2 && parts[1] == "order" && method == "PATCH" {
		rows, err := s.promptList(object{})
		if err != nil {
			return nil, err
		}
		return nil, s.reorderPromptRows("prompts", rows, object{"moves": []any{object{"id": parts[0], "anchor": input}}})
	}
	if len(parts) == 2 && parts[1] == "bindings" && method == "GET" {
		return s.promptBindingTargets(parts[0])
	}
	if len(parts) == 4 && parts[1] == "bindings" {
		if method == "PUT" {
			return nil, s.bindPrompt(prompt, parts[2], parts[3])
		}
		if method == "DELETE" {
			if prompt["visibility"] != "restricted" {
				return nil, errors.New("global prompts do not have bindings")
			}
			rows, err := s.promptTargetBindings(parts[2], parts[3])
			if err != nil {
				return nil, err
			}
			for _, row := range rows {
				if row["promptId"] == parts[0] {
					return nil, s.store.delete("prompt-bindings", text(row["id"]))
				}
			}
			return nil, nil
		}
	}
	return nil, notMigrated("prompt route " + method)
}

func (s *server) updatePrompt(prompt, input object) (object, error) {
	if err := promptFields(input, "title", "content", "visibility", "expectedBindings"); err != nil {
		return nil, err
	}
	if _, title := input["title"]; !title {
		if _, content := input["content"]; !content {
			if _, visibility := input["visibility"]; !visibility {
				return nil, errors.New("prompt patch must contain a field")
			}
		}
	}
	for _, field := range []string{"title", "content"} {
		if value, ok := input[field]; ok {
			parsed, err := validatePromptText(value, field == "title")
			if err != nil {
				return nil, err
			}
			prompt[field] = parsed
		}
	}
	if value, ok := input["visibility"]; ok && value != "global" && value != "restricted" {
		return nil, errors.New("invalid prompt visibility")
	}
	if _, ok := input["expectedBindings"]; ok && input["visibility"] != "global" {
		return nil, errors.New("expected bindings require global visibility")
	}
	expected, present := input["expectedBindings"]
	keys := []string{}
	if present {
		items, ok := expected.([]any)
		if !ok {
			return nil, errors.New("expected bindings must be an array")
		}
		for _, target := range items {
			targetType, targetID, err := parsePromptTarget(target)
			if err != nil {
				return nil, err
			}
			keys = append(keys, targetType+":"+targetID)
		}
		sort.Strings(keys)
	}
	if prompt["visibility"] == "restricted" && input["visibility"] == "global" {
		actual, err := s.promptBindingTargets(text(prompt["id"]))
		if err != nil {
			return nil, err
		}
		if !present && len(actual) > 0 {
			return nil, promptConcurrentModification
		}
		if present {
			actualKeys := []string{}
			for _, target := range actual {
				actualKeys = append(actualKeys, text(target["type"])+":"+text(target["id"]))
			}
			sort.Strings(actualKeys)
			if len(keys) != len(actualKeys) || strings.Join(keys, "\x00") != strings.Join(actualKeys, "\x00") {
				return nil, promptConcurrentModification
			}
		}
		if err := s.deletePromptBindings(text(prompt["id"])); err != nil {
			return nil, err
		}
	}
	if visibility, ok := input["visibility"]; ok {
		prompt["visibility"] = visibility
	}
	prompt["updatedAt"] = timestamp()
	return prompt, s.store.put("prompts", prompt)
}

func parsePromptTarget(value any) (string, string, error) {
	target, ok := value.(map[string]any)
	if !ok || len(target) != 2 || (target["type"] != "assistant" && target["type"] != "agent") || text(target["id"]) == "" {
		return "", "", errors.New("invalid prompt binding target")
	}
	return text(target["type"]), text(target["id"]), nil
}

func (s *server) promptTargetBindings(targetType, targetID string) ([]object, error) {
	if (targetType != "assistant" && targetType != "agent") || targetID == "" {
		return nil, errors.New("invalid prompt binding target")
	}
	rows, err := s.store.list("prompt-bindings")
	result := []object{}
	for _, row := range rows {
		if row["targetType"] == targetType && row["targetId"] == targetID {
			result = append(result, row)
		}
	}
	return promptRowsInOrder(result), err
}

func (s *server) promptBindingTargets(id string) ([]object, error) {
	rows, err := s.store.list("prompt-bindings")
	result := []object{}
	for _, row := range rows {
		if row["promptId"] == id {
			result = append(result, object{"type": row["targetType"], "id": row["targetId"]})
		}
	}
	sort.Slice(result, func(i, j int) bool {
		return text(result[i]["type"])+":"+text(result[i]["id"]) < text(result[j]["type"])+":"+text(result[j]["id"])
	})
	return result, err
}

func (s *server) bindPrompt(prompt object, targetType, targetID string) error {
	if prompt["visibility"] != "restricted" {
		return errors.New("global prompts are already available everywhere")
	}
	resource := "assistants"
	if targetType == "agent" {
		resource = "agents"
	} else if targetType != "assistant" {
		return errors.New("invalid prompt binding target")
	}
	if _, err := s.store.get(resource, targetID); err != nil {
		return err
	}
	rows, err := s.promptTargetBindings(targetType, targetID)
	if err != nil {
		return err
	}
	for _, row := range rows {
		if row["promptId"] == prompt["id"] {
			return nil
		}
	}
	if err := s.reindexPromptRows("prompt-bindings", rows); err != nil {
		return err
	}
	return s.store.put("prompt-bindings", object{"id": newID(), "promptId": prompt["id"], "targetType": targetType, "targetId": targetID, "orderKey": fmt.Sprintf("%020d", len(rows)+1)})
}

func (s *server) deletePromptBindings(id string) error {
	_, err := s.store.connection().Exec("DELETE FROM entity WHERE resource='prompt-bindings' AND json_extract(body,'$.promptId')=?", id)
	return err
}

func (s *server) promptBindingRoute(method string, parts []string, body any) (any, error) {
	if len(parts) == 0 && method == "GET" {
		rows, err := s.store.list("prompt-bindings")
		result := []object{}
		for _, row := range rows {
			result = append(result, object{"promptId": row["promptId"], "targetType": row["targetType"], "targetId": row["targetId"]})
		}
		sort.Slice(result, func(i, j int) bool {
			a, b := result[i], result[j]
			return text(a["targetType"])+":"+text(a["targetId"])+":"+text(a["promptId"]) < text(b["targetType"])+":"+text(b["targetId"])+":"+text(b["promptId"])
		})
		return result, err
	}
	if len(parts) < 2 {
		return nil, notMigrated("prompt bindings route")
	}
	rows, err := s.promptTargetBindings(parts[0], parts[1])
	if err != nil {
		return nil, err
	}
	if len(parts) == 2 && method == "GET" {
		result := []object{}
		for _, binding := range rows {
			prompt, err := s.store.get("prompts", text(binding["promptId"]))
			if err != nil {
				return nil, err
			}
			if prompt["visibility"] == "restricted" {
				result = append(result, prompt)
			}
		}
		return result, nil
	}
	if len(parts) == 3 && parts[2] == "order:batch" && method == "PATCH" {
		return nil, s.reorderPromptRows("prompt-bindings", rows, body)
	}
	if len(parts) == 4 && parts[3] == "order" && method == "PATCH" {
		return nil, s.reorderPromptRows("prompt-bindings", rows, object{"moves": []any{object{"id": parts[2], "anchor": obj(body)}}})
	}
	return nil, notMigrated("prompt bindings route " + method)
}

func (s *server) reorderPromptRows(resource string, rows []object, body any) error {
	input := obj(body)
	if err := promptFields(input, "moves"); err != nil {
		return err
	}
	moves, ok := input["moves"].([]any)
	if !ok || len(moves) == 0 {
		return errors.New("prompt moves must be a non-empty array")
	}
	idField := "id"
	if resource == "prompt-bindings" {
		idField = "promptId"
	}
	for _, value := range moves {
		move := obj(value)
		if len(move) != 2 {
			return errors.New("invalid prompt move")
		}
		id := text(move["id"])
		anchor := obj(move["anchor"])
		if len(anchor) != 1 {
			return errors.New("prompt move needs one anchor")
		}
		from := -1
		for i, row := range rows {
			if row[idField] == id {
				from = i
				break
			}
		}
		if from < 0 {
			return sql.ErrNoRows
		}
		moving := rows[from]
		next := append(append([]object{}, rows[:from]...), rows[from+1:]...)
		to := -1
		if position, ok := anchor["position"]; ok {
			switch position {
			case "first":
				to = 0
			case "last":
				to = len(next)
			default:
				return errors.New("invalid prompt move position")
			}
		} else {
			for _, key := range []string{"before", "after"} {
				anchorID := text(anchor[key])
				if anchorID == "" {
					continue
				}
				for i, row := range next {
					if row[idField] == anchorID {
						to = i
						if key == "after" {
							to++
						}
					}
				}
			}
		}
		if to < 0 {
			return errors.New("prompt anchor is missing or references itself")
		}
		rows = append(next[:to], append([]object{moving}, next[to:]...)...)
	}
	return s.reindexPromptRows(resource, rows)
}
