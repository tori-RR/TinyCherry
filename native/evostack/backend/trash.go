package main

import (
	"database/sql"
	"errors"
	"sort"
	"strings"
)

type trashError struct {
	code string
	err  error
}

func (e *trashError) Error() string   { return e.err.Error() }
func (e *trashError) Unwrap() error   { return e.err }
func (e *trashError) IPCCode() string { return e.code }

func (s *server) trashTarget(resource, id string, trashed bool) (object, error) {
	row, err := s.store.get(resource, id)
	if err == nil && (row["deletedAt"] != nil) != trashed {
		err = sql.ErrNoRows
	}
	if err != nil {
		return nil, &trashError{"TRASH_TARGET_NOT_FOUND", err}
	}
	return row, nil
}

func (s *server) topicsSettled(ids []string) error {
	for _, id := range ids {
		if s.active[id] != nil {
			return &trashError{"TRASH_TOPIC_BUSY", errors.New("stop generation before changing this conversation")}
		}
	}
	return nil
}

func trashIDs(value any) ([]string, error) {
	ids := map[string]bool{}
	for _, item := range array(value) {
		id, ok := item.(string)
		if !ok || strings.TrimSpace(id) == "" {
			return nil, errors.New("non-empty topic IDs required")
		}
		ids[id] = true
	}
	if len(ids) == 0 {
		return nil, errors.New("topic IDs required")
	}
	result := make([]string, 0, len(ids))
	for id := range ids {
		result = append(result, id)
	}
	sort.Strings(result)
	return result, nil
}

func (s *server) purgeEntityPins(resource, id string) error {
	types := map[string]string{"assistants": "assistant", "topics": "topic", "models": "model", "knowledge-bases": "knowledge"}
	if kind := types[resource]; kind != "" {
		_, err := s.store.connection().Exec("DELETE FROM entity WHERE resource='pins' AND json_extract(body,'$.entityType')=? AND json_extract(body,'$.entityId')=?", kind, id)
		return err
	}
	return nil
}

// Called only inside the same transaction that owns the archive or permanent delete.
func (s *server) trashTopics(ids []string, permanent, trashed bool) (object, error) {
	if err := s.topicsSettled(ids); err != nil {
		return nil, err
	}
	rows := make([]object, 0, len(ids))
	for _, id := range ids {
		row, err := s.trashTarget("topics", id, trashed)
		if err != nil {
			return nil, err
		}
		rows = append(rows, row)
	}
	for _, row := range rows {
		id := text(row["id"])
		if permanent {
			if err := s.deleteEntity("topics", id); err != nil {
				return nil, err
			}
		} else {
			row["deletedAt"], row["updatedAt"] = timestamp(), timestamp()
			if err := s.store.put("topics", row); err != nil {
				return nil, err
			}
			if err := s.purgeEntityPins("topics", id); err != nil {
				return nil, err
			}
		}
	}
	return object{"deletedIds": ids, "deletedCount": len(ids)}, nil
}

func (s *server) assistantTopicIDs(id string, includeTrashed bool) ([]string, error) {
	rows, err := s.store.list("topics")
	if err != nil {
		return nil, err
	}
	ids := []string{}
	for _, row := range rows {
		if row["assistantId"] == id && (includeTrashed || row["deletedAt"] == nil) {
			ids = append(ids, text(row["id"]))
		}
	}
	sort.Strings(ids)
	return ids, nil
}

func (s *server) trashAssistant(id string, deleteTopics, permanent, trashed bool) (object, error) {
	row, err := s.trashTarget("assistants", id, trashed)
	if err != nil {
		return nil, err
	}
	ids, err := s.assistantTopicIDs(id, permanent)
	if err != nil {
		return nil, err
	}
	if err := s.topicsSettled(ids); err != nil {
		return nil, err
	}
	result := object{"deleted": true}
	if deleteTopics {
		// An explicit active permanent delete also removes already-trashed owned topics.
		for _, topicID := range ids {
			topic, err := s.store.get("topics", topicID)
			if err != nil {
				return nil, err
			}
			if _, err := s.trashTopics([]string{topicID}, permanent, topic["deletedAt"] != nil); err != nil {
				return nil, err
			}
		}
		result["deletedTopicIds"] = ids
	}
	if permanent {
		return result, s.deleteEntity("assistants", id)
	}
	row["deletedAt"], row["updatedAt"], row["groupId"] = timestamp(), timestamp(), nil
	if err := s.store.put("assistants", row); err != nil {
		return nil, err
	}
	if err := s.purgeEntityPins("assistants", id); err != nil {
		return nil, err
	}
	_, err = s.store.connection().Exec("DELETE FROM entity WHERE resource='prompt-bindings' AND json_extract(body,'$.targetType')='assistant' AND json_extract(body,'$.targetId')=?", id)
	return result, err
}

func (s *server) restoreTrash(resource, id string) (object, error) {
	row, err := s.trashTarget(resource, id, true)
	if err != nil {
		return nil, err
	}
	delete(row, "deletedAt")
	row["updatedAt"] = timestamp()
	return row, s.store.put(resource, row)
}

func (s *server) trashCommand(route string, input object) (any, error, bool) {
	if !strings.HasPrefix(route, "trash.") {
		return nil, nil, false
	}
	var result any
	err := s.transaction(func(s *server) error {
		var err error
		switch route {
		case "trash.topic.archive", "trash.topic.delete_permanently":
			ids, e := trashIDs(input["topicIds"])
			if e != nil {
				return e
			}
			result, err = s.trashTopics(ids, route == "trash.topic.delete_permanently", false)
		case "trash.assistant_topics.archive":
			id := text(input["assistantId"])
			if _, e := s.trashTarget("assistants", id, false); e != nil {
				return e
			}
			ids, e := s.assistantTopicIDs(id, false)
			if e != nil {
				return e
			}
			result, err = s.trashTopics(ids, false, false)
		case "trash.assistant.archive", "trash.assistant.delete_permanently":
			deleteTopics, ok := input["deleteTopics"].(bool)
			if !ok {
				return errors.New("deleteTopics must be a boolean")
			}
			result, err = s.trashAssistant(text(input["assistantId"]), deleteTopics, route == "trash.assistant.delete_permanently", false)
		case "trash.purge_now":
			count := 0
			for _, resource := range []string{"topics", "assistants"} {
				rows, e := s.store.list(resource)
				if e != nil {
					return e
				}
				for _, row := range rows {
					if row["deletedAt"] != nil {
						if e := s.deleteEntity(resource, text(row["id"])); e != nil {
							return e
						}
						count++
					}
				}
			}
			result = object{"status": "completed", "reclaimed": true, "deletedCount": count, "retainedReferencedFileCount": 0}
		default:
			err = notMigrated(route)
		}
		return err
	})
	if err == nil {
		s.changed("/assistants", "/topics", "/archives", "/pins", "/prompts", "/prompt-bindings", "/prompts/:id/bindings", "/prompt-bindings/:targetType/:targetId")
	}
	return result, err, true
}
