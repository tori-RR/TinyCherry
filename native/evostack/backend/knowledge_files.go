package main

import (
	"errors"
	"io"
	"math"
	"os"
	"path/filepath"
	"strings"
)

// Only snapshots owned by a live knowledge item are readable through the preview bridge.
func (s *server) knowledgeFileCommand(route string, input object) (any, error, bool) {
	if route != "file.get_metadata" && route != "file.read" {
		return nil, nil, false
	}
	handle := input
	if route == "file.read" {
		handle = obj(input["handle"])
	}
	file := text(handle["path"])
	directory := filepath.Join(s.store.directory, "knowledge")
	relative, err := filepath.Rel(directory, file)
	if err != nil || !filepath.IsAbs(file) || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return nil, nil, false
	}
	parts := strings.Split(filepath.ToSlash(relative), "/")
	if len(parts) != 3 || parts[1] != "raw" || !strings.HasSuffix(parts[2], ".md") {
		return nil, errors.New("invalid knowledge snapshot path"), true
	}
	id := strings.TrimSuffix(parts[2], ".md")
	item, err := s.store.get("knowledge-items", id)
	if err != nil || text(item["baseId"]) != parts[0] {
		return nil, errors.New("knowledge snapshot is not available"), true
	}
	canonical, err := s.checkedKnowledgePath(item)
	if err != nil || !strings.EqualFold(filepath.Clean(file), canonical) {
		return nil, errors.New("knowledge snapshot path is not authorized"), true
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err, true
	}
	defer root.Close()
	f, err := root.Open(relative)
	if err != nil {
		return nil, err, true
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err, true
	}
	if !info.Mode().IsRegular() || info.Size() > 1000000 {
		return nil, errors.New("invalid knowledge snapshot"), true
	}
	if route == "file.get_metadata" {
		return object{"kind": "file", "type": "text", "size": info.Size(), "createdAt": info.ModTime().UnixMilli(), "modifiedAt": info.ModTime().UnixMilli(), "mime": "text/markdown"}, nil, true
	}
	content, err := io.ReadAll(io.LimitReader(f, 1000001))
	if err != nil {
		return nil, err, true
	}
	if len(content) > 1000000 {
		return nil, errors.New("knowledge snapshot exceeds read limit"), true
	}
	options := obj(input["options"])
	if options["mode"] == "range" {
		from, count := skillNumber(options["offset"]), skillNumber(options["length"])
		if options["offset"] == nil || options["length"] == nil || math.IsNaN(from) || math.IsNaN(count) || from < 0 || count < 0 || from > float64(len(content)) || count > 1000000 || math.Trunc(from) != from || math.Trunc(count) != count || from+count > float64(len(content)) {
			return nil, errors.New("invalid knowledge read range"), true
		}
		start, length := int(from), int(count)
		content = content[start : start+length]
	}
	return object{"content": skillBytes(content), "version": skillVersion(info), "mime": "text/markdown"}, nil, true
}
