package main

import (
	"database/sql"
	"encoding/json"
	"errors"
)

func (s *server) topicRows(topicID string) ([]object, error) {
	return s.store.entities("SELECT body FROM entity WHERE resource='messages' AND json_extract(body,'$.topicId')=? ORDER BY rowid", topicID)
}
func rootID(rows []object) string {
	for _, row := range rows {
		if row["role"] == "root" {
			return text(row["id"])
		}
	}
	return ""
}
func pathTo(rows []object, nodeID string) ([]object, error) {
	byID := map[string]object{}
	for _, row := range rows {
		byID[text(row["id"])] = row
	}
	result := []object{}
	seen := map[string]bool{}
	for nodeID != "" {
		row, ok := byID[nodeID]
		if !ok {
			return nil, sql.ErrNoRows
		}
		if seen[nodeID] {
			return nil, errors.New("message tree cycle")
		}
		seen[nodeID] = true
		if row["role"] == "root" {
			break
		}
		result = append(result, row)
		nodeID = text(row["parentId"])
	}
	for left, right := 0, len(result)-1; left < right; left, right = left+1, right-1 {
		result[left], result[right] = result[right], result[left]
	}
	return result, nil
}
func (s *server) branchMessages(topic, query object) (object, error) {
	rows, err := s.topicRows(text(topic["id"]))
	if err != nil {
		return nil, err
	}
	nodeID := text(query["nodeId"])
	if nodeID == "" {
		nodeID = text(topic["activeNodeId"])
	}
	path, err := pathTo(rows, nodeID)
	if err != nil {
		return nil, err
	}
	end := len(path)
	if cursor := text(query["cursor"]); cursor != "" {
		found := false
		for i, row := range path {
			if row["id"] == cursor {
				end = i
				found = true
				break
			}
		}
		if !found {
			return nil, errors.New("cursor outside active branch")
		}
	}
	minimum := max(0, end-number(query["limit"], 50))
	start, bytes := end, 512
	for start > minimum {
		encoded, err := json.Marshal(object{"message": path[start-1]})
		if err != nil {
			return nil, err
		}
		if bytes+len(encoded)+1 > maxFrame-8192 {
			if start == end {
				return nil, errors.New("message exceeds the desktop IPC budget")
			}
			break
		}
		bytes += len(encoded) + 1
		start--
	}
	items := []object{}
	for _, row := range path[start:end] {
		items = append(items, object{"message": row})
	}
	result := object{"items": items, "activeNodeId": topic["activeNodeId"], "rootId": rootID(rows), "assistantId": topic["assistantId"]}
	if start > 0 {
		result["nextCursor"] = path[start]["id"]
	}
	return result, nil
}
func (s *server) messageTree(topic object) (object, error) {
	rows, err := s.topicRows(text(topic["id"]))
	if err != nil {
		return nil, err
	}
	parents := map[string]bool{}
	for _, row := range rows {
		parents[text(row["parentId"])] = true
	}
	nodes := []object{}
	for _, row := range rows {
		if row["role"] == "root" {
			continue
		}
		preview := []rune(partsText(obj(row["data"])["parts"]))
		if len(preview) > 50 {
			preview = preview[:50]
		}
		nodes = append(nodes, object{"id": row["id"], "parentId": row["parentId"], "role": row["role"], "preview": string(preview), "modelId": row["modelId"], "status": row["status"], "createdAt": row["createdAt"], "hasChildren": parents[text(row["id"])]})
	}
	return object{"nodes": nodes, "siblingsGroups": []any{}, "activeNodeId": topic["activeNodeId"], "rootId": rootID(rows)}, nil
}
func (s *server) createMessage(topic, input object) (object, error) {
	role := text(input["role"])
	if role != "user" && role != "assistant" && role != "system" {
		return nil, errors.New("invalid content role")
	}
	rows, err := s.topicRows(text(topic["id"]))
	if err != nil {
		return nil, err
	}
	parentID := text(input["parentId"])
	if parentID == "" {
		parentID = text(topic["activeNodeId"])
	}
	if parentID == "" {
		parentID = rootID(rows)
	}
	parent, err := s.store.get("messages", parentID)
	if err != nil {
		return nil, err
	}
	if parent["topicId"] != topic["id"] {
		return nil, errors.New("parent belongs to another topic")
	}
	status := "success"
	if role == "assistant" {
		status = "pending"
	}
	if value := text(input["status"]); value != "" {
		status = value
	}
	now := timestamp()
	row := object{"id": newID(), "topicId": topic["id"], "parentId": parentID, "role": role, "data": obj(input["data"]), "searchableText": partsText(obj(input["data"])["parts"]), "status": status, "siblingsGroupId": 0, "modelId": input["modelId"], "messageSnapshot": input["messageSnapshot"], "stats": nil, "compactionSummary": nil, "createdAt": now, "updatedAt": now}
	if err := s.store.put("messages", row); err != nil {
		return nil, err
	}
	if input["setAsActive"] != false {
		topic["activeNodeId"] = row["id"]
		topic["updatedAt"] = now
		topic["lastActivityAt"] = now
		if err := s.store.put("topics", topic); err != nil {
			return nil, err
		}
	}
	return row, nil
}
func toUIMessage(row object) object {
	metadata := object{"parentId": row["parentId"], "siblingsGroupId": row["siblingsGroupId"], "modelId": row["modelId"], "messageSnapshot": row["messageSnapshot"], "status": row["status"], "createdAt": row["createdAt"], "updatedAt": row["updatedAt"], "isActiveBranch": true}
	return object{"id": row["id"], "role": row["role"], "parts": obj(row["data"])["parts"], "metadata": metadata}
}

func (s *server) removeContextBoundary(row, query object) (object, error) {
	parts := array(obj(row["data"])["parts"])
	if row["role"] != "user" || len(parts) != 1 || obj(parts[0])["type"] != "data-clear" || query["cascade"] == true {
		return nil, notMigrated("deleting messages other than a context boundary")
	}
	topicID, id := text(row["topicId"]), text(row["id"])
	if s.active[topicID] != nil {
		return nil, errors.New("stop generation before removing a context boundary")
	}
	var children int
	if err := s.store.connection().QueryRow("SELECT count(*) FROM entity WHERE resource='messages' AND json_extract(body,'$.topicId')=? AND json_extract(body,'$.parentId')=?", topicID, id).Scan(&children); err != nil {
		return nil, err
	}
	if children != 0 {
		return nil, errors.New("a context boundary with descendants cannot be removed")
	}
	topic, err := s.store.get("topics", topicID)
	if err != nil {
		return nil, err
	}
	result := object{"deletedIds": []string{id}, "reparentedIds": []string{}}
	if topic["activeNodeId"] == id {
		parent, err := s.store.get("messages", text(row["parentId"]))
		if err != nil {
			return nil, err
		}
		if parent["topicId"] != topicID || parent["id"] == row["id"] {
			return nil, errors.New("invalid context boundary parent")
		}
		var next any = parent["id"]
		if query["activeNodeStrategy"] == "clear" || parent["role"] == "root" {
			next = nil
		}
		topic["activeNodeId"], topic["updatedAt"] = next, timestamp()
		if err := s.store.put("topics", topic); err != nil {
			return nil, err
		}
		result["newActiveNodeId"] = next
	}
	return result, s.store.delete("messages", id)
}
