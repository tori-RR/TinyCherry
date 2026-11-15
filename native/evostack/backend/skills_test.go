package main

import (
	"archive/zip"
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func skillRequest(t *testing.T, s *server, route string, input any) any {
	t.Helper()
	encoded, _ := json.Marshal(input)
	var wire any
	_ = json.Unmarshal(encoded, &wire)
	result, err, handled := s.skillCommand(route, wire)
	if err != nil || !handled {
		t.Fatalf("%s: handled=%v err=%v", route, handled, err)
	}
	return result
}

func TestSkillSyncDoesNotEscapeFailedMutationTransaction(t *testing.T) {
	s, _ := testServer(t)
	response := dataResponse(t, s, "PATCH", "/skills/builtin:missing", object{"isGlobalEnabled": true})
	if response["error"] == nil {
		t.Fatal("missing skill mutation unexpectedly succeeded")
	}
	if s.skills != nil && s.skills.synced {
		t.Fatal("rolled-back synchronization was cached as committed")
	}
	rows, err := s.store.list("skills")
	if err != nil || len(rows) != 0 {
		t.Fatalf("seed transaction did not roll back: %d %v", len(rows), err)
	}
	catalog := skillRequest(t, s, "skill.list_catalog", object{}).([]object)
	rows, err = s.store.list("skills")
	if err != nil || len(catalog) < 10 || len(rows) != len(catalog) || !s.skills.synced {
		t.Fatalf("catalog did not recover: %d/%d %v", len(catalog), len(rows), err)
	}
}
func TestSkillCatalogBundledFilesAndPersistentToggle(t *testing.T) {
	s, directory := testServer(t)
	catalog := skillRequest(t, s, "skill.list_catalog", object{}).([]object)
	if len(catalog) < 10 {
		t.Fatalf("expected real bundled catalog, got %d", len(catalog))
	}
	var selected object
	for _, row := range catalog {
		if row["scope"] != "builtin" || text(row["contentHash"]) == "" || text(row["description"]) == "" || row["isEnabled"] != false {
			t.Fatal("invalid bundled skill DTO")
		}
		if row["folderName"] == "skill-creator" {
			selected = row
		}
	}
	if selected == nil {
		t.Fatal("bundled skill-creator is missing")
	}
	id := text(selected["id"])
	resolved := obj(skillRequest(t, s, "skill.folder.resolve", object{"skillId": id}))
	if resolved["access"] != "read_only" || resolved["readOnlyReason"] != "builtin" {
		t.Fatal("bundled files must be read-only")
	}
	root := text(resolved["rootPath"])
	tree := obj(skillRequest(t, s, "file.tree.create", object{"rootPath": root}))
	if skillRequest(t, s, "file.tree.activate", object{"treeId": tree["treeId"], "revision": 0}) != true {
		t.Fatal("tree did not activate")
	}
	if obj(obj(tree["snapshot"])["children"])["SKILL.md"] == nil {
		t.Fatal("skill markdown missing from tree")
	}
	file := filepath.Join(root, "SKILL.md")
	modified := time.Unix(1700000000, 123456700)
	if err := os.Chtimes(file, modified, modified); err != nil {
		t.Fatal(err)
	}
	metadata := obj(skillRequest(t, s, "file.get_metadata", object{"kind": "path", "path": file}))
	if metadata["kind"] != "file" || metadata["mime"] != "text/markdown" {
		t.Fatal("metadata did not accept the original FileHandle contract")
	}
	read := obj(skillRequest(t, s, "file.read", object{"handle": object{"kind": "path", "path": file}, "options": object{"mode": "full", "encoding": "binary"}}))
	if obj(read["version"])["mtime"] != metadata["modifiedAt"] {
		t.Fatal("preview read version must match the floored metadata timestamp")
	}
	values := read["content"].([]int)
	data := make([]byte, len(values))
	for i, v := range values {
		data[i] = byte(v)
	}
	if !bytes.Contains(data, []byte("name: skill-creator")) {
		t.Fatal("actual bundled content not returned")
	}
	edit := obj(skillRequest(t, s, "file.edit.open", object{"handle": object{"kind": "path", "path": file}}))
	snapshot := obj(skillRequest(t, s, "file.edit.read", object{"editId": edit["editId"]}))
	_, err, handled := s.skillCommand("file.edit.write", object{"editId": edit["editId"], "expected": snapshot["baseline"], "data": []any{65.0}})
	if !handled || err == nil {
		t.Fatal("bundled write was allowed")
	}
	if err := s.transaction(func(s *server) error {
		_, err, handled := s.skillData("PATCH", "/skills/"+id, object{}, object{"isGlobalEnabled": false})
		if !handled {
			t.Fatal("skill data route not handled")
		}
		return err
	}); err != nil {
		t.Fatal(err)
	}
	s.store.db.Close()
	reopened, err := openStore(directory)
	if err != nil {
		t.Fatal(err)
	}
	defer reopened.db.Close()
	s.store = reopened
	s.skills = nil
	rows := skillRequest(t, s, "skill.list_catalog", object{"search": "skill-creator"}).([]object)
	if len(rows) != 1 || rows[0]["isGlobalEnabled"] != false {
		t.Fatal("global enablement was reset on reopen")
	}
	if _, err, handled := s.skillCommand("skill.folder.resolve", object{"skillId": "missing"}); !handled || err == nil {
		t.Fatal("missing skill was accepted")
	}
}

func writeSkillFixture(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "SKILL.md"), []byte("---\nname: fixture-local\ndescription: |\n  本地技能\n  retained description\nversion: 1.2\n---\n\n# Original\n"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(directory, "notes.md"), []byte("notes\n"), 0600); err != nil {
		t.Fatal(err)
	}
	return directory
}
func TestSkillLocalImportEditConflictAndUninstallPreserveSource(t *testing.T) {
	s, _ := testServer(t)
	source := writeSkillFixture(t)
	result := obj(skillRequest(t, s, "skill.install_from_directory", object{"directoryPath": source}))
	if result["success"] != true {
		t.Fatalf("import failed: %v", result["error"])
	}
	row := obj(result["data"])
	if row["source"] != "directory" || !strings.Contains(text(row["description"]), "本地技能") {
		t.Fatal("frontmatter not parsed")
	}
	if row["version"] != "1.2" {
		t.Fatal("numeric frontmatter version was not normalized to the string DTO")
	}
	folder := obj(skillRequest(t, s, "skill.folder.resolve", object{"skillId": row["id"]}))
	if folder["access"] != "read_write" {
		t.Fatal("local copy should be editable")
	}
	file := filepath.Join(text(folder["rootPath"]), "notes.md")
	edit := obj(skillRequest(t, s, "file.edit.open", object{"handle": object{"kind": "path", "path": file}}))
	read := obj(skillRequest(t, s, "file.edit.read", object{"editId": edit["editId"]}))
	for _, invalidData := range []any{nil, "invalid", []any{true}, []any{"65"}, []any{256.0}, []any{1.5}} {
		if _, err, handled := s.skillCommand("file.edit.write", object{"editId": edit["editId"], "expected": read["baseline"], "data": invalidData}); !handled || err == nil {
			t.Fatal("malformed binary write was accepted")
		}
	}
	changed := []any{float64('n'), float64('e'), float64('w'), float64('\n')}
	write := obj(skillRequest(t, s, "file.edit.write", object{"editId": edit["editId"], "expected": read["baseline"], "data": changed}))
	if write["metadataRecoveryPending"] != false {
		t.Fatal("unexpected metadata state")
	}
	if data, _ := os.ReadFile(file); string(data) != "new\n" {
		t.Fatal("file was not written")
	}
	if err := os.WriteFile(file, []byte("external\n"), 0600); err != nil {
		t.Fatal(err)
	}
	_, err, handled := s.skillCommand("file.edit.write", object{"editId": edit["editId"], "expected": write["baseline"], "data": changed})
	if !handled || err == nil || err.(interface{ IPCCode() string }).IPCCode() != "FILE_STALE_VERSION" {
		t.Fatal("external edit was overwritten")
	}
	if data, _ := os.ReadFile(file); string(data) != "external\n" {
		t.Fatal("conflicting file changed")
	}
	result = obj(skillRequest(t, s, "skill.uninstall", object{"skillId": row["id"]}))
	if result["success"] != true {
		t.Fatal("uninstall failed")
	}
	if _, err := s.store.get("skills", text(row["id"])); err == nil {
		t.Fatal("skill metadata was not removed")
	}
	if _, err := os.Stat(filepath.Join(source, "SKILL.md")); err != nil {
		t.Fatal("user source directory was touched")
	}
	backups, err := os.ReadDir(filepath.Join(s.store.directory, "skills", "removed"))
	if err != nil || len(backups) != 1 {
		t.Fatal("uninstalled local files were not preserved")
	}
}

func TestSkillArchiveAndFileAccessRejectEscapes(t *testing.T) {
	s, _ := testServer(t)
	skillRequest(t, s, "skill.list_catalog", object{})
	outside := filepath.Join(t.TempDir(), "outside.md")
	_ = os.WriteFile(outside, []byte("private fixture"), 0600)
	if _, err, handled := s.skillCommand("file.read", object{"handle": object{"kind": "path", "path": outside}}); handled || err != nil {
		t.Fatal("skill handler claimed unrelated filesystem path")
	}
	insideUnknown := filepath.Join(s.store.directory, "skills", "unknown", "outside.md")
	if _, err, handled := s.skillCommand("file.read", object{"handle": object{"kind": "path", "path": insideUnknown}}); !handled || err == nil {
		t.Fatal("unregistered skill path was accepted")
	}
	for _, name := range []string{"../escape.txt", "/absolute.txt", "C:/absolute.txt", "skill/../../escape.txt", "skill\\escape.txt"} {
		t.Run(name, func(t *testing.T) {
			file := filepath.Join(t.TempDir(), "skill.zip")
			out, err := os.Create(file)
			if err != nil {
				t.Fatal(err)
			}
			archive := zip.NewWriter(out)
			entry, _ := archive.Create(name)
			_, _ = entry.Write([]byte("no"))
			_ = archive.Close()
			_ = out.Close()
			if _, err := collectSkillZip(file); err == nil {
				t.Fatal("unsafe archive accepted")
			}
		})
	}
	source := writeSkillFixture(t)
	if err := os.Symlink(outside, filepath.Join(source, "link.md")); err == nil {
		if _, err := collectSkillDirectory(source); err == nil {
			t.Fatal("linked source accepted")
		}
	}
	oversized := writeSkillFixture(t)
	_ = os.WriteFile(filepath.Join(oversized, "large.txt"), make([]byte, skillFileLimit+1), 0600)
	if _, err := collectSkillDirectory(oversized); err == nil {
		t.Fatal("oversized source accepted")
	}
}

func TestSkillDestinationRejectsLinkedAncestorBeforeCreatingFiles(t *testing.T) {
	profile := t.TempDir()
	outside := t.TempDir()
	if err := os.Symlink(outside, filepath.Join(profile, "skills")); err != nil {
		t.Skipf("directory symlink is not available: %v", err)
	}
	files := map[string]string{"SKILL.md": "c2FmZQ=="}
	err := writeSkillFiles(profile, filepath.Join(profile, "skills", "local", "fixture"), files)
	if err == nil {
		t.Fatal("linked skill destination was accepted")
	}
	entries, err := os.ReadDir(outside)
	if err != nil || len(entries) != 0 {
		t.Fatal("destination created files outside the profile before rejecting the link")
	}
}
