package main

import (
	"crypto/rand"
	"database/sql"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"time"

	_ "modernc.org/sqlite"
)

//go:embed generated/defaults.json
var defaultsJSON []byte

type object = map[string]any
type defaults struct {
	Preferences       object   `json:"preferences"`
	AssistantSettings object   `json:"assistantSettings"`
	Providers         []object `json:"providers"`
}

// This trial owns a separate schema. It never opens a Cherry/Drizzle database.
type store struct {
	directory         string
	db                *sql.DB
	tx                *sql.Tx
	defaults          defaults
	preferenceUpdates object
	afterCommit       []func()
}

type executor interface {
	Exec(string, ...any) (sql.Result, error)
	Query(string, ...any) (*sql.Rows, error)
	QueryRow(string, ...any) *sql.Row
}

func (s *store) connection() executor {
	if s.tx != nil {
		return s.tx
	}
	return s.db
}

func openStore(directory string) (*store, error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("data directory must be absolute")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		return nil, err
	}
	databasePath := filepath.ToSlash(filepath.Join(directory, "evostack.sqlite3"))
	if filepath.VolumeName(directory) != "" && !strings.HasPrefix(databasePath, "/") {
		databasePath = "/" + databasePath
	}
	databaseURL := &url.URL{Scheme: "file", Path: databasePath}
	query := databaseURL.Query()
	for _, pragma := range []string{"journal_mode(WAL)", "synchronous(NORMAL)", "foreign_keys(ON)", "busy_timeout(5000)"} {
		query.Add("_pragma", pragma)
	}
	databaseURL.RawQuery = query.Encode()
	db, err := sql.Open("sqlite", databaseURL.String())
	if err != nil {
		return nil, err
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	s := &store{db: db, directory: directory}
	fail := func(err error) (*store, error) { db.Close(); return nil, err }
	if err := json.Unmarshal(defaultsJSON, &s.defaults); err != nil {
		return fail(err)
	}
	var version int
	if err := db.QueryRow("PRAGMA user_version").Scan(&version); err != nil {
		return fail(err)
	}
	if version > 3 {
		return fail(errors.New("database version is newer than this EvoStack build"))
	}
	err = s.transaction(func(s *store) error {
		if _, err := s.connection().Exec(`CREATE TABLE IF NOT EXISTS entity (resource TEXT NOT NULL, id TEXT NOT NULL, body TEXT NOT NULL CHECK(json_valid(body)), PRIMARY KEY(resource,id));
CREATE TABLE IF NOT EXISTS preference (key TEXT PRIMARY KEY, value TEXT NOT NULL CHECK(json_valid(value)));
CREATE TABLE IF NOT EXISTS secret (id TEXT PRIMARY KEY, sealed BLOB NOT NULL);
CREATE INDEX IF NOT EXISTS entity_provider ON entity(resource,json_extract(body,'$.providerId')) WHERE resource='models';
CREATE INDEX IF NOT EXISTS entity_topic ON entity(resource,json_extract(body,'$.topicId')) WHERE resource='messages';
CREATE INDEX IF NOT EXISTS entity_knowledge_base ON entity(resource,json_extract(body,'$.baseId')) WHERE resource='knowledge-items';
CREATE INDEX IF NOT EXISTS entity_knowledge_item ON entity(resource,json_extract(body,'$.itemId')) WHERE resource='knowledge-chunks';
` + knowledgeSchema + `PRAGMA user_version = 3;`); err != nil {
			return err
		}
		if version == 0 {
			for _, provider := range s.defaults.Providers {
				encoded, _ := json.Marshal(provider)
				if _, err := s.connection().Exec("INSERT OR IGNORE INTO entity(resource,id,body) VALUES('providers',?,?)", provider["id"], string(encoded)); err != nil {
					return err
				}
			}
		}
		if version == 1 {
			return s.pruneUnusedSecrets()
		}
		return nil
	})
	if err != nil {
		return fail(err)
	}
	// Recovery changes only interruption markers. Version 1 could leave dangling
	// references; validating historical rows here would make the whole profile unreadable.
	if err := s.recoverInterruptedMessages(); err != nil {
		return fail(err)
	}
	if err := recoverKnowledgeFiles(s); err != nil {
		return fail(err)
	}
	return s, nil
}

func (s *store) recoverInterruptedMessages() error {
	return s.transaction(func(s *store) error {
		rows, err := s.connection().Query("SELECT id,json_extract(body,'$.data.parts') FROM entity WHERE resource='messages' AND json_extract(body,'$.status')='pending' AND json_type(body,'$.data.parts')='array'")
		if err != nil {
			return err
		}
		type interrupted struct{ id, parts string }
		messages := []interrupted{}
		for rows.Next() {
			var message interrupted
			if err := rows.Scan(&message.id, &message.parts); err != nil {
				rows.Close()
				return err
			}
			messages = append(messages, message)
		}
		err = rows.Err()
		rows.Close()
		if err != nil {
			return err
		}
		for _, message := range messages {
			var parts []any
			if err := json.Unmarshal([]byte(message.parts), &parts); err != nil {
				return err
			}
			if !finalizeComputerParts(parts) {
				continue
			}
			encoded, err := json.Marshal(parts)
			if err != nil {
				return err
			}
			if _, err := s.connection().Exec("UPDATE entity SET body=json_set(body,'$.data.parts',json(?)) WHERE resource='messages' AND id=?", string(encoded), message.id); err != nil {
				return err
			}
		}
		_, err = s.connection().Exec("UPDATE entity SET body=json_set(body,'$.status','error','$.updatedAt',?) WHERE resource='messages' AND json_extract(body,'$.status')='pending'", timestamp())
		return err
	})
}

func (s *store) transaction(fn func(*store) error) error {
	if s.tx != nil {
		return fn(s)
	}
	tx, err := s.db.Begin()
	if err != nil {
		return err
	}
	view := &store{directory: s.directory, db: s.db, tx: tx, defaults: s.defaults, preferenceUpdates: object{}}
	defer tx.Rollback()
	if err := fn(view); err != nil {
		return err
	}
	if err := tx.Commit(); err != nil {
		return err
	}
	for _, effect := range view.afterCommit {
		effect()
	}
	return nil
}

func (s *store) onCommit(effect func()) {
	if s.tx == nil {
		effect()
	} else {
		s.afterCommit = append(s.afterCommit, effect)
	}
}
func (s *store) get(resource, id string) (object, error) {
	var data string
	if err := s.connection().QueryRow("SELECT body FROM entity WHERE resource=? AND id=?", resource, id).Scan(&data); err != nil {
		return nil, err
	}
	result := object{}
	return result, json.Unmarshal([]byte(data), &result)
}
func (s *store) list(resource string) ([]object, error) {
	return s.entities("SELECT body FROM entity WHERE resource=? ORDER BY rowid", resource)
}

func (s *store) entities(query string, args ...any) ([]object, error) {
	rows, err := s.connection().Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	result := []object{}
	for rows.Next() {
		var encoded string
		if err := rows.Scan(&encoded); err != nil {
			return nil, err
		}
		row := object{}
		if err := json.Unmarshal([]byte(encoded), &row); err != nil {
			return nil, err
		}
		result = append(result, row)
	}
	return result, rows.Err()
}
func (s *store) put(resource string, value object) error {
	id, ok := value["id"].(string)
	if !ok || id == "" {
		return errors.New("entity identity missing")
	}
	if err := s.validateRelations(resource, value); err != nil {
		return err
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.connection().Exec("INSERT INTO entity(resource,id,body) VALUES(?,?,?) ON CONFLICT(resource,id) DO UPDATE SET body=excluded.body", resource, id, string(data))
	return err
}

// All DTO writes use this boundary; snapshots inside messages remain historical data.
func (s *store) validateRelations(resource string, value object) error {
	require := func(target, field string) error {
		if value[field] == nil {
			return nil
		}
		id, ok := value[field].(string)
		if !ok {
			return fmt.Errorf("%s reference must be a string", field)
		}
		if id == "" {
			return nil
		}
		if _, err := s.get(target, id); err != nil {
			return fmt.Errorf("invalid %s reference: %w", field, err)
		}
		return nil
	}
	switch resource {
	case "providers":
		if strings.Contains(text(value["id"]), ":") {
			return errors.New("provider identity must not contain a colon")
		}
	case "models":
		if text(value["providerId"]) == "" || text(value["apiModelId"]) == "" || text(value["id"]) != text(value["providerId"])+"::"+text(value["apiModelId"]) {
			return errors.New("model identity does not match its provider")
		}
		return require("providers", "providerId")
	case "assistants":
		if err := require("models", "modelId"); err != nil {
			return err
		}
		if value["groupId"] != nil {
			if _, ok := value["groupId"].(string); !ok {
				return errors.New("assistant group reference must be a string or null")
			}
		}
		if id := text(value["groupId"]); id != "" {
			group, err := s.get("groups", id)
			if err != nil || group["entityType"] != "assistant" {
				return errors.New("assistant group must reference an assistant group")
			}
		}
	case "groups":
		switch value["entityType"] {
		case "assistant", "topic", "model", "agent", "knowledge", "session":
		default:
			return errors.New("invalid group entity type")
		}
	case "pins":
		resources := map[string]string{"assistant": "assistants", "topic": "topics", "model": "models", "knowledge": "knowledge-bases"}
		resource, ok := resources[text(value["entityType"])]
		if !ok || text(value["entityId"]) == "" {
			return errors.New("pin target type is not available")
		}
		target, err := s.get(resource, text(value["entityId"]))
		if err != nil || target["deletedAt"] != nil {
			return errors.New("pin target is not available")
		}
	case "topics":
		if err := require("assistants", "assistantId"); err != nil {
			return err
		}
		if id := text(value["activeNodeId"]); id != "" {
			message, err := s.get("messages", id)
			if err != nil || message["topicId"] != value["id"] {
				return errors.New("active node does not belong to this topic")
			}
		}
	case "messages":
		if text(value["topicId"]) == "" {
			return errors.New("message topic is required")
		}
		if err := require("topics", "topicId"); err != nil {
			return err
		}
		if id := text(value["parentId"]); id != "" {
			parent, err := s.get("messages", id)
			if err != nil || parent["topicId"] != value["topicId"] {
				return errors.New("message parent does not belong to this topic")
			}
		}
		return require("models", "modelId")
	}
	return nil
}

// Version 1 could leave encrypted rows after replacing keys or deleting a provider.
func (s *store) pruneUnusedSecrets() error {
	providers, err := s.list("providers")
	if err != nil {
		return err
	}
	retained := map[string]bool{}
	for _, provider := range providers {
		for _, value := range array(provider["apiKeys"]) {
			retained[text(provider["id"])+":"+text(obj(value)["id"])] = true
		}
	}
	rows, err := s.connection().Query("SELECT id FROM secret")
	if err != nil {
		return err
	}
	unused := []string{}
	for rows.Next() {
		var id string
		if err := rows.Scan(&id); err != nil {
			rows.Close()
			return err
		}
		if !retained[id] {
			unused = append(unused, id)
		}
	}
	err = rows.Err()
	rows.Close()
	if err != nil {
		return err
	}
	for _, id := range unused {
		if _, err := s.connection().Exec("DELETE FROM secret WHERE id=?", id); err != nil {
			return err
		}
	}
	return nil
}
func (s *store) delete(resource, id string) error {
	_, err := s.connection().Exec("DELETE FROM entity WHERE resource=? AND id=?", resource, id)
	return err
}
func (s *store) preference(key string) (any, error) {
	var value string
	err := s.connection().QueryRow("SELECT value FROM preference WHERE key=?", key).Scan(&value)
	if errors.Is(err, sql.ErrNoRows) {
		return s.defaults.Preferences[key], nil
	}
	if err != nil {
		return nil, err
	}
	var result any
	return result, json.Unmarshal([]byte(value), &result)
}
func (s *store) setPreference(key string, value any) error {
	if _, ok := s.defaults.Preferences[key]; !ok {
		return errors.New("unknown preference key")
	}
	modelKeys := map[string]bool{"chat.default_model_id": true, "chat.context_settings.compress.model_id": true, "feature.quick_assistant.model_id": true, "feature.translate.model_id": true, "feature.paintings.default_model_id": true, "feature.openclaw.selected_model_id": true}
	if modelKeys[key] && value != nil {
		id, ok := value.(string)
		if !ok {
			return errors.New("model preference must be a string or null")
		}
		if id != "" {
			if _, err := s.get("models", id); err != nil {
				return fmt.Errorf("invalid model preference: %w", err)
			}
		}
	}
	if key == "chat.retry.fallback_model_ids" {
		ids, ok := value.([]any)
		if !ok {
			return errors.New("fallback models must be an array")
		}
		for _, value := range ids {
			id, ok := value.(string)
			if !ok {
				return errors.New("fallback model must be a string")
			}
			if _, err := s.get("models", id); err != nil {
				return fmt.Errorf("invalid fallback model: %w", err)
			}
		}
	}
	data, err := json.Marshal(value)
	if err != nil {
		return err
	}
	_, err = s.connection().Exec("INSERT INTO preference(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", key, string(data))
	if err == nil && s.tx != nil {
		s.preferenceUpdates[key] = value
	}
	return err
}
func (s *store) preferences() (object, error) {
	result := clone(s.defaults.Preferences)
	rows, err := s.connection().Query("SELECT key,value FROM preference")
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	for rows.Next() {
		var key, value string
		if err := rows.Scan(&key, &value); err != nil {
			return nil, err
		}
		var decoded any
		if err := json.Unmarshal([]byte(value), &decoded); err != nil {
			return nil, err
		}
		result[key] = decoded
	}
	return result, rows.Err()
}
func (s *store) setSecret(id, value string) error {
	sealed, err := sealSecret([]byte(value))
	if err != nil {
		return err
	}
	_, err = s.connection().Exec("INSERT INTO secret(id,sealed) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET sealed=excluded.sealed", id, sealed)
	return err
}
func (s *store) secret(id string) (string, error) {
	var sealed []byte
	if err := s.connection().QueryRow("SELECT sealed FROM secret WHERE id=?", id).Scan(&sealed); err != nil {
		return "", err
	}
	plain, err := unsealSecret(sealed)
	return string(plain), err
}

func clone(value object) object {
	encoded, _ := json.Marshal(value)
	result := object{}
	_ = json.Unmarshal(encoded, &result)
	return result
}
func timestamp() string { return time.Now().UTC().Format(time.RFC3339Nano) }
func newID() string {
	var b [16]byte
	if _, err := rand.Read(b[:]); err != nil {
		panic(err)
	}
	b[6] = (b[6] & 15) | 64
	b[8] = (b[8] & 63) | 128
	return fmt.Sprintf("%x-%x-%x-%x-%x", b[:4], b[4:6], b[6:8], b[8:10], b[10:])
}
func text(value any) string { result, _ := value.(string); return result }
func obj(value any) object {
	result, _ := value.(map[string]any)
	if result == nil {
		return object{}
	}
	return result
}
func array(value any) []any {
	result, _ := value.([]any)
	if result == nil {
		return []any{}
	}
	return result
}
func merge(target, patch object) object {
	for key, value := range patch {
		target[key] = value
	}
	return target
}
func partsText(value any) string {
	var b strings.Builder
	for _, part := range array(value) {
		p := obj(part)
		if p["type"] == "text" {
			b.WriteString(text(p["text"]))
		}
	}
	return b.String()
}
