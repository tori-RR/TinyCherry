package main

import (
	"os"
	"path/filepath"
	"testing"
	"time"
)

func TestKnowledgePreviewUsesManagedSnapshotAndOriginalBinaryContract(t *testing.T) {
	s, dir := testServer(t)
	result, err, _ := s.knowledgeCommand("knowledge.create_base", object{"base": object{"name": "Preview"}})
	if err != nil {
		t.Fatal(err)
	}
	base := obj(result)
	content := "知识库预览 UTF-8 text"
	if _, err, _ = s.knowledgeCommand("knowledge.import_text", object{"baseId": base["id"], "name": "preview.txt", "content": content}); err != nil {
		t.Fatal(err)
	}
	items, err := s.knowledgeItems(text(base["id"]))
	if err != nil || len(items) != 1 {
		t.Fatalf("items: %v %v", items, err)
	}
	path, err := s.checkedKnowledgePath(items[0])
	if err != nil {
		t.Fatal(err)
	}
	modified := time.Unix(1700000000, 123456700)
	if err := os.Chtimes(path, modified, modified); err != nil {
		t.Fatal(err)
	}
	result, err, handled := s.knowledgeFileCommand("file.get_metadata", object{"kind": "path", "path": path})
	if err != nil || !handled || obj(result)["kind"] != "file" || obj(result)["size"] != int64(len([]byte(content))) {
		t.Fatalf("metadata contract: %v %v", result, err)
	}
	metadata := obj(result)
	result, err, handled = s.knowledgeFileCommand("file.read", object{"handle": object{"kind": "path", "path": path}, "options": object{"mode": "range", "offset": float64(0), "length": float64(6), "encoding": "binary"}})
	if err != nil || !handled || len(obj(result)["content"].([]int)) != 6 || obj(obj(result)["version"])["size"] != int64(len([]byte(content))) {
		t.Fatalf("binary contract: %v %v", result, err)
	}
	if obj(obj(result)["version"])["mtime"] != metadata["modifiedAt"] {
		t.Fatal("preview read version must match the floored metadata timestamp")
	}
	foreign := filepath.Join(dir, "private.txt")
	if err = os.WriteFile(foreign, []byte("outside knowledge"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, _, handled = s.knowledgeFileCommand("file.get_metadata", object{"kind": "path", "path": foreign}); handled {
		t.Fatal("unmanaged file must not be exposed")
	}
	if _, err, _ = s.knowledgeCommand("knowledge.delete_items", object{"baseId": base["id"], "itemIds": []any{items[0]["id"]}}); err != nil {
		t.Fatal(err)
	}
	if _, err, _ = s.knowledgeFileCommand("file.get_metadata", object{"kind": "path", "path": path}); err == nil {
		t.Fatal("deleted material must not be readable")
	}
}
