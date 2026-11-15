package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"database/sql"
	_ "embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path"
	"path/filepath"
	"sort"
	"strings"

	"go.yaml.in/yaml/v3"
)

//go:embed generated/skills.json
var bundledSkillsJSON []byte

// JSON encodes each binary byte as an integer; keep both reads and writes well
// below the 4 MiB protocol-frame cap, including envelopes and file metadata.
const skillFileLimit = 512 * 1024
const skillDirectoryLimit = 8 * 1024 * 1024
const skillFileCountLimit = 512

type bundledSkill struct {
	FolderName  string            `json:"folderName"`
	Name        string            `json:"name"`
	Description string            `json:"description"`
	Version     any               `json:"version"`
	SourceTags  []any             `json:"sourceTags"`
	ContentHash string            `json:"contentHash"`
	Files       map[string]string `json:"files"`
}
type skillTree struct {
	root     string
	revision int
}
type skillRuntime struct {
	synced bool
	trees  map[string]*skillTree
	edits  map[string]string
}
type skillIPCError struct{ code, message string }

func (e *skillIPCError) Error() string      { return e.message }
func (e *skillIPCError) IPCCode() string    { return e.code }
func skillError(code, message string) error { return &skillIPCError{code, message} }

func (s *server) skillTransaction(fn func(*server) error) error {
	return s.transaction(fn)
}
func (s *server) skillState() (*skillRuntime, error) {
	if s.skills == nil {
		s.skills = &skillRuntime{trees: map[string]*skillTree{}, edits: map[string]string{}}
	}
	if s.skills.synced {
		return s.skills, nil
	}
	var bundled []bundledSkill
	if err := json.Unmarshal(bundledSkillsJSON, &bundled); err != nil {
		return nil, err
	}
	err := s.skillTransaction(func(s *server) error {
		for _, bundle := range bundled {
			if !safeSkillName(bundle.FolderName) {
				return errors.New("invalid bundled skill folder")
			}
			id := "builtin:" + bundle.FolderName
			row, err := s.store.get("skills", id)
			if err != nil && !errors.Is(err, sql.ErrNoRows) {
				return err
			}
			if errors.Is(err, sql.ErrNoRows) {
				row = newSkillRecord(id, bundle.FolderName, "builtin")
			}
			directory := filepath.Join(s.store.directory, "skills", "builtin", bundle.FolderName)
			if err := writeSkillFiles(s.store.directory, directory, bundle.Files); err != nil {
				return err
			}
			if row["contentHash"] != bundle.ContentHash {
				merge(row, object{"name": bundle.Name, "description": bundle.Description, "version": bundle.Version, "sourceTags": bundle.SourceTags, "contentHash": bundle.ContentHash, "updatedAt": timestamp()})
				if err := s.store.put("skills", row); err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.store.onCommit(func() { s.skills.synced = true })
	return s.skills, nil
}
func newSkillRecord(id, folder, source string) object {
	return object{"id": id, "name": folder, "description": nil, "folderName": folder, "source": source, "sourceUrl": nil, "namespace": nil, "author": nil, "version": nil, "sourceTags": []any{}, "contentHash": "", "isGlobalEnabled": true, "isEnabled": false, "mirrorEnabled": false, "createdAt": timestamp(), "updatedAt": timestamp()}
}
func safeSkillName(name string) bool {
	return name != "" && name != "." && name != ".." && !strings.ContainsAny(name, "/\\:\x00") && !strings.HasSuffix(name, ".") && !strings.HasSuffix(name, " ")
}
func safeSkillRelative(name string) bool {
	return name != "" && name != "." && !strings.ContainsAny(name, "\\:\x00") && !strings.HasPrefix(name, "/") && path.Clean(name) == name && name != ".." && !strings.HasPrefix(name, "../")
}

func readSkillFile(root *os.Root, relative string) ([]byte, error) {
	file, err := root.Open(relative)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	data, err := io.ReadAll(io.LimitReader(file, skillFileLimit+1))
	if err != nil {
		return nil, err
	}
	if len(data) > skillFileLimit {
		return nil, errors.New("skill file exceeds its size limit")
	}
	return data, nil
}

// Files stay in the app-owned skill directory. Go's rooted filesystem operations
// prevent symlink/junction escapes even if a file is replaced between requests.
func writeSkillFiles(profile, directory string, files map[string]string) error {
	relative, err := filepath.Rel(profile, directory)
	if err != nil || !filepath.IsLocal(relative) {
		return errors.New("skill directory escaped its profile")
	}
	profileRoot, err := os.OpenRoot(profile)
	if err != nil {
		return err
	}
	defer profileRoot.Close()
	if err := profileRoot.MkdirAll(relative, 0700); err != nil {
		return err
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil || !strings.EqualFold(resolved, filepath.Clean(directory)) {
		return errors.New("skill directory must not contain symbolic links")
	}
	root, err := profileRoot.OpenRoot(relative)
	if err != nil {
		return err
	}
	defer root.Close()
	for name, encoded := range files {
		if !safeSkillRelative(name) {
			return errors.New("invalid skill file path")
		}
		data, err := base64.StdEncoding.DecodeString(encoded)
		if err != nil || len(data) > skillFileLimit {
			return errors.New("invalid skill file content")
		}
		rel := filepath.FromSlash(name)
		if err := root.MkdirAll(filepath.Dir(rel), 0700); err != nil {
			return err
		}
		current, err := readSkillFile(root, rel)
		if err == nil && bytes.Equal(current, data) {
			continue
		}
		if err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
		if err := root.WriteFile(rel, data, 0600); err != nil {
			return err
		}
	}
	return nil
}
func (s *server) skillDirectory(row object) (string, bool, error) {
	folder := text(row["folderName"])
	if !safeSkillName(folder) {
		return "", false, errors.New("invalid skill folder")
	}
	builtin := row["source"] == "builtin"
	bucket := "local"
	if builtin {
		bucket = "builtin"
	}
	directory := filepath.Join(s.store.directory, "skills", bucket, folder)
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil {
		return "", false, err
	}
	profile, err := filepath.EvalSymlinks(s.store.directory)
	if err != nil {
		return "", false, err
	}
	expected := filepath.Join(profile, "skills", bucket, folder)
	if !strings.EqualFold(resolved, expected) {
		return "", false, errors.New("skill directory escaped its profile")
	}
	return directory, builtin, nil
}
func (s *server) skillAccess(file string) (directory, relative string, builtin bool, handled bool, err error) {
	if !filepath.IsAbs(file) {
		return "", "", false, false, nil
	}
	base := filepath.Join(s.store.directory, "skills")
	rel, err := filepath.Rel(base, filepath.Clean(file))
	if err != nil || rel == ".." || strings.HasPrefix(rel, ".."+string(filepath.Separator)) {
		return "", "", false, false, nil
	}
	rows, err := s.store.list("skills")
	if err != nil {
		return "", "", false, true, err
	}
	for _, row := range rows {
		dir, readonly, e := s.skillDirectory(row)
		if e != nil {
			continue
		}
		r, e := filepath.Rel(dir, filepath.Clean(file))
		if e == nil && r != ".." && !strings.HasPrefix(r, ".."+string(filepath.Separator)) {
			return dir, r, readonly, true, nil
		}
	}
	return "", "", false, true, skillError("FILE_EDIT_PERMISSION", "File is outside a registered skill")
}

func (s *server) skillData(method, requestPath string, query object, body any) (any, error, bool) {
	parts := strings.Split(strings.Trim(requestPath, "/"), "/")
	if len(parts) == 0 || parts[0] != "skills" {
		return nil, nil, false
	}
	if _, err := s.skillState(); err != nil {
		return nil, err, true
	}
	if len(parts) == 1 && method == "GET" {
		rows, err := s.listSkills(text(query["search"]), false)
		return rows, err, true
	}
	if len(parts) != 2 {
		return nil, notMigrated("skill data operation"), true
	}
	row, err := s.store.get("skills", parts[1])
	if err != nil {
		return nil, err, true
	}
	if method == "GET" {
		return row, nil, true
	}
	if method == "PATCH" {
		enabled, ok := obj(body)["isGlobalEnabled"].(bool)
		if !ok {
			return nil, errors.New("isGlobalEnabled must be a boolean"), true
		}
		row["isGlobalEnabled"], row["updatedAt"] = enabled, timestamp()
		return row, s.store.put("skills", row), true
	}
	return nil, notMigrated("skill data operation"), true
}
func (s *server) listSkills(search string, catalog bool) ([]object, error) {
	rows, err := s.store.list("skills")
	if err != nil {
		return nil, err
	}
	result := []object{}
	search = strings.ToLower(strings.TrimSpace(search))
	for _, row := range rows {
		if search != "" && !strings.Contains(strings.ToLower(text(row["name"])+" "+text(row["description"])), search) {
			continue
		}
		row["isEnabled"] = false // Agent-scoped execution is not part of this host yet.
		if catalog {
			scope := "local"
			if row["source"] == "builtin" {
				scope = "builtin"
			}
			row["scope"] = scope
		}
		result = append(result, row)
	}
	sort.Slice(result, func(i, j int) bool { return text(result[i]["name"]) < text(result[j]["name"]) })
	return result, nil
}

func (s *server) skillCommand(route string, value any) (any, error, bool) {
	if !strings.HasPrefix(route, "skill.") && !strings.HasPrefix(route, "file.") {
		return nil, nil, false
	}
	state, err := s.skillState()
	if err != nil {
		return nil, err, true
	}
	input := obj(value)
	if strings.HasPrefix(route, "file.") {
		return s.skillFileCommand(state, route, input)
	}
	switch route {
	case "skill.list_catalog":
		rows, err := s.listSkills(text(input["search"]), true)
		return rows, err, true
	case "skill.folder.resolve":
		row, err := s.store.get("skills", text(input["skillId"]))
		if err != nil {
			return nil, err, true
		}
		directory, readonly, err := s.skillDirectory(row)
		if err != nil {
			return nil, err, true
		}
		if readonly {
			return object{"rootPath": directory, "access": "read_only", "readOnlyReason": "builtin"}, nil, true
		}
		return object{"rootPath": directory, "access": "read_write"}, nil, true
	case "skill.reconcile":
		rows, err := s.store.list("skills")
		if err != nil {
			return nil, err, true
		}
		err = s.skillTransaction(func(s *server) error {
			for _, row := range rows {
				if id := text(input["skillId"]); id != "" && row["id"] != id {
					continue
				}
				if row["source"] == "builtin" {
					continue
				}
				directory, _, err := s.skillDirectory(row)
				if err != nil {
					return err
				}
				files, err := collectSkillDirectory(directory)
				if err != nil {
					return err
				}
				if err := refreshSkillMetadata(row, files); err != nil {
					return err
				}
				if err := s.store.put("skills", row); err != nil {
					return err
				}
			}
			return nil
		})
		return nil, err, true
	case "skill.remote.check":
		if _, err := s.store.get("skills", text(input["skillId"])); err != nil {
			return nil, err, true
		}
		return object{"state": "unsupported", "reason": "not_remote"}, nil, true
	case "skill.set_mirror_enabled":
		if input["mirrorEnabled"] == true {
			return nil, notMigrated("external Agent skill projection"), true
		}
		row, err := s.store.get("skills", text(input["skillId"]))
		if err != nil {
			return nil, err, true
		}
		row["mirrorEnabled"] = false
		return row, s.skillTransaction(func(s *server) error { return s.store.put("skills", row) }), true
	case "skill.install_from_directory", "skill.install_from_zip":
		var files map[string]string
		var err error
		if route == "skill.install_from_directory" {
			files, err = collectSkillDirectory(text(input["directoryPath"]))
		} else {
			files, err = collectSkillZip(text(input["zipFilePath"]))
		}
		if err != nil {
			return object{"success": false, "error": err.Error()}, nil, true
		}
		row, err := s.importSkill(files)
		if err != nil {
			return object{"success": false, "error": err.Error()}, nil, true
		}
		return object{"success": true, "data": row}, nil, true
	case "skill.uninstall":
		err := s.uninstallSkill(text(input["skillId"]))
		if err != nil {
			return object{"success": false, "error": err.Error()}, nil, true
		}
		return object{"success": true}, nil, true
	}
	return nil, notMigrated(route), true
}

func collectSkillDirectory(directory string) (map[string]string, error) {
	if !filepath.IsAbs(directory) {
		return nil, errors.New("skill source must be an absolute directory")
	}
	resolved, err := filepath.EvalSymlinks(directory)
	if err != nil || !strings.EqualFold(resolved, filepath.Clean(directory)) {
		return nil, errors.New("skill source must not contain symbolic links")
	}
	files := map[string]string{}
	total := int64(0)
	err = filepath.WalkDir(directory, func(file string, entry os.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if entry.Type()&os.ModeSymlink != 0 {
			return errors.New("symbolic links are not accepted in skills")
		}
		if entry.IsDir() {
			if entry.Name() == ".git" || entry.Name() == "node_modules" {
				return filepath.SkipDir
			}
			return nil
		}
		rel, err := filepath.Rel(directory, file)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(rel)
		if !safeSkillRelative(name) {
			return errors.New("invalid skill file path")
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		total += info.Size()
		if info.Size() > skillFileLimit || total > skillDirectoryLimit || len(files) >= skillFileCountLimit {
			return errors.New("skill exceeds file or directory size limits")
		}
		root, err := os.OpenRoot(directory)
		if err != nil {
			return err
		}
		data, err := readSkillFile(root, rel)
		root.Close()
		if err != nil || len(data) > skillFileLimit {
			return errors.New("skill file could not be read within its limit")
		}
		files[name] = base64.StdEncoding.EncodeToString(data)
		return nil
	})
	return files, err
}
func collectSkillZip(file string) (map[string]string, error) {
	if !filepath.IsAbs(file) {
		return nil, errors.New("skill archive must be an absolute path")
	}
	archive, err := zip.OpenReader(file)
	if err != nil {
		return nil, err
	}
	defer archive.Close()
	files := map[string]string{}
	total := 0
	for _, entry := range archive.File {
		if entry.FileInfo().IsDir() {
			continue
		}
		if !safeSkillRelative(entry.Name) || entry.Mode()&os.ModeSymlink != 0 || entry.UncompressedSize64 > skillFileLimit || len(files) >= skillFileCountLimit {
			return nil, errors.New("unsafe skill archive entry")
		}
		if _, exists := files[entry.Name]; exists {
			return nil, errors.New("duplicate skill archive entry")
		}
		reader, err := entry.Open()
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(reader, skillFileLimit+1))
		reader.Close()
		total += len(data)
		if err != nil || len(data) > skillFileLimit || total > skillDirectoryLimit {
			return nil, errors.New("skill archive exceeds size limits")
		}
		files[entry.Name] = base64.StdEncoding.EncodeToString(data)
	}
	if _, ok := files["SKILL.md"]; !ok {
		prefix := ""
		for name := range files {
			if strings.HasSuffix(name, "/SKILL.md") && strings.Count(name, "/") == 1 {
				if prefix != "" {
					return nil, errors.New("archive contains multiple skills")
				}
				prefix = strings.TrimSuffix(name, "SKILL.md")
			}
		}
		if prefix != "" {
			trimmed := map[string]string{}
			for name, content := range files {
				if !strings.HasPrefix(name, prefix) {
					return nil, errors.New("archive contains files outside its skill")
				}
				trimmed[strings.TrimPrefix(name, prefix)] = content
			}
			files = trimmed
		}
	}
	return files, nil
}
func refreshSkillMetadata(row object, files map[string]string) error {
	data, err := base64.StdEncoding.DecodeString(files["SKILL.md"])
	if err != nil || len(data) == 0 {
		return errors.New("SKILL.md is required")
	}
	textData := strings.ReplaceAll(strings.TrimPrefix(string(data), "\ufeff"), "\r\n", "\n")
	if !strings.HasPrefix(textData, "---\n") {
		return errors.New("SKILL.md requires YAML frontmatter")
	}
	lines := strings.Split(textData, "\n")
	end := -1
	for index := 1; index < len(lines); index++ {
		if lines[index] == "---" {
			end = index
			break
		}
	}
	if end < 0 {
		return errors.New("SKILL.md frontmatter is incomplete")
	}
	var meta struct {
		Name        string   `yaml:"name"`
		Description string   `yaml:"description"`
		Version     string   `yaml:"version"`
		Author      string   `yaml:"author"`
		Tags        []string `yaml:"tags"`
	}
	if err := yaml.Unmarshal([]byte(strings.Join(lines[1:end], "\n")), &meta); err != nil {
		return errors.New("SKILL.md frontmatter is invalid")
	}
	if strings.TrimSpace(meta.Name) == "" || strings.TrimSpace(meta.Description) == "" {
		return errors.New("Skill name and description are required")
	}
	encoded, _ := json.Marshal(files)
	hash := sha256.Sum256(encoded)
	tags := []any{}
	for _, tag := range meta.Tags {
		tags = append(tags, tag)
	}
	var version, author any
	if meta.Version != "" {
		version = meta.Version
	}
	if meta.Author != "" {
		author = meta.Author
	}
	merge(row, object{"name": meta.Name, "description": meta.Description, "version": version, "author": author, "sourceTags": tags, "contentHash": "sha256:" + hex.EncodeToString(hash[:]), "updatedAt": timestamp()})
	return nil
}
func (s *server) importSkill(files map[string]string) (object, error) {
	id := newID()
	row := newSkillRecord(id, id, "directory")
	if err := refreshSkillMetadata(row, files); err != nil {
		return nil, err
	}
	directory := filepath.Join(s.store.directory, "skills", "local", id)
	if err := writeSkillFiles(s.store.directory, directory, files); err != nil {
		return nil, err
	}
	err := s.skillTransaction(func(s *server) error { return s.store.put("skills", row) })
	if err != nil {
		root, openErr := os.OpenRoot(s.store.directory)
		if openErr == nil {
			defer root.Close()
			if root.MkdirAll(filepath.Join("skills", "removed"), 0700) == nil {
				_ = root.Rename(filepath.Join("skills", "local", id), filepath.Join("skills", "removed", newID()))
			}
		}
		return nil, err
	}
	return row, nil
}
func (s *server) uninstallSkill(id string) error {
	row, err := s.store.get("skills", id)
	if err != nil {
		return err
	}
	directory, builtin, err := s.skillDirectory(row)
	if err != nil {
		return err
	}
	if builtin {
		return errors.New("bundled skills cannot be uninstalled")
	}
	root, err := os.OpenRoot(s.store.directory)
	if err != nil {
		return err
	}
	defer root.Close()
	relative, err := filepath.Rel(s.store.directory, directory)
	if err != nil || !filepath.IsLocal(relative) {
		return errors.New("skill directory escaped its profile")
	}
	backup := filepath.Join("skills", "removed", newID())
	if err := root.MkdirAll(filepath.Dir(backup), 0700); err != nil {
		return err
	}
	if err := root.Rename(relative, backup); err != nil {
		return err
	}
	if err := s.skillTransaction(func(s *server) error { return s.store.delete("skills", id) }); err != nil {
		_ = root.Rename(backup, relative)
		return err
	}
	return nil
}
