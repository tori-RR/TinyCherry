package main

import (
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"
)

type knowledgePreparation struct {
	baseID  string
	base    string
	items   string
	sources map[string]string
	chunks  map[string][]string
}

func knowledgeSourceKey(kind string, data object) string {
	encoded, _ := json.Marshal(data)
	return fmt.Sprintf("%s:%x", kind, sha256.Sum256(encoded))
}

func knowledgeContentKey(content string) string {
	return fmt.Sprintf("%x", sha256.Sum256([]byte(content)))
}

func knowledgeFingerprint(value any) string {
	encoded, _ := json.Marshal(value)
	return fmt.Sprintf("%x", sha256.Sum256(encoded))
}

func (p *knowledgePreparation) validate(s *server) error {
	if p.baseID == "" {
		return nil
	}
	base, err := s.store.get("knowledge-bases", p.baseID)
	if err != nil {
		return err
	}
	items, err := s.knowledgeItemRefs(p.baseID)
	if err != nil {
		return err
	}
	if knowledgeFingerprint(base) != p.base || knowledgeFingerprint(items) != p.items {
		return errors.New("knowledge base changed while preparing materials; review the changes before importing again")
	}
	return nil
}

// Only immutable input snapshots cross this boundary. Network, file reads and
// chunk construction finish before a transaction or the server state lock begins.
func (s *server) prepareKnowledge(ctx context.Context, route string, input object) (*knowledgePreparation, error) {
	p := &knowledgePreparation{sources: map[string]string{}, chunks: map[string][]string{}}
	if route != "knowledge.add_items" && route != "knowledge.reindex_items" {
		return p, nil
	}
	s.mu.Lock()
	base, err := s.store.get("knowledge-bases", text(input["baseId"]))
	if err == nil {
		err = validateKnowledgeBase(base)
	}
	var items []object
	if err == nil {
		items, err = s.knowledgeItemRefs(text(base["id"]))
	}
	if err != nil {
		s.mu.Unlock()
		return nil, err
	}
	p.baseID, p.base, p.items = text(base["id"]), knowledgeFingerprint(base), knowledgeFingerprint(items)
	type source struct {
		key, kind, path string
		data            object
	}
	sources := []source{}
	hasURL := false
	if route == "knowledge.add_items" {
		inputs := array(input["items"])
		if len(inputs) == 0 || len(inputs) > 100 {
			err = errors.New("select between 1 and 100 knowledge materials")
		}
		strategy := text(input["conflictStrategy"])
		if strategy != "" && strategy != "detect" && strategy != "rename" && strategy != "replace" {
			err = errors.New("invalid knowledge conflict strategy")
		}
		seen := map[string]bool{}
		conflict := false
		for _, value := range inputs {
			item := obj(value)
			kind, data := text(item["type"]), clone(obj(item["data"]))
			name := strings.TrimSpace(text(data["source"]))
			if (kind != "note" && kind != "file" && kind != "url") || item["groupId"] != nil || name == "" || len(name) > 4096 {
				err = errors.New("select valid ungrouped text, URL or note materials")
			}
			identity := kind + "\x00" + name
			hasURL = hasURL || kind == "url"
			if seen[identity] {
				conflict = true
			}
			seen[identity] = true
			for _, old := range items {
				if old["type"] == kind && obj(old["data"])["source"] == name {
					conflict = true
				}
			}
			sources = append(sources, source{key: knowledgeSourceKey(kind, data), kind: kind, data: data})
		}
		if strategy == "detect" && conflict && err == nil {
			s.mu.Unlock()
			return p, nil
		}
	} else {
		ids := array(input["itemIds"])
		if len(ids) == 0 || len(ids) > 100 {
			err = errors.New("select between 1 and 100 knowledge materials")
		}
		for _, id := range ids {
			var item object
			item, err = s.store.get("knowledge-items", text(id))
			if err != nil {
				break
			}
			if item["baseId"] != base["id"] {
				err = errors.New("knowledge item belongs to another base")
				break
			}
			var path string
			path, err = s.checkedKnowledgePath(item)
			if err != nil {
				break
			}
			sources = append(sources, source{key: text(id), path: path})
		}
	}
	var network networkSettings
	if hasURL && err == nil {
		network, err = resolveNetworkSettings(s.store)
	}
	s.mu.Unlock()
	if err != nil {
		return nil, err
	}
	var client *http.Client
	if hasURL {
		client = s.networkClient(network)
		client.Timeout = 8 * time.Second
		client.CheckRedirect = func(_ *http.Request, _ []*http.Request) error { return http.ErrUseLastResponse }
	}
	for _, source := range sources {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		var content string
		if source.path != "" {
			raw, err := readKnowledgeTextFile(source.path)
			if err != nil {
				return nil, err
			}
			content = string(raw)
		} else {
			content, err = s.readKnowledgeSource(ctx, source.kind, source.data, client)
			if err != nil {
				return nil, err
			}
		}
		chunks, err := knowledgeSplit(base, content)
		if err != nil {
			return nil, err
		}
		p.sources[source.key] = content
		p.chunks[knowledgeContentKey(content)] = chunks
	}
	return p, nil
}
