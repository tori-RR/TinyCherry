package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"mime"
	"os"
	"path/filepath"
	"strings"
)

func skillBytes(data []byte) []int {
	result := make([]int, len(data))
	for i, b := range data {
		result[i] = int(b)
	}
	return result
}
func skillVersion(info os.FileInfo) object {
	return object{"mtime": info.ModTime().UnixMilli(), "size": info.Size()}
}
func skillBaseline(data []byte, info os.FileInfo) object {
	hash := sha256.Sum256(data)
	return object{"version": skillVersion(info), "contentHash": "sha256:" + hex.EncodeToString(hash[:])}
}

func (s *server) skillFileCommand(state *skillRuntime, route string, input object) (any, error, bool) {
	file := text(obj(input["handle"])["path"])
	if route == "file.get_metadata" {
		file = text(input["path"])
	}
	if route == "file.tree.create" {
		file = text(input["rootPath"])
	}
	if strings.HasPrefix(route, "file.edit.") && route != "file.edit.open" {
		var found bool
		file, found = state.edits[text(input["editId"])]
		if !found {
			return nil, nil, false
		}
		if route == "file.edit.close" {
			delete(state.edits, text(input["editId"]))
			return nil, nil, true
		}
	}
	if route == "file.tree.activate" || route == "file.tree.dispose" || route == "file.tree.rename" {
		tree, found := state.trees[text(input["treeId"])]
		if !found {
			return nil, nil, false
		}
		if route == "file.tree.dispose" {
			delete(state.trees, text(input["treeId"]))
			return nil, nil, true
		}
		if route == "file.tree.activate" {
			return skillNumber(input["revision"]) == float64(tree.revision), nil, true
		}
		return nil, notMigrated("skill file rename"), true
	}
	directory, relative, readonly, handled, err := s.skillAccess(file)
	if !handled || err != nil {
		return nil, err, handled
	}
	root, err := os.OpenRoot(directory)
	if err != nil {
		return nil, err, true
	}
	defer root.Close()
	info, err := root.Stat(relative)
	if err != nil {
		return nil, err, true
	}
	switch route {
	case "file.tree.create":
		if len(state.trees) >= 64 {
			return nil, skillError("FILE_EDIT_LIMIT", "Too many open skill trees"), true
		}
		if !info.IsDir() {
			return nil, errors.New("skill root is not a directory"), true
		}
		count := 0
		snapshot, err := skillTreeSnapshot(root, relative, file, obj(input["options"]), 0, &count)
		if err != nil {
			return nil, err, true
		}
		id := newID()
		state.trees[id] = &skillTree{root: file}
		return object{"treeId": id, "revision": 0, "snapshot": snapshot}, nil, true
	case "file.edit.open":
		if len(state.edits) >= 64 {
			return nil, skillError("FILE_EDIT_LIMIT", "Too many open skill files"), true
		}
		if info.IsDir() || info.Size() > skillFileLimit {
			return nil, skillError("FILE_EDIT_UNSUPPORTED", "Skill file is not an editable text file"), true
		}
		id := newID()
		state.edits[id] = file
		return object{"editId": id}, nil, true
	case "file.edit.close":
		delete(state.edits, text(input["editId"]))
		return nil, nil, true
	case "file.get_metadata":
		meta := object{"kind": "directory", "size": info.Size(), "createdAt": info.ModTime().UnixMilli(), "modifiedAt": info.ModTime().UnixMilli()}
		if !info.IsDir() {
			meta["kind"] = "file"
			meta["type"] = "text"
			meta["mime"] = skillMime(file)
		}
		return meta, nil, true
	case "file.read", "file.edit.read", "file.edit.write", "file.write_if_unchanged":
		if info.IsDir() || info.Size() > skillFileLimit {
			return nil, skillError("FILE_EDIT_LIMIT", "Skill file exceeds its read limit"), true
		}
		data, err := readSkillFile(root, relative)
		if err != nil || len(data) > skillFileLimit {
			return nil, skillError("FILE_EDIT_IO", "Could not read skill file"), true
		}
		baseline := skillBaseline(data, info)
		if route == "file.edit.write" || route == "file.write_if_unchanged" {
			if readonly {
				return nil, skillError("FILE_EDIT_PERMISSION", "Bundled skills are read-only"), true
			}
			expected := obj(input["expected"])
			if route == "file.write_if_unchanged" {
				expected = object{"version": input["expectedVersion"], "contentHash": input["expectedContentHash"]}
			}
			version := obj(expected["version"])
			if skillNumber(version["mtime"]) != skillNumber(obj(baseline["version"])["mtime"]) || skillNumber(version["size"]) != float64(info.Size()) || (expected["contentHash"] != nil && expected["contentHash"] != baseline["contentHash"]) {
				return nil, skillError("FILE_STALE_VERSION", "Skill file changed since it was read"), true
			}
			values, validData := input["data"].([]any)
			if !validData {
				return nil, errors.New("invalid binary file content"), true
			}
			if len(values) > skillFileLimit {
				return nil, skillError("FILE_EDIT_LIMIT", "Skill file exceeds its write limit"), true
			}
			next := make([]byte, len(values))
			for i, value := range values {
				switch value.(type) {
				case float64, int, int64, json.Number:
				default:
					return nil, errors.New("invalid binary file content"), true
				}
				n := skillNumber(value)
				if n < 0 || n > 255 || n != float64(int(n)) {
					return nil, errors.New("invalid binary file content"), true
				}
				next[i] = byte(n)
			}
			temporary := filepath.Join(filepath.Dir(relative), ".evostack-"+newID()+".tmp")
			out, err := root.OpenFile(temporary, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
			if err != nil {
				return nil, err, true
			}
			_, writeErr := out.Write(next)
			if writeErr == nil {
				writeErr = out.Sync()
			}
			closeErr := out.Close()
			if writeErr == nil {
				writeErr = closeErr
			}
			if writeErr == nil {
				writeErr = root.Rename(temporary, relative)
			}
			if writeErr != nil {
				_ = root.Remove(temporary)
				return nil, writeErr, true
			}
			updated, err := root.Stat(relative)
			if err != nil {
				return nil, err, true
			}
			baseline = skillBaseline(next, updated)
			for id, tree := range state.trees {
				rel, e := filepath.Rel(tree.root, file)
				if e == nil && rel != ".." && !strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
					tree.revision++
					s.event("file.tree.mutation", object{"treeId": id, "revision": tree.revision, "event": object{"type": "updated", "path": file, "stats": object{"mtime": updated.ModTime().UnixMilli(), "birthtime": updated.ModTime().UnixMilli()}}})
				}
			}
			if route == "file.write_if_unchanged" {
				return baseline["version"], nil, true
			}
			return object{"baseline": baseline, "metadataRecoveryPending": false}, nil, true
		}
		if route == "file.edit.read" {
			return object{"data": skillBytes(data), "baseline": baseline}, nil, true
		}
		options := obj(input["options"])
		if options["mode"] == "range" {
			start := int(skillNumber(options["offset"]))
			length := int(skillNumber(options["length"]))
			if start < 0 || length <= 0 || length > skillFileLimit || start > len(data) {
				return nil, errors.New("invalid skill file range"), true
			}
			end := min(start+length, len(data))
			data = data[start:end]
		}
		result := object{"content": skillBytes(data), "mime": skillMime(file), "version": baseline["version"]}
		if options["withContentHash"] == true {
			result["contentHash"] = baseline["contentHash"]
		}
		return result, nil, true
	}
	return nil, nil, false
}
func skillMime(file string) string {
	if strings.EqualFold(filepath.Ext(file), ".md") {
		return "text/markdown"
	}
	if value := mime.TypeByExtension(filepath.Ext(file)); value != "" {
		return value
	}
	return "text/plain"
}
func skillTreeSnapshot(root *os.Root, relative, absolute string, options object, depth int, count *int) (object, error) {
	*count = *count + 1
	if *count > skillFileCountLimit {
		return nil, errors.New("skill tree exceeds its entry limit")
	}
	info, err := root.Lstat(relative)
	if err != nil {
		return nil, err
	}
	if info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("symbolic links are not accepted in skill trees")
	}
	node := object{"kind": "file", "path": absolute, "basename": filepath.Base(absolute)}
	if options["withStats"] == true {
		node["stats"] = object{"mtime": info.ModTime().UnixMilli(), "birthtime": info.ModTime().UnixMilli()}
	}
	if !info.IsDir() {
		return node, nil
	}
	node["kind"] = "directory"
	children := object{}
	node["children"] = children
	if maxDepth, ok := options["maxDepth"]; ok && depth >= int(skillNumber(maxDepth)) {
		return node, nil
	}
	dir, err := root.Open(relative)
	if err != nil {
		return nil, err
	}
	entries, err := dir.ReadDir(-1)
	dir.Close()
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if strings.HasPrefix(entry.Name(), ".") && options["includeHidden"] != true {
			continue
		}
		if !entry.IsDir() && len(array(options["extensions"])) > 0 {
			found := false
			for _, ext := range array(options["extensions"]) {
				if strings.EqualFold(filepath.Ext(entry.Name()), text(ext)) {
					found = true
				}
			}
			if !found {
				continue
			}
		}
		child, err := skillTreeSnapshot(root, filepath.Join(relative, entry.Name()), filepath.Join(absolute, entry.Name()), options, depth+1, count)
		if err != nil {
			return nil, err
		}
		children[entry.Name()] = child
	}
	return node, nil
}

func skillNumber(value any) float64 {
	switch v := value.(type) {
	case float64:
		return v
	case int:
		return float64(v)
	case int64:
		return float64(v)
	case json.Number:
		n, _ := v.Float64()
		return n
	default:
		return 0
	}
}
